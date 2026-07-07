import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { detectActiveAccountSince } from './agy.js';
import { spawnAgyProcess } from './agy-process.js';
import { KeyringError, readAgyCredential } from './keyring.js';

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\]([^\x07]*)(\x07|\x1b\\)/g;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const AUTH_CODE_PATTERN = /\b4\/[A-Za-z0-9_-]{20,}\b/;

export async function runAgyLogin(options = {}) {
  const method = normalizeLoginMethod(options.method);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const terminal = spawnAgyProcess();
    const rl = readline.createInterface({ input, output });
    let buffer = '';
    let methodSelected = false;
    let urlShown = false;
    let codeRequested = false;
    let exitSent = false;
    let settled = false;
    let signedInEmail = '';
    let credentialPoll = null;
    let waitingShown = false;

    const cleanup = () => {
      rl.close();
      if (credentialPoll) clearInterval(credentialPoll);
      try {
        terminal.kill();
      } catch {
        // Process may already be closed.
      }
    };

    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    const timeout = setTimeout(() => {
      settle(new Error('AGY login timed out before completing authentication.'));
    }, 10 * 60 * 1000);

    const finishFromCredential = async () => {
      if (settled) return;
      let currentSecret = '';
      try {
        currentSecret = await readAgyCredential();
      } catch (error) {
        if (error instanceof KeyringError) return;
        throw error;
      }
      const email = await detectActiveAccountSince(startedAt - 3000)
        || signedInEmail
        || extractSignedInEmail(buffer);
      if (!email) return;
      signedInEmail = email;
      console.log(`AGY credential detected for: ${email}`);
      console.log('AGY sign-in completed. Saving session...');
      settle(null, { ok: true, email });
    };

    const startCredentialPolling = () => {
      if (credentialPoll) return;
      if (!waitingShown) {
        waitingShown = true;
        console.log('Waiting for AGY to write the authenticated credential...');
      }
      credentialPoll = setInterval(() => {
        finishFromCredential().catch(settle);
      }, 1000);
      finishFromCredential().catch(settle);
    };

    terminal.onData(data => {
      buffer = `${buffer}${cleanTerminal(data)}`.slice(-20000);
      parseLoginOutput({
        buffer,
        terminal,
        rl,
        method,
        startCredentialPolling,
        state: {
          get methodSelected() { return methodSelected; },
          set methodSelected(value) { methodSelected = value; },
          get urlShown() { return urlShown; },
          set urlShown(value) { urlShown = value; },
          get codeRequested() { return codeRequested; },
          set codeRequested(value) { codeRequested = value; },
          get exitSent() { return exitSent; },
          set exitSent(value) { exitSent = value; },
          get signedInEmail() { return signedInEmail; },
          set signedInEmail(value) { signedInEmail = value; },
        },
      }).catch(settle);
    });

    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0) {
        settle(null, { ok: true, email: signedInEmail || extractSignedInEmail(buffer) });
      } else {
        settle(new Error(`AGY login exited with code ${exitCode}.`));
      }
    });
  });
}

export function readAgyAccount({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const terminal = spawnAgyProcess();
    let buffer = '';
    let exitSent = false;
    let settled = false;
    let exited = false;

    const cleanup = ({ kill = true } = {}) => {
      clearTimeout(timer);
      if (!kill) return;
      setTimeout(() => {
        if (exited) return;
        try {
          terminal.kill();
        } catch {
          // Process may already be closed.
        }
      }, 250);
    };

    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup({ kill: true });
      if (error) reject(error);
      else resolve(result);
    };

    const requestExit = () => {
      if (exitSent) return;
      exitSent = true;
      terminal.write('/exit\n');
    };

    const timer = setTimeout(() => {
      const email = extractSignedInEmail(buffer);
      if (email) settle(null, { email, output: cleanTerminal(buffer) });
      else settle(new Error('Timed out waiting for AGY account email.'));
    }, timeoutMs);

    terminal.onData(data => {
      buffer = `${buffer}${cleanTerminal(data)}`.slice(-20000);
      const email = extractSignedInEmail(buffer);
      if (email && isSignedIn(buffer)) {
        requestExit();
        setTimeout(() => settle(null, { email, output: cleanTerminal(buffer) }), 750);
      }
    });

    terminal.onExit(({ exitCode }) => {
      exited = true;
      const email = extractSignedInEmail(buffer);
      if (email) settle(null, { email, output: cleanTerminal(buffer), exitCode });
      else if (exitCode === 0) settle(null, { email: '', output: cleanTerminal(buffer), exitCode });
      else settle(new Error(`AGY exited with code ${exitCode} before an account email was detected.`));
    });
  });
}

async function parseLoginOutput({ buffer, terminal, rl, method, startCredentialPolling, state }) {
  if (!state.methodSelected && /Select login method/i.test(buffer)) {
    state.methodSelected = true;
    if (method === 'cloud-project') {
      console.log('AGY login method: Google Cloud project');
      terminal.write('2\n');
    } else {
      console.log('AGY login method: Google OAuth');
      terminal.write('1\n');
    }
  }

  if (!state.urlShown) {
    const url = extractGoogleAuthUrl(buffer);
    if (url) {
      state.urlShown = true;
      console.log('');
      console.log('Open this URL in your browser to authorize AGY:');
      console.log(formatTerminalLink(url, 'Open AGY OAuth login'));
      console.log(`Full URL: ${url}`);
      console.log('');
    }
  }

  if (!state.codeRequested && /paste the authorization code below/i.test(buffer)) {
    state.codeRequested = true;
    const detectedCode = extractAuthorizationCode(buffer);
    if (detectedCode) {
      console.log(`Authorization code detected: ${detectedCode}`);
    } else {
      console.log('Copy the authorization code from the browser callback page, then paste it here.');
    }
    const code = await rl.question('Authorization code: ');
    const trimmedCode = code.trim();
    if (trimmedCode) console.log(`Authorization code submitted: ${trimmedCode}`);
    terminal.write(`${trimmedCode}\n`);
    startCredentialPolling();
  }

  const email = extractSignedInEmail(buffer);
  if (email) state.signedInEmail = email;

  if (!state.exitSent && isSignedIn(buffer)) {
    state.exitSent = true;
    startCredentialPolling();
  }
}

function cleanTerminal(value) {
  return String(value || '')
    .replace(OSC_PATTERN, (_match, payload) => extractUrlFromOscPayload(payload))
    .replace(ANSI_PATTERN, '')
    .replace(/\r/g, '');
}

function extractUrlFromOscPayload(payload) {
  const match = String(payload || '').match(/https:\/\/accounts\.google\.com\/[^\s;\x1b\x07]*/i);
  return match ? `\n${match[0]}\n` : '';
}

function extractGoogleAuthUrl(buffer) {
  const direct = String(buffer || '').match(/^https:\/\/accounts\.google\.com\/\S+$/im);
  if (direct) return direct[0];
  const compactBuffer = String(buffer || '').replace(/\s+/g, '');
  const start = compactBuffer.indexOf('https://accounts.google.com/');
  if (start < 0) return '';
  const tail = compactBuffer.slice(start);
  const stop = findFirstUrlStop(tail);
  return tail.slice(0, stop);
}

function findFirstUrlStop(value) {
  const candidates = [
    value.indexOf('Ifyouaren'),
    value.indexOf('paste'),
    value.indexOf('Authorizationcode'),
  ].filter(index => index > 0);
  return candidates.length ? Math.min(...candidates) : value.length;
}

function isSignedIn(buffer) {
  return Boolean(extractSignedInEmail(buffer))
    && /Antigravity CLI/i.test(buffer)
    && /Gemini/i.test(buffer)
    && !/authorization code\.\.\./i.test(buffer);
}

function extractSignedInEmail(buffer) {
  const matches = [...String(buffer || '').matchAll(new RegExp(EMAIL_PATTERN, 'gi'))]
    .map(match => match[0])
    .filter(email => !/googleusercontent\.com$/i.test(email));
  return matches.at(-1) || '';
}

function extractAuthorizationCode(buffer) {
  const match = String(buffer || '').match(AUTH_CODE_PATTERN);
  return match ? match[0] : '';
}

function normalizeLoginMethod(method = 'oauth') {
  if (method === 'oauth' || method === 'cloud-project') return method;
  throw new Error(`Unsupported AGY login method: ${method}`);
}

function formatTerminalLink(url, label) {
  if (!process.stdout.isTTY) return url;
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

export const internals = {
  cleanTerminal,
  extractAuthorizationCode,
  extractGoogleAuthUrl,
  extractUrlFromOscPayload,
  formatTerminalLink,
  extractSignedInEmail,
  isSignedIn,
  normalizeLoginMethod,
  readAgyAccount,
};
