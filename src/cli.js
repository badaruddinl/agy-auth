import { VERSION, AGY_ACCOUNT, AGY_SERVICE, REGISTRY_PATH } from './constants.js';
import { detectActiveAccount } from './agy.js';
import { printAccounts, printJson } from './format.js';
import { runAgyLogin } from './agy-login.js';
import { readUsageFromAgy } from './usage.js';
import { runLegacyCommand } from './legacy.js';
import {
  deleteAgyCredential,
  deleteSnapshot,
  KeyringError,
  listSnapshots,
  readAgyCredential,
  readSnapshot,
  saveSnapshot,
  writeAgyCredential,
} from './keyring.js';
import { defaultRegistry, findAccount, readRegistry, slug, upsertAccount, writeRegistry } from './registry.js';

function help() {
  console.log(`agy-authx ${VERSION}`);
  console.log('');
  console.log('Local Google Antigravity session manager for agy CLI/App.');
  console.log('');
  console.log('Commands:');
  console.log('  status                  Show active AGY account and registry status');
  console.log('  login [--alias name]    Run AGY sign-in, then save the resulting session');
  console.log('  login --oauth           Use Google OAuth login method (default)');
  console.log('  login --cloud-project   Use Google Cloud project login method');
  console.log('  login --activate        Keep the newly logged-in account active');
  console.log('  list                    List stored auth snapshots');
  console.log('  list --refresh          Refresh quota for all snapshots, then list');
  console.log('  usage [--json]          Show active account quota and reset time');
  console.log('  switch <query>          Switch active AGY session by list id/email/alias/key');
  console.log('  set alias <query> to <alias>');
  console.log('  legacy <status|enabled|disabled>');
  console.log('  verify                  Verify agy-authx active account matches agy');
  console.log('  remove <query|--all>    Remove saved snapshots');
  console.log('  --version, -V           Show version');
  console.log('');
  console.log('Options:');
  console.log('  --json                  Print JSON output');
  console.log('');
  console.log('Install: npm install -g @badaruddinl/agy-authx');
  console.log('Run: agy-authx <command>');
}

function parseAlias(args) {
  const index = args.indexOf('--alias');
  if (index < 0) return '';
  if (!args[index + 1]) throw new Error('--alias requires a value.');
  return args[index + 1];
}

function parseLoginMethod(args) {
  const wantsOauth = args.includes('--oauth');
  const wantsCloudProject = args.includes('--cloud-project') || args.includes('--gcp') || args.includes('--google-cloud-project');
  if (wantsOauth && wantsCloudProject) throw new Error('Choose only one login method: --oauth or --cloud-project.');
  return wantsCloudProject ? 'cloud-project' : 'oauth';
}

function stripLoginMethodArgs(args) {
  return args.filter(arg => !['--oauth', '--cloud-project', '--gcp', '--google-cloud-project'].includes(arg));
}

function shouldActivateLogin(args) {
  return args.some(arg => ['--activate', '--active', '--use', '--switch'].includes(arg));
}

function stripLoginControlArgs(args) {
  return stripLoginMethodArgs(args)
    .filter(arg => !['--activate', '--active', '--use', '--switch'].includes(arg));
}

function sameEmail(left, right) {
  return Boolean(left && right) && String(left).toLowerCase() === String(right).toLowerCase();
}

async function status(jsonMode) {
  const registry = await readRegistry();
  const sync = await ensureSelectedSessionActive(registry);
  const activeAccount = registry.accounts.find(account => account.accountKey === registry.activeAccountKey);
  const email = activeAccount?.email || await detectActiveAccount();
  const payload = {
    version: VERSION,
    activeAccountEmail: email,
    registryPath: REGISTRY_PATH,
    savedAccounts: registry.accounts.length,
    activeAccountKey: registry.activeAccountKey,
    agyService: AGY_SERVICE,
    agyAccount: AGY_ACCOUNT,
    activeCredentialRepaired: sync.repaired,
  };
  if (jsonMode) {
    printJson(payload);
  } else {
    console.log(`active account: ${email || '-'}`);
    console.log(`saved accounts: ${registry.accounts.length}`);
    console.log(`active account key: ${registry.activeAccountKey || '-'}`);
    console.log(`agy credential: service=${AGY_SERVICE}, account=${AGY_ACCOUNT}`);
    console.log(`registry: ${REGISTRY_PATH}`);
    if (sync.repaired) console.log('active credential: repaired from selected agy-authx session');
  }
  return email ? 0 : 1;
}

async function refreshActiveUsage() {
  const usage = await readUsageFromAgy();
  const email = usage.accountEmail || await detectActiveAccount();
  if (!email) return usage;

  const accountKey = slug(email);
  await saveActiveCredentialSnapshot(accountKey);
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

async function refreshUsageForAccount(registry, account) {
  const secret = await readSnapshot(account.accountKey);
  await writeAgyCredential(secret);
  const usage = await readUsageFromAgy();
  const usageEmail = usage.accountEmail || account.email;
  const accountKey = account.accountKey;
  await saveActiveCredentialSnapshot(accountKey);
  const previous = registry.accounts.find(item => item.accountKey === accountKey);
  upsertAccount(registry, {
    ...previous,
    accountKey,
    email: previous?.email || usageEmail || account.email || accountKey,
    alias: previous?.alias || account.alias || '',
    createdAt: previous?.createdAt || account.createdAt || new Date().toISOString(),
    importedAt: previous?.importedAt || account.importedAt || null,
    usedAt: previous?.usedAt || account.usedAt || null,
    usage,
    usageAt: usage.capturedAt,
  });
  return usage;
}

async function refreshAllUsage() {
  const registry = await readRegistry();
  const activeKey = registry.activeAccountKey;
  const fallbackSecret = await readAgyCredential().catch(error => {
    if (error instanceof KeyringError) return null;
    throw error;
  });
  const snapshots = await listSnapshots();
  const snapshotKeys = new Set(snapshots.map(snapshot => snapshot.account));
  const accounts = registry.accounts.filter(account => snapshotKeys.has(account.accountKey));

  for (const account of accounts) {
    await refreshUsageForAccount(registry, account);
    await writeRegistry(registry);
  }

  await restoreActiveSession(activeKey, fallbackSecret);
}

async function captureCurrentAccount(args, emailOverride = '') {
  const alias = parseAlias(args);
  const email = emailOverride || await detectActiveAccount();
  if (!email) {
    throw new Error(
      'Active AGY email was not detected. Sign in with AGY outside agy-authx, '
      + 'then run `agy-authx login` to save the active session.',
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

async function login(args, jsonMode) {
  if (args.includes('--device-auth')) {
    const payload = {
      ok: false,
      error: '`agy-authx login --device-auth` is not supported by the installed AGY CLI.',
      fallback: 'Run `agy-authx login --alias <name>` to use the normal AGY sign-in flow.',
    };
    if (jsonMode) printJson(payload);
    else {
      console.log(payload.error);
      console.log(payload.fallback);
    }
    return 2;
  }

  const loginMethod = parseLoginMethod(args);
  const activateNewSession = shouldActivateLogin(args);
  const captureArgs = stripLoginControlArgs(args);
  const previousRegistry = await readRegistry();
  const previousActiveKey = previousRegistry.activeAccountKey || null;
  let previousSecret = null;
  try {
    previousSecret = await readAgyCredential();
    await deleteAgyCredential();
    await assertAgyCredentialCleared();
  } catch (error) {
    if (!(error instanceof KeyringError)) throw error;
  }

  if (!jsonMode) console.log('Starting agy-authx login...');
  let loginResult = null;
  try {
    loginResult = await runAgyLogin({ method: loginMethod });
  } catch (error) {
    if (previousSecret) await writeAgyCredential(previousSecret);
    throw error;
  }

  try {
    const account = await captureCurrentAccount(captureArgs, loginResult?.email || '');
    if (!activateNewSession) await restoreActiveSession(previousActiveKey, previousSecret);
    else await assertActiveCredentialMatches(account.accountKey);
    if (jsonMode) printJson({
      ok: true,
      account,
      registryPath: REGISTRY_PATH,
      activeAccountKey: activateNewSession ? account.accountKey : previousActiveKey || account.accountKey,
      activeSessionActivated: activateNewSession,
      activeSessionPreserved: !activateNewSession && Boolean(previousSecret && previousActiveKey),
    });
    else {
      console.log(`Captured AGY session: ${account.email}`);
      if (activateNewSession) console.log('Active AGY session set to the newly logged-in account.');
      else if (previousSecret && previousActiveKey) console.log('Active AGY session preserved. Use `agy-authx switch` to activate the new session.');
    }
    return 0;
  } catch (error) {
    await restoreActiveSession(previousActiveKey, previousSecret);
    throw error;
  }
}

async function assertAgyCredentialCleared() {
  try {
    await readAgyCredential();
  } catch (error) {
    if (error instanceof KeyringError) return;
    throw error;
  }
  throw new Error('Failed to clear the active AGY credential before login. Refusing to continue because it could capture the old session.');
}

async function restoreActiveRegistryKey(activeAccountKey) {
  if (!activeAccountKey) return;
  const registry = await readRegistry();
  if (registry.accounts.some(account => account.accountKey === activeAccountKey)) {
    registry.activeAccountKey = activeAccountKey;
    await writeRegistry(registry);
  }
}

async function restoreActiveSession(activeAccountKey, fallbackSecret = null) {
  if (activeAccountKey) {
    try {
      const activeSecret = await readSnapshot(activeAccountKey);
      await writeAgyCredential(activeSecret);
      await assertActiveCredentialMatches(activeAccountKey);
      await restoreActiveRegistryKey(activeAccountKey);
      return;
    } catch (error) {
      if (!(error instanceof KeyringError)) throw error;
    }
  }
  if (fallbackSecret) await writeAgyCredential(fallbackSecret);
}

async function assertActiveCredentialMatches(accountKey) {
  const [snapshotSecret, activeSecret] = await Promise.all([
    readSnapshot(accountKey),
    readAgyCredential(),
  ]);
  if (snapshotSecret !== activeSecret) {
    throw new Error(`Active AGY credential did not match selected snapshot: ${accountKey}`);
  }
}

async function ensureSelectedSessionActive(registry = null) {
  const currentRegistry = registry || await readRegistry();
  const activeAccount = currentRegistry.accounts.find(account => account.accountKey === currentRegistry.activeAccountKey);
  if (!activeAccount) return { activeAccount: null, matched: false, repaired: false };

  const snapshotSecret = await readSnapshot(activeAccount.accountKey).catch(error => {
    if (error instanceof KeyringError) return null;
    throw error;
  });
  if (!snapshotSecret) {
    return {
      activeAccount,
      matched: false,
      repaired: false,
      error: `Saved snapshot credential is missing for ${activeAccount.accountKey}.`,
    };
  }

  const activeSecret = await readAgyCredential().catch(error => {
    if (error instanceof KeyringError) return null;
    throw error;
  });

  if (activeSecret === snapshotSecret) {
    return { activeAccount, matched: true, repaired: false };
  }

  await writeAgyCredential(snapshotSecret);
  await assertActiveCredentialMatches(activeAccount.accountKey);
  return { activeAccount, matched: true, repaired: true };
}

async function saveActiveCredentialSnapshot(accountKey) {
  try {
    const activeSecret = await readAgyCredential();
    await saveSnapshot(accountKey, activeSecret);
    return true;
  } catch (error) {
    if (error instanceof KeyringError) return false;
    throw error;
  }
}

async function readListRegistry() {
  const registry = await readRegistry();
  await ensureSelectedSessionActive(registry);
  const snapshots = await listSnapshots();
  const activeAccount = registry.accounts.find(account => account.accountKey === registry.activeAccountKey);
  const activeEmail = activeAccount?.email || await detectActiveAccount();
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
  if (refresh) await refreshAllUsage();
  const registry = await readListRegistry();
  if (jsonMode) printJson(registry);
  else printAccounts(registry);
  return registry.accounts.length ? 0 : 1;
}

async function usage(jsonMode) {
  const registry = await readRegistry();
  await ensureSelectedSessionActive(registry);
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
      console.log('Switch query is required. Use a list id, email, alias, or key from this list:');
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
    if (jsonMode) printJson({ ok: false, error: 'No saved account matched.', query });
    else console.log('No saved account matched.');
    return 1;
  }

  const secret = await readSnapshot(account.accountKey);
  await writeAgyCredential(secret);
  await assertActiveCredentialMatches(account.accountKey);
  account.usedAt = new Date().toISOString();
  registry.activeAccountKey = account.accountKey;
  upsertAccount(registry, account);
  await writeRegistry(registry);

  if (jsonMode) printJson({ ok: true, account, activeCredentialWritten: true });
  else console.log(`switched to ${account.email}`);
  return 0;
}

function parseSetAliasArgs(args) {
  if (args[0] !== 'alias') {
    throw new Error('Usage: agy-authx set alias <query> to <alias>');
  }
  const rest = args.slice(1);
  const toIndex = rest.indexOf('to');
  if (toIndex <= 0) {
    throw new Error('Usage: agy-authx set alias <query> to <alias>');
  }
  const query = rest.slice(0, toIndex).join(' ').trim();
  const alias = rest.slice(toIndex + 1).join(' ').trim();
  if (!query) throw new Error('Alias target query is required.');
  if (!alias) throw new Error('Alias value is required.');
  return { query, alias };
}

async function setAlias(args, jsonMode) {
  let parsed;
  try {
    parsed = parseSetAliasArgs(args);
  } catch (error) {
    if (jsonMode) printJson({ ok: false, error: error.message });
    else console.log(error.message);
    return 1;
  }

  const listRegistry = await readListRegistry();
  const { account, matches } = findAccount(listRegistry, parsed.query);
  if (matches.length > 1) {
    if (jsonMode) printJson({ ok: false, error: 'Query matched multiple accounts.', matches });
    else console.log('Query matched multiple accounts. Use a more specific list id, email, alias, or key.');
    return 2;
  }
  if (!account) {
    if (jsonMode) printJson({ ok: false, error: 'No saved account matched.', query: parsed.query });
    else console.log('No saved account matched.');
    return 1;
  }

  const registry = await readRegistry();
  const previous = registry.accounts.find(item => item.accountKey === account.accountKey) || account;
  const updated = {
    ...previous,
    accountKey: account.accountKey,
    email: previous.email || account.email || account.accountKey,
    alias: parsed.alias,
  };
  upsertAccount(registry, updated);
  if (!registry.activeAccountKey && listRegistry.activeAccountKey) {
    registry.activeAccountKey = listRegistry.activeAccountKey;
  }
  await writeRegistry(registry);

  if (jsonMode) printJson({ ok: true, account: updated });
  else console.log(`set ${updated.email} to ${updated.alias}`);
  return 0;
}

async function verify(jsonMode) {
  const registry = await readRegistry();
  const sync = await ensureSelectedSessionActive(registry);
  const activeAccount = sync.activeAccount;
  if (!activeAccount) {
    const payload = {
      ok: false,
      error: 'No active account is selected in agy-authx.',
      activeAccountKey: registry.activeAccountKey || null,
    };
    if (jsonMode) printJson(payload);
    else console.log(payload.error);
    return 1;
  }

  if (!sync.matched) {
    const payload = {
      ok: false,
      error: sync.error || 'Active AGY credential does not match the selected agy-authx session.',
      activeAccountEmail: activeAccount.email,
      activeAccountKey: activeAccount.accountKey,
      credentialMatches: false,
      activeCredentialRepaired: false,
      agyEmail: null,
      agyMatches: false,
    };
    if (jsonMode) printJson(payload);
    else {
    console.log(`agy-authx active: ${activeAccount.email}`);
      console.log('active credential: mismatch');
      console.log(`error           : ${payload.error}`);
    }
    return 2;
  }

  const usagePayload = await readUsageFromAgy();
  const agyEmail = usagePayload.accountEmail || '';
  const agyMatches = sameEmail(agyEmail, activeAccount.email);
  if (agyMatches) await saveActiveCredentialSnapshot(activeAccount.accountKey);
  const payload = {
    ok: sync.matched && agyMatches,
    activeAccountEmail: activeAccount.email,
    activeAccountKey: activeAccount.accountKey,
    credentialMatches: sync.matched,
    activeCredentialRepaired: sync.repaired,
    agyEmail: agyEmail || null,
    agyMatches,
    appCredentialSource: `${AGY_SERVICE}/${AGY_ACCOUNT}`,
    appNote: 'Antigravity App uses this active credential on a fresh session; restart/reload the app if it was already open before switching.',
  };

  if (jsonMode) {
    printJson(payload);
  } else {
    console.log(`agy-authx active: ${payload.activeAccountEmail}`);
    const credentialState = payload.activeCredentialRepaired
      ? 'repaired from selected snapshot'
      : 'matches selected snapshot';
    console.log(`active credential: ${credentialState}`);
    console.log(`agy             : ${payload.agyEmail || '-'}`);
    console.log(`agy match       : ${payload.agyMatches ? 'yes' : 'no'}`);
    console.log(`app credential  : ${payload.appCredentialSource}`);
    console.log('app note        : restart/reload Antigravity App if it was already open before switching.');
  }

  return payload.ok ? 0 : 2;
}

async function remove(args, jsonMode) {
  const registry = await readRegistry();
  const targets = args[0] === '--all'
    ? registry.accounts
    : findAccount(registry, args[0]).matches;
  if (targets.length === 0) {
    if (jsonMode) printJson({ ok: false, error: 'No saved account matched.' });
    else console.log('No saved account matched.');
    return 1;
  }

  const keys = new Set(targets.map(account => account.accountKey));
  await Promise.all([...keys].map(deleteSnapshot));
  registry.accounts = registry.accounts.filter(account => !keys.has(account.accountKey));
  if (keys.has(registry.activeAccountKey)) registry.activeAccountKey = null;
  await writeRegistry(registry);

  if (jsonMode) printJson({ ok: true, removed: [...keys] });
  else console.log(`Removed ${keys.size} saved account(s).`);
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
    console.log(`agy-authx ${VERSION}`);
    return 0;
  }
  if (command === 'status') return status(jsonMode);
  if (command === 'login') return login(rest, jsonMode);
  if (command === 'list') return list(jsonMode, refresh);
  if (command === 'usage') return usage(jsonMode);
  if (command === 'switch') return switchAccount(rest[0], jsonMode);
  if (command === 'set') return setAlias(rest, jsonMode);
  if (command === 'legacy') return runLegacyCommand(rest, { jsonMode, authxVersion: VERSION });
  if (command === 'verify') return verify(jsonMode);
  if (command === 'remove') return remove(rest, jsonMode);

  console.error(`Unknown command: ${command}`);
  console.error('Run `agy-authx --help`.');
  return 2;
}

export const internals = {
  defaultRegistry,
  findAccount,
  parseAlias,
  parseLoginMethod,
  parseSetAliasArgs,
  sameEmail,
  shouldActivateLogin,
  stripLoginControlArgs,
  stripLoginMethodArgs,
  slug,
  upsertAccount,
};
