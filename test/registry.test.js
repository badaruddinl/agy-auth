import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractAccountEmail } from '../src/agy.js';
import { internals } from '../src/cli.js';
import { formatLastRefresh, formatUsageColumns } from '../src/format.js';
import { readRegistry } from '../src/registry.js';
import { parseUsageOutput } from '../src/usage.js';

test('extracts latest AGY account email from logs', () => {
  const email = extractAccountEmail(`
    OAuth: authenticated successfully as first@example.com
    applyAuthResult: email=writer@example.com, authMethod=consumer
  `);

  assert.equal(email, 'writer@example.com');
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
});

test('parses import alias', () => {
  assert.equal(internals.parseAlias(['--alias', 'utama']), 'utama');
  assert.equal(internals.parseAlias([]), '');
  assert.throws(() => internals.parseAlias(['--alias']), /requires a value/);
});

test('installed AGY build does not require device auth support in parser tests', () => {
  assert.equal(typeof internals.supportsAgyDeviceAuth, 'function');
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

  const columns = formatUsageColumns(usage);

  assert.equal(columns.geminiFiveHour, '98% (1h 51m)');
  assert.equal(columns.geminiWeekly, '89% (118h 40m)');
  assert.equal(columns.otherFiveHour, '100%');
  assert.equal(columns.otherWeekly, '66% (120h 1m)');
});

test('formats recent refresh timestamp', () => {
  assert.equal(formatLastRefresh(new Date().toISOString()), 'Now');
});
