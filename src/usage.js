import fs from 'node:fs/promises';
import http2 from 'node:http2';
import { CLI_LOG, LOG_DIR } from './constants.js';
import { detectActiveAccount } from './agy.js';
import { spawnAgyProcess } from './agy-process.js';

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

export function stripTerminal(text) {
  return String(text || '')
    .replace(ANSI_PATTERN, '')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function sliceBlock(text, startMarker, endMarker) {
  const start = text.search(new RegExp(startMarker, 'i'));
  if (start < 0) return '';
  const rest = text.slice(start);
  if (!endMarker) return rest;
  const afterMarker = rest.slice(startMarker.length);
  const end = afterMarker.search(new RegExp(endMarker, 'i'));
  return end < 0 ? rest : rest.slice(0, startMarker.length + end);
}

function parseLimit(block) {
  const percentMatch = block.match(/(\d{1,3})%\s+remaining/i);
  const refreshMatch = block.match(/Refreshes\s+in\s+([^\n]+)/i);
  if (/Quota available/i.test(block) && !percentMatch) {
    return { remainingPercent: 100, refreshesIn: '' };
  }
  return {
    remainingPercent: percentMatch ? Number(percentMatch[1]) : null,
    refreshesIn: refreshMatch ? refreshMatch[1].trim() : '',
  };
}

function parseGroup(text, name, startMarker, endMarker) {
  const block = sliceBlock(text, startMarker, endMarker);
  if (!block) return null;
  const modelsMatch = block.match(/Models within this group:\s*([^\n]+)/i);
  const weeklyBlock = sliceBlock(block, 'Weekly Limit', 'Five Hour Limit');
  const fiveHourBlock = sliceBlock(block, 'Five Hour Limit');
  return {
    name,
    models: modelsMatch ? modelsMatch[1].trim() : '',
    weekly: parseLimit(weeklyBlock),
    fiveHour: parseLimit(fiveHourBlock),
  };
}

export function parseUsageOutput(output) {
  const text = stripTerminal(output);
  const accountMatch = text.match(/Account:\s*([^\s,]+@[^\s,]+?)(?=GEMINI\s+MODELS|CLAUDE\s+AND\s+GPT\s+MODELS|\s|,|$)/i);
  const groups = [
    parseGroup(text, 'Gemini Models', 'GEMINI MODELS', 'CLAUDE AND GPT MODELS'),
    parseGroup(text, 'Claude And Gpt Models', 'CLAUDE AND GPT MODELS'),
  ].filter(Boolean);
  return {
    available: groups.length > 0,
    accountEmail: accountMatch ? accountMatch[1].trim() : null,
    groups,
    capturedAt: new Date().toISOString(),
    error: groups.length > 0 ? '' : 'Unable to parse AGY usage output.',
  };
}

export async function readUsageFromAgy({ timeoutMs = 30000 } = {}) {
  const startedAt = Date.now();
  const logSnapshot = await snapshotAgyLogs();
  const backend = spawnAgyProcess([], {
    env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
  });

  try {
    const { usage, errors } = await waitForQuotaSummary(logSnapshot, Math.max(timeoutMs, 45000));
    if (usage) return usage;
    const detail = errors.length ? ` Tried AGY ports: ${errors.join('; ')}` : '';
    throw new Error(`Unable to read AGY quota summary from the local AGY backend.${detail}`);
  } finally {
    try {
      backend.kill();
    } catch {
      // best effort
    }
  }
}

async function waitForQuotaSummary(logSnapshot, timeoutMs) {
  const startedAt = Date.now();
  const errors = [];
  while (Date.now() - startedAt < timeoutMs) {
    const ports = await findAgyGrpcPorts(logSnapshot);
    for (const port of ports) {
      try {
        const payload = await readQuotaSummaryFromPort(port, Math.min(5000, timeoutMs));
        const usage = parseQuotaSummary(payload, new Date().toISOString());
        if (usage.available) {
          usage.accountEmail = await detectActiveAccount();
          return { usage, errors };
        }
        errors.push(`${port}: empty parsed quota`);
      } catch (error) {
        errors.push(`${port}: ${error.message}`);
      }
    }
    await delay(500);
  }
  return { usage: null, errors: [...new Set(errors)].slice(-12) };
}

async function findAgyGrpcPorts(logSnapshot) {
  const envPort = Number(process.env.AGY_AUTHX_AGY_GRPC_PORT || '');
  if (Number.isInteger(envPort) && envPort > 0) return [envPort];

  const candidates = [];
  const logs = await readAgyLogsAfterSnapshot(logSnapshot);
  for (const match of logs.matchAll(/port at\s+(\d+)\s+for HTTPS \(gRPC\)/gi)) {
    candidates.push(Number(match[1]));
  }
  if (candidates.length === 0) {
    const fallbackLogs = await readRecentAgyLogs();
    for (const match of fallbackLogs.matchAll(/port at\s+(\d+)\s+for HTTPS \(gRPC\)/gi)) {
      candidates.push(Number(match[1]));
    }
  }
  return [...new Set(candidates.reverse().filter(port => Number.isInteger(port) && port > 0))].slice(0, 8);
}

async function snapshotAgyLogs() {
  const files = new Map();
  await snapshotFile(files, CLI_LOG);
  try {
    const entries = await fs.readdir(LOG_DIR, { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.isFile() && /^cli-.*\.log$/i.test(entry.name))
      .map(entry => snapshotFile(files, `${LOG_DIR}/${entry.name}`)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { files, startedAt: Date.now() - 1000 };
}

async function snapshotFile(files, filePath) {
  try {
    const stat = await fs.stat(filePath);
    files.set(filePath, stat.size);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readAgyLogsAfterSnapshot(snapshot) {
  const chunks = [];
  const files = new Set(snapshot.files.keys());
  try {
    const entries = await fs.readdir(LOG_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /^cli-.*\.log$/i.test(entry.name)) files.add(`${LOG_DIR}/${entry.name}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  files.add(CLI_LOG);

  for (const file of files) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const offset = snapshot.files.get(file) || 0;
      const offsetText = raw.slice(raw.length < offset ? 0 : offset);
      const timeText = raw
        .split(/\r?\n/)
        .filter(line => isRecentAgyLogLine(line, snapshot.startedAt))
        .join('\n');
      chunks.push(offsetText, timeText);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return chunks.join('\n');
}

function isRecentAgyLogLine(line, sinceMs) {
  const match = String(line || '').match(/^[IWEF](\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
  if (!match) return false;
  const now = new Date();
  const [, month, day, hour, minute, second, fraction] = match;
  const date = new Date(
    now.getFullYear(),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(String(fraction).slice(0, 3).padEnd(3, '0')),
  );
  return date.getTime() >= sinceMs;
}

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function readRecentAgyLogs() {
  const files = [CLI_LOG];
  try {
    const entries = await fs.readdir(LOG_DIR, { withFileTypes: true });
    const logFiles = (await Promise.all(entries
      .filter(entry => entry.isFile() && /^cli-.*\.log$/i.test(entry.name))
      .map(async entry => {
        const filePath = `${LOG_DIR}/${entry.name}`;
        const stat = await fs.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      })))
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(-10)
      .map(item => item.filePath);
    files.push(...logFiles);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const chunks = [];
  for (const file of files) {
    try {
      chunks.push(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return chunks.join('\n');
}

function readQuotaSummaryFromPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const chunks = [];
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        // best effort
      }
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error('timed out'));
    }, timeoutMs);

    client.on('error', error => finish(error));
    const request = client.request({
      ':method': 'POST',
      ':path': '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    request.on('response', headers => {
      if (headers[':status'] !== 200) {
        finish(new Error(`HTTP ${headers[':status'] || 'unknown'}`));
      }
    });
    request.on('data', chunk => chunks.push(chunk));
    request.on('error', error => finish(error));
    request.on('end', () => {
      try {
        const messages = decodeGrpcMessages(Buffer.concat(chunks));
        if (messages.length === 0) throw new Error('empty quota response');
        finish(null, messages.at(-1));
      } catch (error) {
        finish(error);
      }
    });
    request.end(Buffer.from([0, 0, 0, 0, 0]));
  });
}

function decodeGrpcMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const compressed = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    offset += 5;
    if (compressed) throw new Error('compressed quota response is not supported');
    if (offset + length > buffer.length) throw new Error('truncated quota response');
    messages.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  return messages;
}

function parseQuotaSummary(message, capturedAt) {
  const root = parseProtoFields(message);
  const summary = bytesField(root, 1);
  const groups = parseProtoFields(summary)
    .filter(field => field.field === 2 && field.wireType === 2)
    .map(field => parseQuotaGroup(field.value, capturedAt))
    .filter(Boolean);
  return {
    available: groups.length > 0,
    accountEmail: null,
    groups,
    capturedAt,
    error: groups.length > 0 ? '' : 'Unable to parse AGY quota summary.',
  };
}

function parseQuotaGroup(buffer, capturedAt) {
  const fields = parseProtoFields(buffer);
  const name = textField(fields, 2);
  if (!name) return null;
  const limits = fields
    .filter(field => field.field === 1 && field.wireType === 2)
    .map(field => parseQuotaLimit(field.value, capturedAt));
  return {
    name: normalizeGroupName(name),
    models: stripModelsPrefix(textField(fields, 3)),
    weekly: limits.find(limit => limit.key === 'weekly') || emptyLimit(),
    fiveHour: limits.find(limit => limit.key === '5h') || emptyLimit(),
  };
}

function parseQuotaLimit(buffer, capturedAt) {
  const fields = parseProtoFields(buffer);
  const fraction = fixed32Field(fields, 4);
  const resetSeconds = varintField(parseProtoFields(bytesField(fields, 6)), 1);
  const remainingPercent = Number.isFinite(fraction) ? Math.round(fraction * 100) : null;
  return {
    key: textField(fields, 3),
    remainingPercent,
    refreshesIn: remainingPercent >= 100 ? '' : formatDurationUntil(resetSeconds, capturedAt),
  };
}

function parseProtoFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const field = tag.value >> 3;
    const wireType = tag.value & 7;
    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      fields.push({ field, wireType, value: value.value });
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + length.value) });
      offset += length.value;
    } else if (wireType === 5) {
      fields.push({ field, wireType, value: buffer.readFloatLE(offset) });
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    value += (byte & 0x7f) * (2 ** shift);
    offset += 1;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error('truncated protobuf varint');
}

function bytesField(fields, field) {
  return fields.find(item => item.field === field && item.wireType === 2)?.value || Buffer.alloc(0);
}

function textField(fields, field) {
  return bytesField(fields, field).toString('utf8');
}

function fixed32Field(fields, field) {
  const item = fields.find(entry => entry.field === field && entry.wireType === 5);
  return item ? item.value : null;
}

function varintField(fields, field) {
  const item = fields.find(entry => entry.field === field && entry.wireType === 0);
  return item ? item.value : null;
}

function normalizeGroupName(name) {
  return /claude|gpt/i.test(name) ? 'Claude And Gpt Models' : name;
}

function stripModelsPrefix(value) {
  return String(value || '').replace(/^Models within this group:\s*/i, '').trim();
}

function emptyLimit() {
  return { remainingPercent: null, refreshesIn: '' };
}

function formatDurationUntil(seconds, capturedAt) {
  if (!Number.isFinite(seconds)) return '';
  const base = new Date(capturedAt).getTime();
  const target = seconds * 1000;
  const minutes = Math.max(0, Math.round((target - base) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours > 0 && rest > 0) return `${hours}h ${rest}m`;
  if (hours > 0) return `${hours}h`;
  return `${rest}m`;
}

export const internals = {
  decodeGrpcMessages,
  formatDurationUntil,
  parseProtoFields,
  parseQuotaSummary,
};
