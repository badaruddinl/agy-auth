import { VERSION, AGY_ACCOUNT, AGY_SERVICE, REGISTRY_PATH, SNAPSHOT_SERVICE } from './constants.js';
import { detectActiveAccount } from './agy.js';
import { printAccounts, printJson } from './format.js';
import { spawnSync } from 'node:child_process';
import { readUsageFromAgy } from './usage.js';
import {
  deleteAgyCredential,
  deleteSnapshot,
  KeyringError,
  listSnapshots,
  listNativeAgyCredentials,
  readAgyCredential,
  readSnapshot,
  saveSnapshot,
  writeAgyCredential,
} from './keyring.js';
import { defaultRegistry, findAccount, readRegistry, slug, upsertAccount, writeRegistry } from './registry.js';

function help() {
  console.log(`agy-auth ${VERSION}`);
  console.log('');
  console.log('Local Google Antigravity session manager for agy CLI/App.');
  console.log('');
  console.log('Commands:');
  console.log('  status                  Show active AGY account and registry status');
  console.log('  login [--alias name]    Run AGY sign-in, then save the resulting session');
  console.log('  capture [--alias name]  Capture the currently active AGY session');
  console.log('  import [--alias name]   Alias for capture');
  console.log('  list                    List stored auth snapshots');
  console.log('  list --refresh          Refresh active quota, then list snapshots');
  console.log('  usage [--json]          Show active account quota and reset time');
  console.log('  switch <query>          Switch active AGY session by email/alias/key');
  console.log('  remove <query|--all>    Remove captured snapshots');
  console.log('  native                  List native AGY keyring entries without secrets');
  console.log('  config                  Show keyring service configuration');
  console.log('  --version, -V           Show version');
  console.log('');
  console.log('Options:');
  console.log('  --json                  Print JSON output');
  console.log('');
  console.log('Install: npm install -g @badaruddinl/agy-auth');
}

function parseAlias(args) {
  const index = args.indexOf('--alias');
  if (index < 0) return '';
  if (!args[index + 1]) throw new Error('--alias requires a value.');
  return args[index + 1];
}

function spawnAgy(options = {}) {
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', 'agy'], {
      ...options,
      windowsHide: options.stdio === 'inherit' ? false : true,
    });
  }
  return spawnSync('agy', [], options);
}

async function status(jsonMode) {
  const registry = await readRegistry();
  const email = await detectActiveAccount();
  const payload = {
    version: VERSION,
    activeAccountEmail: email,
    registryPath: REGISTRY_PATH,
    capturedAccounts: registry.accounts.length,
    activeAccountKey: registry.activeAccountKey,
    agyService: AGY_SERVICE,
    agyAccount: AGY_ACCOUNT,
    snapshotService: SNAPSHOT_SERVICE,
  };
  if (jsonMode) {
    printJson(payload);
  } else {
    console.log(`active account: ${email || '-'}`);
    console.log(`captured accounts: ${registry.accounts.length}`);
    console.log(`active account key: ${registry.activeAccountKey || '-'}`);
    console.log(`agy credential: service=${AGY_SERVICE}, account=${AGY_ACCOUNT}`);
    console.log(`registry: ${REGISTRY_PATH}`);
  }
  return email ? 0 : 1;
}

async function refreshActiveUsage() {
  const usage = await readUsageFromAgy();
  const email = usage.accountEmail || await detectActiveAccount();
  if (!email) return usage;

  const accountKey = slug(email);
  const registry = await readRegistry();
  const previous = registry.accounts.find(account => account.accountKey === accountKey);
  upsertAccount(registry, {
    accountKey,
    email,
    alias: previous?.alias || '',
    createdAt: previous?.createdAt || new Date().toISOString(),
    importedAt: previous?.importedAt || null,
    usedAt: previous?.usedAt || null,
    usage,
    usageAt: usage.capturedAt,
  });
  if (!registry.activeAccountKey) registry.activeAccountKey = accountKey;
  await writeRegistry(registry);
  return usage;
}

async function captureCurrentAccount(args) {
  const alias = parseAlias(args);
  const email = await detectActiveAccount();
  if (!email) {
    throw new Error(
      'Active AGY email was not detected. Sign in with AGY outside agy-auth, '
      + 'then run `agy-auth capture` to save the active session.',
    );
  }
  const secret = await readAgyCredential();
  const accountKey = slug(email);
  await saveSnapshot(accountKey, secret);

  const registry = await readRegistry();
  const previous = registry.accounts.find(account => account.accountKey === accountKey);
  const account = upsertAccount(registry, {
    accountKey,
    email,
    alias: alias || previous?.alias || '',
    createdAt: previous?.createdAt || new Date().toISOString(),
    importedAt: new Date().toISOString(),
    usedAt: new Date().toISOString(),
  });
  registry.activeAccountKey = accountKey;
  await writeRegistry(registry);
  return account;
}

async function captureAccount(args, jsonMode) {
  const account = await captureCurrentAccount(args);
  if (jsonMode) printJson({ ok: true, account, registryPath: REGISTRY_PATH });
  else console.log(`Captured AGY session: ${account.email}`);
  return 0;
}

async function login(args, jsonMode) {
  if (args.includes('--device-auth')) {
    const payload = {
      ok: false,
      error: '`agy-auth login --device-auth` is not supported by the installed AGY CLI.',
      fallback: 'Run `agy-auth login --alias <name>` to use the normal AGY sign-in flow.',
    };
    if (jsonMode) printJson(payload);
    else {
      console.log(payload.error);
      console.log(payload.fallback);
    }
    return 2;
  }

  let previousSecret = null;
  try {
    previousSecret = await readAgyCredential();
    await deleteAgyCredential();
  } catch (error) {
    if (!(error instanceof KeyringError)) throw error;
  }

  if (!jsonMode) console.log('Opening AGY sign-in flow. Exit AGY after sign-in so agy-auth can save the session.');
  const result = spawnAgy({ stdio: 'inherit' });
  if (result.error) {
    if (previousSecret) await writeAgyCredential(previousSecret);
    throw result.error;
  }
  if (result.status !== 0) {
    if (previousSecret) await writeAgyCredential(previousSecret);
    return result.status || 1;
  }

  try {
    return await captureAccount(args, jsonMode);
  } catch (error) {
    if (previousSecret) await writeAgyCredential(previousSecret);
    throw error;
  }
}

async function readListRegistry() {
  const registry = await readRegistry();
  const snapshots = await listSnapshots();
  const activeEmail = await detectActiveAccount();
  const snapshotKeys = new Set(snapshots.map(item => item.account));
  const accountsByKey = new Map();

  for (const account of registry.accounts) {
    accountsByKey.set(account.accountKey, {
      ...account,
      hasSnapshot: snapshotKeys.has(account.accountKey),
    });
  }

  for (const snapshot of snapshots) {
    if (!accountsByKey.has(snapshot.account)) {
      accountsByKey.set(snapshot.account, {
        accountKey: snapshot.account,
        email: snapshot.account,
        alias: '',
        hasSnapshot: true,
      });
    }
  }

  if (activeEmail) {
    const accountKey = slug(activeEmail);
    const existing = accountsByKey.get(accountKey);
    accountsByKey.set(accountKey, {
      accountKey,
      email: activeEmail,
      alias: existing?.alias || '',
      createdAt: existing?.createdAt || null,
      importedAt: existing?.importedAt || null,
      usedAt: existing?.usedAt || null,
      usage: existing?.usage || null,
      usageAt: existing?.usageAt || null,
      hasSnapshot: snapshotKeys.has(accountKey),
      isActiveCredential: true,
    });
    if (!registry.activeAccountKey) registry.activeAccountKey = accountKey;
  }

  return {
    ...registry,
    accounts: [...accountsByKey.values()].sort((a, b) => String(a.email || a.accountKey).localeCompare(String(b.email || b.accountKey))),
  };
}

async function list(jsonMode, refresh = false) {
  if (refresh) await refreshActiveUsage();
  const registry = await readListRegistry();
  if (jsonMode) printJson(registry);
  else printAccounts(registry);
  return registry.accounts.length ? 0 : 1;
}

async function usage(jsonMode) {
  const usagePayload = await refreshActiveUsage();
  if (jsonMode) {
    printJson(usagePayload);
  } else if (!usagePayload.available) {
    console.log(usagePayload.error || 'Usage tidak tersedia.');
  } else {
    console.log(`Account: ${usagePayload.accountEmail || '-'}`);
    for (const group of usagePayload.groups) {
      console.log('');
      console.log(group.name);
      console.log(`  Models : ${group.models || '-'}`);
      console.log(`  Weekly : ${group.weekly.remainingPercent ?? '?'}% remaining${group.weekly.refreshesIn ? ` - reset ${group.weekly.refreshesIn}` : ''}`);
      console.log(`  5 hour : ${group.fiveHour.remainingPercent ?? '?'}% remaining${group.fiveHour.refreshesIn ? ` - reset ${group.fiveHour.refreshesIn}` : ''}`);
    }
  }
  return usagePayload.available ? 0 : 1;
}

async function switchAccount(query, jsonMode) {
  if (!query) {
    const registry = await readListRegistry();
    if (jsonMode) {
      printJson({ ok: false, error: 'Switch query is required.', accounts: registry.accounts });
    } else {
      console.log('Switch query is required. Use an email, alias, or key from this list:');
      printAccounts(registry);
    }
    return 1;
  }
  const registry = await readListRegistry();
  const { account, matches } = findAccount(registry, query);
  if (matches.length > 1) {
    if (jsonMode) printJson({ ok: false, error: 'Query matched multiple accounts.', matches });
    else console.log('Query matched multiple accounts. Use a more specific email, alias, or key.');
    return 2;
  }
  if (!account) {
    if (jsonMode) printJson({ ok: false, error: 'No captured account matched.', query });
    else console.log('No captured account matched.');
    return 1;
  }

  const secret = await readSnapshot(account.accountKey);
  await writeAgyCredential(secret);
  account.usedAt = new Date().toISOString();
  registry.activeAccountKey = account.accountKey;
  upsertAccount(registry, account);
  await writeRegistry(registry);

  if (jsonMode) printJson({ ok: true, account, activeCredentialWritten: true });
  else {
    console.log(`Active AGY session set to: ${account.email}`);
    console.log('AGY CLI/App will load this credential as the active session.');
  }
  return 0;
}

async function remove(args, jsonMode) {
  const registry = await readRegistry();
  const targets = args[0] === '--all'
    ? registry.accounts
    : findAccount(registry, args[0]).matches;
  if (targets.length === 0) {
    if (jsonMode) printJson({ ok: false, error: 'No captured account matched.' });
    else console.log('No captured account matched.');
    return 1;
  }

  const keys = new Set(targets.map(account => account.accountKey));
  await Promise.all([...keys].map(deleteSnapshot));
  registry.accounts = registry.accounts.filter(account => !keys.has(account.accountKey));
  if (keys.has(registry.activeAccountKey)) registry.activeAccountKey = null;
  await writeRegistry(registry);

  if (jsonMode) printJson({ ok: true, removed: [...keys] });
  else console.log(`Removed ${keys.size} captured account(s).`);
  return 0;
}

async function native(jsonMode) {
  const credentials = await listNativeAgyCredentials();
  const safe = credentials.map(item => ({ account: item.account }));
  if (jsonMode) printJson({ service: AGY_SERVICE, credentials: safe });
  else {
    console.log(`AGY native service: ${AGY_SERVICE}`);
    for (const item of safe) console.log(`- ${item.account}`);
    if (safe.length === 0) console.log('- no entries found');
  }
  return safe.length ? 0 : 1;
}

function config(jsonMode) {
  const payload = {
    agyService: AGY_SERVICE,
    agyAccount: AGY_ACCOUNT,
    snapshotService: SNAPSHOT_SERVICE,
    registryPath: REGISTRY_PATH,
  };
  if (jsonMode) printJson(payload);
  else {
    console.log(`agy service: ${AGY_SERVICE}`);
    console.log(`agy account: ${AGY_ACCOUNT}`);
    console.log(`snapshot service: ${SNAPSHOT_SERVICE}`);
    console.log(`registry: ${REGISTRY_PATH}`);
  }
  return 0;
}

export async function run(argv) {
  const args = [...argv];
  const jsonMode = args.includes('--json');
  const refresh = args.includes('--refresh');
  const filtered = args.filter(arg => arg !== '--json' && arg !== '--refresh');
  const command = filtered[0] || 'help';
  const rest = filtered.slice(1);

  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return 0;
  }
  if (command === '--version' || command === '-V') {
    console.log(`agy-auth ${VERSION}`);
    return 0;
  }
  if (command === 'status') return status(jsonMode);
  if (command === 'login') return login(rest, jsonMode);
  if (command === 'capture' || command === 'import') return captureAccount(rest, jsonMode);
  if (command === 'list') return list(jsonMode, refresh);
  if (command === 'usage') return usage(jsonMode);
  if (command === 'switch') return switchAccount(rest[0], jsonMode);
  if (command === 'remove') return remove(rest, jsonMode);
  if (command === 'native') return native(jsonMode);
  if (command === 'config') return config(jsonMode);

  console.error(`Unknown command: ${command}`);
  console.error('Run `agy-auth --help`.');
  return 2;
}

export const internals = {
  defaultRegistry,
  findAccount,
  parseAlias,
  slug,
  upsertAccount,
};
