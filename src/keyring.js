import keytar from 'keytar';
import { spawnSync } from 'node:child_process';
import { AGY_ACCOUNT, AGY_SERVICE, SNAPSHOT_SERVICE } from './constants.js';
import { writeWindowsGenericCredential } from './windows-keyring.js';

export class KeyringError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyringError';
  }
}

export async function readAgyCredential() {
  const password = await getPasswordWithFindFallback(AGY_SERVICE, AGY_ACCOUNT);
  if (!password) {
    throw new KeyringError(`Credential not found: service=${AGY_SERVICE}, account=${AGY_ACCOUNT}`);
  }
  return password;
}

export async function writeAgyCredential(secret) {
  if (!secret) {
    throw new KeyringError('Refusing to write an empty AGY credential.');
  }
  if (process.platform === 'win32') {
    writeWindowsGenericCredential(AGY_SERVICE, AGY_ACCOUNT, secret);
    return;
  }
  await keytar.setPassword(AGY_SERVICE, AGY_ACCOUNT, secret);
}

export async function deleteAgyCredential() {
  if (process.platform === 'win32') {
    const result = await keytar.deletePassword(AGY_SERVICE, AGY_ACCOUNT);
    if (result) return true;
    return deleteWindowsGenericCredential(AGY_SERVICE);
  }
  return keytar.deletePassword(AGY_SERVICE, AGY_ACCOUNT);
}

export async function saveSnapshot(accountKey, secret) {
  if (!accountKey) {
    throw new KeyringError('Snapshot account key is required.');
  }
  if (!secret) {
    throw new KeyringError('Refusing to save an empty snapshot credential.');
  }
  await keytar.setPassword(SNAPSHOT_SERVICE, accountKey, secret);
}

export async function readSnapshot(accountKey) {
  const secret = await getPasswordWithFindFallback(SNAPSHOT_SERVICE, accountKey);
  if (!secret) {
    throw new KeyringError(`Snapshot credential not found for ${accountKey}.`);
  }
  return secret;
}

export async function deleteSnapshot(accountKey) {
  return keytar.deletePassword(SNAPSHOT_SERVICE, accountKey);
}

export async function listNativeAgyCredentials() {
  return keytar.findCredentials(AGY_SERVICE);
}

export async function listSnapshots() {
  return keytar.findCredentials(SNAPSHOT_SERVICE);
}

async function getPasswordWithFindFallback(service, account) {
  const direct = await keytar.getPassword(service, account);
  if (direct) return direct;
  const credentials = await keytar.findCredentials(service);
  return credentials.find(item => item.account === account)?.password || null;
}

function deleteWindowsGenericCredential(targetName) {
  const result = spawnCmdkeyDelete(targetName);
  if (result.status === 0) return true;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /not found|cannot find|Element not found/i.test(output);
}

function spawnCmdkeyDelete(targetName) {
  return spawnSync('cmdkey.exe', [`/delete:${targetName}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
}
