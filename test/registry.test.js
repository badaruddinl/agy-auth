import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractAccountEmail } from '../src/agy.js';
import { internals as loginInternals } from '../src/agy-login.js';
import { internals, run } from '../src/cli.js';
import { formatLastRefresh, formatResetAt, formatUsageColumns, parseRefreshDuration, printAccounts } from '../src/format.js';
import { internals as legacyInternals, runLegacyCommand } from '../src/legacy.js';
import { readRegistry, upsertAccount } from '../src/registry.js';
import { internals as usageInternals, parseUsageOutput } from '../src/usage.js';

test('extracts latest AGY account email from logs', () => {
  const email = extractAccountEmail(`
    OAuth: authenticated successfully as first@example.com
    applyAuthResult: email=writer@example.com, authMethod=consumer
  `);

  assert.equal(email, 'writer@example.com');
});

test('agy-authx package owns only the agy-authx command', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));

  assert.equal(packageJson.version, '0.1.24');
  assert.deepEqual(packageJson.bin, {
    'agy-authx': 'bin/agy-authx.js',
  });
});

test('agy-auth bridge owns only the agy-auth command and installs agy-authx', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), 'legacy', 'agy-auth', 'package.json'), 'utf8'));

  assert.deepEqual(packageJson.bin, {
    'agy-auth': 'bin/agy-auth.js',
  });
  assert.equal(packageJson.dependencies['@badaruddinl/agy-authx'], '^0.1.24');
});

test('legacy bridge parser recognizes managed legacy bridge versions', () => {
  const parsed = legacyInternals.parseGlobalPackage(JSON.stringify({
    dependencies: {
      '@badaruddinl/agy-auth': {
        version: '0.1.16',
      },
    },
  }));

  assert.equal(parsed.installed, true);
  assert.equal(parsed.version, '0.1.16');
  assert.equal(parsed.managedBridge, true);
  assert.equal(legacyInternals.isManagedLegacyVersion('0.1.17'), true);
  assert.equal(legacyInternals.isManagedLegacyVersion('0.1.24'), true);
  assert.equal(legacyInternals.isManagedLegacyVersion('0.1.25'), false);
});

test('legacy bridge guard refuses to modify unmanaged versions', () => {
  assert.throws(
    () => legacyInternals.assertManagedLegacyBridge({
      installed: true,
      version: '0.1.25',
    }),
    /Only @badaruddinl\/agy-auth versions <= 0\.1\.24 are managed/,
  );
});

test('legacy enabled removes verified bridge before installing agy-auth bridge', async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'ls') {
      return {
        stdout: JSON.stringify({
          dependencies: {
            '@badaruddinl/agy-auth': {
              version: '0.1.24',
            },
          },
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };

  const lines = [];
  const code = await runLegacyCommand(['enabled'], {
    authxVersion: '0.1.24',
    runner,
    output: line => lines.push(line),
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ['ls', '-g', '@badaruddinl/agy-auth', '--depth=0', '--json'],
    ['uninstall', '-g', '@badaruddinl/agy-auth'],
    ['install', '-g', '@badaruddinl/agy-auth'],
  ]);
  assert.match(lines.join('\n'), /agy-auth cmd is enabled through the bridge package/);
});

test('matches accounts by email alias and key', () => {
  const registry = {
    activeAccountKey: 'writer-example.com',
    accounts: [
      { accountKey: 'writer-example.com', email: 'writer@example.com', alias: 'utama' },
      { accountKey: 'backup-example.com', email: 'backup@example.com', alias: 'cadangan' },
    ],
  };

  assert.equal(internals.findAccount(registry, 'utama').account.email, 'writer@example.com');
  assert.equal(internals.findAccount(registry, 'backup@').account.accountKey, 'backup-example.com');
  assert.equal(internals.findAccount(registry, 'example.com').matches.length, 2);
  assert.equal(internals.findAccount(registry, '01').account.email, 'writer@example.com');
  assert.equal(internals.findAccount(registry, '2').account.email, 'backup@example.com');
  assert.equal(internals.findAccount(registry, '03').account, null);
});

test('parses login alias', () => {
  assert.equal(internals.parseAlias(['--alias', 'utama']), 'utama');
  assert.equal(internals.parseAlias([]), '');
  assert.throws(() => internals.parseAlias(['--alias']), /requires a value/);
});

test('agy-authx login is a local session manager command', () => {
  assert.equal(typeof internals.parseAlias, 'function');
});

test('login uses foreground AGY by default', () => {
  const previous = process.env.AGY_AUTHX_LOGIN_PIPE;
  delete process.env.AGY_AUTHX_LOGIN_PIPE;
  try {
    assert.equal(loginInternals.usePipeLoginMode(), false);
    process.env.AGY_AUTHX_LOGIN_PIPE = '1';
    assert.equal(loginInternals.usePipeLoginMode(), true);
    process.env.AGY_AUTHX_LOGIN_PIPE = '0';
    assert.equal(loginInternals.usePipeLoginMode(), false);
  } finally {
    if (previous === undefined) delete process.env.AGY_AUTHX_LOGIN_PIPE;
    else process.env.AGY_AUTHX_LOGIN_PIPE = previous;
  }
});

test('login method selection matches AGY interactive menu', () => {
  assert.equal(loginInternals.loginMethodInput('oauth'), '\r');
  assert.equal(loginInternals.loginMethodInput('cloud-project'), '\x1b[B\r');
});

test('cloud project login uses direct OAuth flow by default', () => {
  const previousPipe = process.env.AGY_AUTHX_LOGIN_PIPE;
  const previousForeground = process.env.AGY_AUTHX_LOGIN_FOREGROUND;
  delete process.env.AGY_AUTHX_LOGIN_PIPE;
  delete process.env.AGY_AUTHX_LOGIN_FOREGROUND;
  try {
    assert.equal(loginInternals.shouldUseDirectLogin('oauth'), true);
    assert.equal(loginInternals.shouldUseDirectLogin('cloud-project'), true);
    process.env.AGY_AUTHX_LOGIN_PIPE = '1';
    process.env.AGY_AUTHX_LOGIN_FOREGROUND = '1';
    assert.equal(loginInternals.shouldUseDirectLogin('oauth'), false);
    assert.equal(loginInternals.shouldUseDirectLogin('cloud-project'), true);
  } finally {
    if (previousPipe === undefined) delete process.env.AGY_AUTHX_LOGIN_PIPE;
    else process.env.AGY_AUTHX_LOGIN_PIPE = previousPipe;
    if (previousForeground === undefined) delete process.env.AGY_AUTHX_LOGIN_FOREGROUND;
    else process.env.AGY_AUTHX_LOGIN_FOREGROUND = previousForeground;
  }
});

test('builds AGY cloud project credential', () => {
  const credential = JSON.parse(loginInternals.buildAgyCredential({
    token: {
      access_token: 'access',
      token_type: 'Bearer',
      refresh_token: 'refresh',
      expires_in: 3600,
    },
    authMethod: 'gcp',
  }));

  assert.equal(credential.auth_method, 'gcp');
  assert.equal(credential.quota_project_id, undefined);
  assert.equal(credential.project_id, undefined);
  assert.equal(credential.token.access_token, 'access');
  assert.equal(credential.token.refresh_token, 'refresh');
  assert.match(credential.token.expiry, /^\d{4}-\d{2}-\d{2}T/);
});

test('resolves cloud project from flag or prompt', async () => {
  assert.equal(await loginInternals.resolveCloudProjectId('explicit-project'), 'explicit-project');
  const rl = {
    async question(prompt) {
      assert.equal(prompt, 'Enter Google Cloud Project ID: ');
      return ' typed-project ';
    },
  };
  assert.equal(await loginInternals.resolveCloudProjectId('', rl), 'typed-project');
});

test('normalizes Google Cloud location', () => {
  assert.equal(loginInternals.normalizeCloudLocation(' GLOBAL '), 'global');
  assert.equal(loginInternals.normalizeCloudLocation('us'), 'us');
  assert.equal(loginInternals.normalizeCloudLocation('eu'), 'eu');
  assert.equal(loginInternals.normalizeCloudLocation(''), '');
  assert.throws(() => loginInternals.normalizeCloudLocation('asia'), /global, us, eu/);
});

test('builds AGY Google OAuth URL for direct login', () => {
  const url = new URL(loginInternals.buildGoogleOAuthUrl({
    clientId: 'test-client.apps.googleusercontent.com',
    codeChallenge: 'challenge',
    state: 'state',
  }));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/auth');
  assert.equal(url.searchParams.get('client_id'), 'test-client.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://antigravity.google/oauth-callback');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('scope'), /userinfo\.email/);
});

test('exchanges OAuth code with the full AGY client secret', async () => {
  const previousFetch = globalThis.fetch;
  const fullSecret = `GOCSPX-${'a'.repeat(68)}`;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          access_token: 'access',
          token_type: 'Bearer',
          refresh_token: 'refresh',
          expires_in: 3600,
        };
      },
    };
  };
  try {
    await loginInternals.exchangeOAuthCode({
      code: '4/test-code',
      codeVerifier: 'verifier',
      oauthConfig: {
        clientId: 'client.apps.googleusercontent.com',
        clientSecrets: [fullSecret],
      },
    });
    assert.equal(calls[0].options.body.get('client_secret'), fullSecret);
    assert.equal(calls[0].options.body.get('client_secret').length, fullSecret.length);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('trims OAuth client secret before an adjacent URL marker', () => {
  const staleSecret = `GOCSPX-${'a'.repeat(28)}`;
  const activeSecret = `GOCSPX-${'b'.repeat(28)}`;
  const binaryText = `before${staleSecret}${activeSecret}https://oauth2.googleapis.com/token after`;
  assert.deepEqual(loginInternals.extractGoogleOAuthClientSecrets(binaryText), [activeSecret, staleSecret]);
});

test('extracts OAuth code from callback URL or pasted value', () => {
  assert.equal(
    loginInternals.extractOAuthCallbackCode('https://antigravity.google/oauth-callback?state=s&code=4%2Fabc123'),
    '4/abc123',
  );
  assert.equal(loginInternals.extractOAuthCallbackCode('4/raw-code'), '4/raw-code');
});

test('masks OAuth client secrets for diagnostics', () => {
  assert.equal(loginInternals.maskOAuthSecret('secret-abcdefghijklmnopqrstuvwxyz'), 'secret-abc...wxyz');
});

test('debug session commands are not public commands', async () => {
  const originalError = console.error;
  const writes = [];
  console.error = value => writes.push(value);
  try {
    assert.equal(await run(['capture']), 2);
    assert.equal(await run(['import']), 2);
    assert.equal(await run(['debug']), 2);
    assert.equal(await run(['config']), 2);
  } finally {
    console.error = originalError;
  }

  assert.match(writes.join('\n'), /Unknown command: capture/);
  assert.match(writes.join('\n'), /Unknown command: config/);
});

test('matches active AGY account emails case-insensitively', () => {
  assert.equal(internals.sameEmail('Writer@Example.com', 'writer@example.com'), true);
  assert.equal(internals.sameEmail('writer@example.com', 'other@example.com'), false);
  assert.equal(internals.sameEmail('', 'writer@example.com'), false);
});

test('parses agy-authx login method flags', () => {
  assert.equal(internals.parseLoginMethod([]), 'oauth');
  assert.equal(internals.parseLoginMethod(['--oauth']), 'oauth');
  assert.equal(internals.parseLoginMethod(['--cloud-project']), 'cloud-project');
  assert.equal(internals.parseLoginMethod(['--gcp']), 'cloud-project');
  assert.equal(internals.parseCloudProject(['--project', 'example-project']), 'example-project');
  assert.equal(internals.parseCloudProject(['--quota-project=quota-project']), 'quota-project');
  assert.equal(internals.parseCloudLocation(['--location', 'global']), 'global');
  assert.equal(internals.parseCloudLocation(['--region=us']), 'us');
  assert.deepEqual(internals.stripLoginMethodArgs(['--cloud-project', '--alias', 'main']), ['--alias', 'main']);
  assert.deepEqual(internals.stripLoginControlArgs(['--cloud-project', '--project', 'example-project', '--alias', 'main']), ['--alias', 'main']);
  assert.deepEqual(internals.stripLoginControlArgs(['--cloud-project', '--location', 'global', '--alias', 'main']), ['--alias', 'main']);
  assert.equal(internals.shouldActivateLogin(['--activate']), true);
  assert.equal(internals.shouldActivateLogin(['--alias', 'main']), false);
  assert.deepEqual(internals.stripLoginControlArgs(['--activate', '--cloud-project', '--alias', 'main']), ['--alias', 'main']);
  assert.throws(() => internals.parseCloudProject(['--project']), /requires a value/);
  assert.throws(() => internals.parseCloudProject(['--project=']), /requires a value/);
  assert.throws(() => internals.parseCloudLocation(['--location']), /requires a value/);
  assert.throws(() => internals.parseCloudLocation(['--location=']), /requires a value/);
  assert.throws(() => internals.parseLoginMethod(['--oauth', '--cloud-project']), /Choose only one login method/);
});

test('parses alias set command arguments', () => {
  assert.deepEqual(internals.parseSetAliasArgs(['alias', '02', 'to', 'work']), {
    query: '02',
    alias: 'work',
  });
  assert.deepEqual(internals.parseSetAliasArgs(['alias', 'writer@example.com', 'to', 'main account']), {
    query: 'writer@example.com',
    alias: 'main account',
  });
  assert.throws(() => internals.parseSetAliasArgs(['02', 'work']), /Usage/);
  assert.throws(() => internals.parseSetAliasArgs(['alias', '02', 'to']), /Alias value/);
});

test('parses AGY login OAuth output', () => {
  const output = `
    Your browser should open automatically. If not:
    https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=abc
    &code_challenge=xyz&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback

    If you aren't automatically redirected, paste the authorization code below:
    authorization code...
  `;

  const url = loginInternals.extractGoogleAuthUrl(output);

  assert.equal(url, 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=abc&code_challenge=xyz&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback');
});

test('parses wrapped AGY OAuth URL output', () => {
  const output = `
    https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=test-client
    .apps.googleusercontent.com&code_challenge=u9c9mCt8PBAWhbHmWunv6Fb5
    GLVhiFMpkdiEHtd8st0&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback

    If you aren't automatically redirected, paste the authorization code below:
  `;

  assert.equal(loginInternals.extractGoogleAuthUrl(output), 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=test-client.apps.googleusercontent.com&code_challenge=u9c9mCt8PBAWhbHmWunv6Fb5GLVhiFMpkdiEHtd8st0&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback');
});

test('preserves OAuth URL from terminal hyperlink escape output', () => {
  const raw = '\u001b]8;;https://accounts.google.com/o/oauth2/auth?client_id=abc&code_challenge=xyz\u0007Open link\u001b]8;;\u0007';
  const cleaned = loginInternals.cleanTerminal(raw);

  assert.equal(loginInternals.extractGoogleAuthUrl(cleaned), 'https://accounts.google.com/o/oauth2/auth?client_id=abc&code_challenge=xyz');
});

test('formats OAuth URL as terminal hyperlink when TTY is available', () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    assert.equal(
      loginInternals.formatTerminalLink('https://accounts.google.com/o/oauth2/auth?client_id=abc', 'Open AGY OAuth login'),
      '\u001b]8;;https://accounts.google.com/o/oauth2/auth?client_id=abc\u0007Open AGY OAuth login\u001b]8;;\u0007',
    );
  } finally {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original);
  }
});

test('detects AGY signed-in state from parsed terminal output', () => {
  assert.equal(loginInternals.isSignedIn(`
    Antigravity CLI 1.0.15
    writer@example.com
    Gemini 3.1 Pro (High)
  `), true);
});

test('extracts signed-in email from latest AGY login output', () => {
  assert.equal(loginInternals.extractSignedInEmail(`
    Antigravity CLI 1.0.15
    old@example.com
    authorization code...
    Antigravity CLI 1.0.15
    new@example.com
    Gemini 3.1 Pro (High)
  `), 'new@example.com');
});

test('extracts AGY authorization code from login output', () => {
  assert.equal(loginInternals.extractAuthorizationCode(`
    If you aren't automatically redirected, paste the authorization code below:
    4/0AdkVLPxMUWqkPAF9PMTQqTQXej-jVUT75pLdS82gRGdY
  `), '4/0AdkVLPxMUWqkPAF9PMTQqTQXej-jVUT75pLdS82gRGdY');
});

test('detects current AGY authorization code prompt wording', () => {
  assert.equal(loginInternals.isAuthorizationCodePrompt(`
    Waiting for authentication (timeout 30s)...
    Or, paste the authorization code here and press Enter:
  `), true);
  assert.equal(loginInternals.isAuthorizationCodePrompt(`
    If you aren't automatically redirected, paste the authorization code below:
  `), true);
});

test('parses AGY usage output', () => {
  const usage = parseUsageOutput(`
    Account: writer@example.com

    GEMINI MODELS
      Models within this group: Gemini Flash, Gemini Pro

      Weekly Limit
        89% remaining · Refreshes in 121h 51m

      Five Hour Limit
        Quota available

    CLAUDE AND GPT MODELS
      Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

      Weekly Limit
        66% remaining · Refreshes in 123h 12m

      Five Hour Limit
        100% remaining
  `);

  assert.equal(usage.available, true);
  assert.equal(usage.accountEmail, 'writer@example.com');
  assert.equal(usage.groups[0].weekly.remainingPercent, 89);
  assert.equal(usage.groups[0].weekly.refreshesIn, '121h 51m');
  assert.equal(usage.groups[0].fiveHour.remainingPercent, 100);
  assert.equal(usage.groups[1].weekly.remainingPercent, 66);
});

test('parses AGY local quota summary protobuf', () => {
  const payload = encodeMessage([
    [1, encodeMessage([
      [2, encodeQuotaGroup('Gemini Models', 'Models within this group: Gemini Flash, Gemini Pro', [
        encodeQuotaLimit('gemini-weekly', 'Weekly Limit', 'weekly', 0.89, 1784016000),
        encodeQuotaLimit('gemini-5h', 'Five Hour Limit', '5h', 1, 1783425600),
      ])],
      [2, encodeQuotaGroup('Claude and GPT models', 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', [
        encodeQuotaLimit('3p-weekly', 'Weekly Limit', 'weekly', 0.66, 1783416600),
        encodeQuotaLimit('3p-5h', 'Five Hour Limit', '5h', 1, 1783432800),
      ])],
    ])],
  ]);

  const usage = usageInternals.parseQuotaSummary(payload, '2026-07-07T09:00:00Z');

  assert.equal(usage.available, true);
  assert.equal(usage.groups[0].name, 'Gemini Models');
  assert.equal(usage.groups[0].models, 'Gemini Flash, Gemini Pro');
  assert.equal(usage.groups[0].weekly.remainingPercent, 89);
  assert.equal(usage.groups[0].fiveHour.remainingPercent, 100);
  assert.equal(usage.groups[1].name, 'Claude And Gpt Models');
  assert.equal(usage.groups[1].weekly.remainingPercent, 66);
});

test('parses AGY usage account when TUI headings touch the email', () => {
  const usage = parseUsageOutput(`
    Account: writer@example.comGEMINI MODELS
      Models within this group: Gemini Flash, Gemini Pro
      Weekly Limit
        89% remaining · Refreshes in 121h 51m
      Five Hour Limit
        98% remaining · Refreshes in 1h 55m
    CLAUDE AND GPT MODELS
      Models within this group: Claude Opus, Claude Sonnet, GPT-OSS
      Weekly Limit
        66% remaining · Refreshes in 123h 12m
      Five Hour Limit
        Quota available
  `);

  assert.equal(usage.accountEmail, 'writer@example.com');
});

test('dedupes registry accounts with TUI heading suffix', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-auth-registry-'));
  const registryPath = path.join(dir, 'registry.json');
  await fs.writeFile(registryPath, JSON.stringify({
    schema_version: 1,
    active_account_key: 'writer@example.com',
    accounts: [
      { account_key: 'writer@example.com', email: 'writer@example.com', alias: 'main' },
      {
        account_key: 'writer@example.comGEMINI',
        email: 'writer@example.comGEMINI',
        last_usage: { available: true, groups: [] },
      },
    ],
  }));

  const registry = await readRegistry(registryPath);

  assert.equal(registry.accounts.length, 1);
  assert.equal(registry.accounts[0].accountKey, 'writer@example.com');
  assert.equal(registry.accounts[0].alias, 'main');
  assert.equal(registry.accounts[0].usage.available, true);
});

test('upserts same email account instead of duplicating it', () => {
  const registry = {
    activeAccountKey: 'writer@example.com',
    accounts: [
      {
        accountKey: 'writer@example.com',
        email: 'writer@example.com',
        alias: 'main',
        importedAt: 'first',
      },
    ],
  };

  upsertAccount(registry, {
    accountKey: 'writer@example.com',
    email: 'writer@example.com',
    alias: 'updated',
    importedAt: 'second',
  });

  assert.equal(registry.accounts.length, 1);
  assert.equal(registry.accounts[0].alias, 'updated');
  assert.equal(registry.accounts[0].importedAt, 'second');
});

test('formats list usage columns', () => {
  const usage = parseUsageOutput(`
    Account: writer@example.com
    GEMINI MODELS
      Models within this group: Gemini Flash, Gemini Pro
      Weekly Limit
        89% remaining · Refreshes in 118h 40m
      Five Hour Limit
        98% remaining · Refreshes in 1h 51m
    CLAUDE AND GPT MODELS
      Models within this group: Claude Opus, Claude Sonnet, GPT-OSS
      Weekly Limit
        66% remaining · Refreshes in 120h 1m
      Five Hour Limit
        Quota available
  `);
  usage.capturedAt = '2026-07-02T09:32:00+07:00';

  const columns = formatUsageColumns(usage);

  assert.equal(columns.geminiFiveHour, '98% (11:23)');
  assert.equal(columns.geminiWeekly, '89% (08:12 on 7 Jul)');
  assert.equal(columns.otherFiveHour, '100%');
  assert.equal(columns.otherWeekly, '66% (09:33 on 7 Jul)');
});

test('formats active unsaved account as current auth', () => {
  const writes = [];
  const originalLog = console.log;
  console.log = value => writes.push(value);
  try {
    printAccounts({
      activeAccountKey: 'writer-example.com',
      accounts: [
        {
          accountKey: 'writer-example.com',
          email: 'writer@example.com',
          alias: '',
          hasSnapshot: false,
          isActiveCredential: true,
        },
      ],
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(writes.join('\n'), /\*\s+01\s+writer@example\.com\s+-\s+current\s+/);
});

test('formats account list within a narrow terminal without wrapping rows', () => {
  const writes = [];
  const originalLog = console.log;
  console.log = value => writes.push(String(value));
  try {
    printAccounts({
      activeAccountKey: 'writer@example.com',
      accounts: [
        {
          accountKey: 'writer@example.com',
          email: 'very.long.account.name.for.testing@example-company.internal',
          alias: 'primary-long-alias',
          hasSnapshot: true,
          usage: parseUsageOutput(`
            Account: writer@example.com
            GEMINI MODELS
              Weekly Limit
                89% remaining
              Five Hour Limit
                98% remaining
            CLAUDE AND GPT MODELS
              Weekly Limit
                66% remaining
              Five Hour Limit
                Quota available
          `),
          usageAt: new Date().toISOString(),
        },
      ],
    }, { columns: 64 });
  } finally {
    console.log = originalLog;
  }

  assert.ok(writes.every(line => stripAnsi(line).length <= 64));
  assert.equal(writes.filter(line => /\*\s+01\s+/.test(line)).length, 1);
  assert.match(writes.join('\n'), /very\.long\.account\.name/);
});

test('highlights the active account row when color is enabled', () => {
  const writes = [];
  const originalLog = console.log;
  console.log = value => writes.push(String(value));
  try {
    printAccounts({
      activeAccountKey: 'writer@example.com',
      accounts: [
        {
          accountKey: 'writer@example.com',
          email: 'writer@example.com',
          alias: 'main',
          hasSnapshot: true,
        },
      ],
    }, { columns: 80, color: true });
  } finally {
    console.log = originalLog;
  }

  assert.match(writes.find(line => line.includes('writer@example.com')), /^\x1b\[1;36m\*/);
});

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function encodeQuotaGroup(name, models, limits) {
  return encodeMessage([
    ...limits.map(limit => [1, limit]),
    [2, Buffer.from(name)],
    [3, Buffer.from(models)],
  ]);
}

function encodeQuotaLimit(id, title, key, fraction, resetSeconds) {
  return encodeMessage([
    [1, Buffer.from(id)],
    [2, Buffer.from(title)],
    [3, Buffer.from(key)],
    [6, encodeMessage([[1, resetSeconds]])],
    [4, fraction, 'fixed32'],
  ]);
}

function encodeMessage(fields) {
  return Buffer.concat(fields.map(([field, value, type]) => {
    if (Buffer.isBuffer(value)) {
      return Buffer.concat([
        encodeVarint((field << 3) | 2),
        encodeVarint(value.length),
        value,
      ]);
    }
    if (type === 'fixed32') {
      const body = Buffer.alloc(4);
      body.writeFloatLE(value);
      return Buffer.concat([encodeVarint((field << 3) | 5), body]);
    }
    return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
  }));
}

function encodeVarint(value) {
  const bytes = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

test('formats recent refresh timestamp', () => {
  assert.equal(formatLastRefresh(new Date().toISOString()), 'Now');
});

test('parses and formats reset duration as absolute local time', () => {
  assert.equal(parseRefreshDuration('1h 30m'), 90 * 60 * 1000);
  assert.equal(parseRefreshDuration('2 days 3 hours 4 minutes'), ((2 * 24 * 60) + (3 * 60) + 4) * 60 * 1000);
  assert.equal(formatResetAt('34m', '2026-07-02T09:32:00+07:00'), '10:06');
  assert.equal(formatResetAt('25h', '2026-07-02T09:32:00+07:00'), '10:32 on 3 Jul');
});
