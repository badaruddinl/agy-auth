import fs from 'node:fs/promises';
import path from 'node:path';
import { REGISTRY_PATH } from './constants.js';

export function slug(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.@-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `account-${Date.now()}`;
}

export function defaultRegistry() {
  return {
    schemaVersion: 1,
    activeAccountKey: null,
    accounts: [],
  };
}

function normalizeAccount(account) {
  const email = cleanAccountId(account.email);
  const accountKey = cleanAccountId(account.accountKey || account.account_key || email);
  return {
    accountKey,
    email,
    alias: account.alias || '',
    createdAt: account.createdAt || account.created_at || account.created_at_ms || null,
    importedAt: account.importedAt || account.imported_at || account.last_imported_at_ms || null,
    usedAt: account.usedAt || account.used_at || account.last_used_at_ms || null,
    usage: account.usage || account.last_usage || null,
    usageAt: account.usageAt || account.usage_at || account.last_usage_at || null,
  };
}

function cleanAccountId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(/(GEMINI\s+MODELS|CLAUDE\s+AND\s+GPT\s+MODELS).*$/i, '')
    .replace(/GEMINI$/i, '')
    .trim();
  const match = cleaned.match(/^([^\s,]+@[^\s,]+?)(?=GEMINI\s+MODELS|CLAUDE\s+AND\s+GPT\s+MODELS|\s|,|$)/i);
  return match ? match[1] : cleaned;
}

function dedupeAccounts(accounts) {
  const byKey = new Map();
  for (const account of accounts) {
    if (!account.accountKey) continue;
    const previous = byKey.get(account.accountKey);
    byKey.set(account.accountKey, {
      ...previous,
      ...account,
      alias: previous?.alias || account.alias || '',
      createdAt: previous?.createdAt || account.createdAt,
      importedAt: account.importedAt || previous?.importedAt,
      usedAt: account.usedAt || previous?.usedAt,
      usage: account.usage || previous?.usage,
      usageAt: account.usageAt || previous?.usageAt,
    });
  }
  return [...byKey.values()];
}

export async function readRegistry(registryPath = REGISTRY_PATH) {
  try {
    const raw = await fs.readFile(registryPath, 'utf8');
    const registry = JSON.parse(raw);
    const accounts = Array.isArray(registry.accounts)
      ? dedupeAccounts(registry.accounts.map(normalizeAccount).filter(account => account.accountKey))
      : [];
    return {
      ...defaultRegistry(),
      ...registry,
      schemaVersion: registry.schemaVersion || registry.schema_version || 1,
      activeAccountKey: registry.activeAccountKey || registry.active_account_key || null,
      accounts,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return defaultRegistry();
    throw error;
  }
}

export async function writeRegistry(registry, registryPath = REGISTRY_PATH) {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const payload = {
    schema_version: registry.schemaVersion || 1,
    active_account_key: registry.activeAccountKey || null,
    accounts: (registry.accounts || []).map(account => ({
      account_key: account.accountKey,
      email: account.email,
      alias: account.alias || '',
      created_at: account.createdAt || null,
      imported_at: account.importedAt || null,
      last_used_at: account.usedAt || null,
      last_usage: account.usage || null,
      last_usage_at: account.usageAt || null,
    })),
  };
  await fs.writeFile(registryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function upsertAccount(registry, account) {
  const accounts = Array.isArray(registry.accounts) ? registry.accounts : [];
  const index = accounts.findIndex(item => item.accountKey === account.accountKey);
  if (index >= 0) {
    accounts[index] = { ...accounts[index], ...account };
    registry.accounts = accounts;
    return accounts[index];
  }
  accounts.push(account);
  registry.accounts = accounts;
  return account;
}

export function findAccount(registry, query) {
  const accounts = Array.isArray(registry.accounts) ? registry.accounts : [];
  if (!query) {
    const active = accounts.find(item => item.accountKey === registry.activeAccountKey);
    return { account: active || null, matches: active ? [active] : [] };
  }
  const needle = String(query).toLowerCase();
  const matches = accounts.filter(account => (
    String(account.email || '').toLowerCase().includes(needle)
    || String(account.alias || '').toLowerCase().includes(needle)
    || String(account.accountKey || '').toLowerCase().includes(needle)
  ));
  return { account: matches.length === 1 ? matches[0] : null, matches };
}
