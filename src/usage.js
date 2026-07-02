import pty from '@homebridge/node-pty-prebuilt-multiarch';

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

export function readUsageFromAgy({ timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'agy.exe' : 'agy';
    const args = [];
    const term = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    let output = '';
    let sentUsage = false;
    let sentExit = false;
    let settled = false;
    let exited = false;
    let sendScheduled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (!sentExit) term.write('/exit\r');
      } catch {
        // best effort
      }
      setTimeout(() => {
        if (exited) return;
        try {
          term.kill();
        } catch {
          // best effort
        }
      }, 250);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error('Timed out waiting for AGY /usage output.'));
    }, timeoutMs);

    const sendUsage = () => {
      if (sentUsage) return;
      sentUsage = true;
      term.write('/usage\r');
    };

    const scheduleUsage = (delayMs = 1000) => {
      if (sentUsage || sendScheduled) return;
      sendScheduled = true;
      setTimeout(() => {
        sendScheduled = false;
        sendUsage();
      }, delayMs);
    };

    const maybeFinish = () => {
      const clean = stripTerminal(output);
      if (/GEMINI\s+MODELS/i.test(clean) && /CLAUDE\s+AND\s+GPT\s+MODELS/i.test(clean)) {
        if (!sentExit) {
          sentExit = true;
          term.write('/exit\r');
        }
        setTimeout(() => finish(null, parseUsageOutput(clean)), 750);
      }
    };

    term.onData(data => {
      output += data;
      if (!sentUsage && /for shortcuts/i.test(stripTerminal(output))) {
        scheduleUsage(1000);
      }
      maybeFinish();
    });

    term.onExit(({ exitCode }) => {
      exited = true;
      if (!settled && sentUsage) {
        const parsed = parseUsageOutput(output);
        if (parsed.available) finish(null, parsed);
        else finish(new Error(`AGY exited before usage was parsed (exit ${exitCode}).`));
      }
    });

    setTimeout(() => scheduleUsage(0), 6000);
  });
}
