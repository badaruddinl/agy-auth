import fs from 'node:fs/promises';
import { CLI_LOG, LOG_DIR } from './constants.js';

const EMAIL_PATTERN = /applyAuthResult:\s*email=([^\s,]+@[^\s,]+)|OAuth:\s*authenticated successfully as\s*([^\s,]+@[^\s,]+)|authenticated successfully as\s*([^\s,]+@[^\s,]+)/gi;

export function extractAccountEmail(text) {
  let latest = null;
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    latest = (match[1] || match[2] || match[3]).trim();
  }
  return latest;
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export async function detectActiveAccount() {
  return detectActiveAccountSince(0);
}

export async function detectActiveAccountSince(sinceMs = 0) {
  const chunks = [];
  await pushLogIfRecent(chunks, CLI_LOG, sinceMs);
  try {
    const entries = await fs.readdir(LOG_DIR, { withFileTypes: true });
    const logFiles = (await Promise.all(entries
      .filter(entry => entry.isFile() && /^cli-.*\.log$/i.test(entry.name))
      .map(entry => `${LOG_DIR}/${entry.name}`)
      .map(async filePath => ({
        filePath,
        stat: await statIfExists(filePath),
      }))))
      .filter(item => item.stat && item.stat.mtimeMs >= sinceMs)
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
      .map(item => item.filePath)
      .slice(-20);
    const logs = await Promise.all(logFiles.map(readIfExists));
    chunks.push(...logs);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return extractAccountEmail(chunks.join('\n'));
}

async function pushLogIfRecent(chunks, filePath, sinceMs) {
  const stat = await statIfExists(filePath);
  if (!stat || stat.mtimeMs < sinceMs) return;
  chunks.push(await readIfExists(filePath));
}

async function statIfExists(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
