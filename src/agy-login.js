import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { detectActiveAccountSince, readAgyLogsSince } from './agy.js';
import { resolveAgyExecutable } from './agy-install.js';
import { spawnAgyForeground, spawnAgyProcess } from './agy-process.js';
import { APP_DIR } from './constants.js';
import { KeyringError, readAgyCredential, writeAgyCredential } from './keyring.js';

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\]([^\x07]*)(\x07|\x1b\\)/g;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const AUTH_CODE_PATTERN = /\b4\/[A-Za-z0-9_-]{20,}\b/;
const GOOGLE_OAUTH_REDIRECT_URI = 'https://antigravity.google/oauth-callback';
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'openid',
];

export async function runAgyLogin(options = {}) {
  const method = normalizeLoginMethod(options.method);
  if (shouldUseDirectLogin(method)) {
    if (method === 'cloud-project') return runDirectCloudProjectLogin(options);
    return runDirectOAuthLogin();
  }
  if (!usePipeLoginMode()) {
    return runForegroundAgyLogin({ method });
  }
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
    let logPoll = null;
    let waitingShown = false;

    const cleanup = () => {
      clearTimeout(timeout);
      rl.close();
      if (credentialPoll) clearInterval(credentialPoll);
      if (logPoll) clearInterval(logPoll);
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

    const startCredentialPolling = ({ announce = true } = {}) => {
      if (announce && !waitingShown) {
        waitingShown = true;
        console.log('Waiting for AGY to write the authenticated credential...');
      }
      if (credentialPoll) return;
      credentialPoll = setInterval(() => {
        finishFromCredential().catch(settle);
      }, 1000);
      finishFromCredential().catch(settle);
    };

    const appendAndParse = data => {
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
    };

    startCredentialPolling({ announce: false });
    logPoll = setInterval(() => {
      readAgyLogsSince(startedAt - 3000)
        .then(logs => {
          if (!logs || settled) return;
          appendAndParse(logs);
          return finishFromCredential();
        })
        .catch(settle);
    }, 1000);

    terminal.onData(appendAndParse);

    terminal.onExit(({ exitCode }) => {
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
      terminal.write('/exit\r');
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
      terminal.write('2\r');
    } else {
      console.log('AGY login method: Google OAuth');
      terminal.write('1\r');
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

  if (!state.codeRequested && isAuthorizationCodePrompt(buffer)) {
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
    terminal.write(`${trimmedCode}\r`);
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

async function runDirectOAuthLogin() {
  const rl = readline.createInterface({ input, output });
  try {
    const oauthConfig = await resolveGoogleOAuthConfig();
    const codeVerifier = base64Url(crypto.randomBytes(64));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    const state = base64Url(crypto.randomBytes(16));
    const authUrl = buildGoogleOAuthUrl({
      clientId: oauthConfig.clientId,
      codeChallenge,
      state,
    });

    console.log('Opening Google OAuth login in your browser...');
    openUrl(authUrl);
    console.log('');
    console.log('If the browser does not open, open this URL:');
    printOAuthUrl(authUrl);
    console.log('');
    console.log('After approving access, paste the authorization code or callback URL here.');
    const answer = await rl.question('Authorization code: ');
    const code = extractOAuthCallbackCode(answer);
    if (!code) throw new Error('Authorization code cannot be empty.');

    const token = await exchangeOAuthCode({ code, codeVerifier, oauthConfig });
    await writeAgyCredential(buildAgyCredential({ token, authMethod: 'consumer' }));

    const email = await resolveTokenEmail(token);
    if (email) {
      console.log(`AGY credential detected for: ${email}`);
    } else {
      console.log('AGY credential detected.');
    }
    console.log('AGY sign-in completed. Saving session...');
    return { ok: true, email };
  } finally {
    rl.close();
  }
}

async function runDirectCloudProjectLogin(options = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    const oauthConfig = await resolveGoogleOAuthConfig();
    const codeVerifier = base64Url(crypto.randomBytes(64));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    const state = base64Url(crypto.randomBytes(16));
    const authUrl = buildGoogleOAuthUrl({
      clientId: oauthConfig.clientId,
      codeChallenge,
      state,
    });

    console.log('Opening Google Cloud project login in your browser...');
    openUrl(authUrl);
    console.log('');
    console.log('If the browser does not open, open this URL:');
    printOAuthUrl(authUrl);
    console.log('');
    console.log('After approving access, paste the authorization code or callback URL here.');
    const answer = await rl.question('Authorization code: ');
    const code = extractOAuthCallbackCode(answer);
    if (!code) throw new Error('Authorization code cannot be empty.');

    const token = await exchangeOAuthCode({ code, codeVerifier, oauthConfig });
    const projectId = await resolveCloudProjectId(options.cloudProject, rl);
    const location = await resolveCloudLocation(options.cloudLocation, rl);
    await writeGcpSettings({ projectId, location });
    acceptCloudTerms();
    await writeAgyCredential(buildAgyCredential({ token, authMethod: 'gcp' }));

    const email = await resolveTokenEmail(token);
    if (email) {
      console.log(`AGY credential detected for: ${email}`);
    } else {
      console.log('AGY credential detected.');
    }
    console.log(`Google Cloud project set to: ${projectId}`);
    console.log(`Google Cloud location set to: ${location}`);
    console.log('AGY sign-in completed. Saving session...');
    return { ok: true, email };
  } finally {
    rl.close();
  }
}

async function resolveCloudProjectId(value, rl) {
  const explicit = String(value || '').trim();
  if (explicit) return explicit;
  const answer = await rl.question('Enter Google Cloud Project ID: ');
  const projectId = answer.trim();
  if (!projectId) throw new Error('Google Cloud project ID cannot be empty.');
  return projectId;
}

async function resolveCloudLocation(value, rl) {
  const explicit = normalizeCloudLocation(value);
  if (explicit) return explicit;
  console.log('');
  console.log('Select Google Cloud Location:');
  console.log('> global');
  console.log('  us');
  console.log('  eu');
  const answer = await rl.question('Google Cloud Location [global]: ');
  return normalizeCloudLocation(answer) || 'global';
}

function normalizeCloudLocation(value) {
  const location = String(value || '').trim().toLowerCase();
  if (!location) return '';
  if (!['global', 'us', 'eu'].includes(location)) {
    throw new Error('Google Cloud location must be one of: global, us, eu.');
  }
  return location;
}

async function writeGcpSettings({ projectId, location }) {
  const settingsPath = path.join(APP_DIR, 'settings.json');
  const settings = await fs.readFile(settingsPath, 'utf8')
    .then(text => JSON.parse(text))
    .catch(error => {
      if (error?.code === 'ENOENT') return {};
      throw error;
    });
  settings.gcp = {
    ...(settings.gcp || {}),
    project: projectId,
    location,
  };
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function acceptCloudTerms() {
  console.log('Terms of Service & Data Use: Done');
}

function buildAgyCredential({ token, authMethod, quotaProjectId = '', projectId = '' }) {
  const credential = {
    token: {
      access_token: token.access_token,
      token_type: token.token_type || 'Bearer',
      refresh_token: token.refresh_token,
      expiry: new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(),
    },
    auth_method: authMethod,
  };
  if (quotaProjectId) credential.quota_project_id = quotaProjectId;
  if (projectId) credential.project_id = projectId;
  return JSON.stringify(credential);
}

function buildGoogleOAuthUrl({ clientId, codeChallenge, state }) {
  if (!clientId) throw new Error('AGY Google OAuth client id was not detected.');
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: clientId,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    state,
  });
  return `https://accounts.google.com/o/oauth2/auth?${params.toString()}`;
}

async function exchangeOAuthCode({ code, codeVerifier, oauthConfig }) {
  let lastError = null;
  for (const clientSecret of oauthConfig.clientSecrets) {
    const body = new URLSearchParams({
      client_id: oauthConfig.clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      if (!payload.access_token || !payload.refresh_token) {
        throw new Error('Google OAuth token response did not include the required AGY tokens.');
      }
      return payload;
    }
    lastError = payload.error_description || payload.error || response.status;
    if (payload.error !== 'invalid_client') break;
  }
  throw new Error(`Google OAuth token exchange failed: ${lastError || 'unknown error'}`);
}

async function resolveTokenEmail(token) {
  const idTokenEmail = extractEmailFromIdToken(token.id_token);
  if (idTokenEmail) return idTokenEmail;
  if (!token.access_token) return '';
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!response.ok) return '';
  const payload = await response.json().catch(() => ({}));
  return typeof payload.email === 'string' ? payload.email : '';
}

export async function resolveGoogleOAuthConfig() {
  const executable = resolveAgyExecutable();
  if (!executable) {
    throw new Error('AGY executable was not found. Install AGY before running `agy-authx login --oauth`.');
  }
  try {
    const binary = await fs.readFile(executable);
    const text = binary.toString('latin1');
    const clientIds = [...new Set(text.match(/\d+-[a-z0-9]+\.apps\.googleusercontent\.com/gi) || [])];
    const clientSecrets = extractGoogleOAuthClientSecrets(text);
    if (!clientIds[0] || !clientSecrets.length) {
      throw new Error(`AGY Google OAuth client config was not detected in ${executable}.`);
    }
    return {
      clientId: clientIds[0],
      clientSecrets,
      source: executable,
    };
  } catch (error) {
    if (error?.message?.includes('AGY Google OAuth client config')) throw error;
    throw new Error(`Failed to read AGY OAuth config from ${executable}: ${error.message}`);
  }
}

function extractGoogleOAuthClientSecrets(text) {
  const secrets = [];
  const matches = [...text.matchAll(/GOCSPX-/g)];
  for (const [index, match] of matches.entries()) {
    const start = match.index;
    let end = start;
    while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end += 1;

    const nextSecretStart = matches[index + 1]?.index;
    if (nextSecretStart && nextSecretStart > start && nextSecretStart < end) end = nextSecretStart;

    const rawCandidate = text.slice(start, end);
    const urlMarker = rawCandidate.search(/https?/);
    const candidate = urlMarker > 0 ? rawCandidate.slice(0, urlMarker) : rawCandidate;
    if (candidate.length >= 20) secrets.push(candidate);
  }
  return [...new Set(secrets.reverse())];
}

export function maskOAuthSecret(value) {
  const text = String(value || '');
  if (text.length <= 12) return '<hidden>';
  return `${text.slice(0, 10)}...${text.slice(-4)}`;
}

function extractEmailFromIdToken(idToken = '') {
  const parts = String(idToken).split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : '';
  } catch {
    return '';
  }
}

function extractOAuthCallbackCode(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.searchParams.get('code') || '';
  } catch {
    const match = trimmed.match(/(?:^|[?&])code=([^&\s]+)/);
    if (match) return decodeURIComponent(match[1]);
    return trimmed;
  }
}

function openUrl(url) {
  if (process.env.AGY_AUTHX_NO_BROWSER && process.env.AGY_AUTHX_NO_BROWSER !== '0') return;
  if (process.platform === 'win32') {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -FilePath $args[0]', url], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function runForegroundAgyLogin({ method }) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const terminal = spawnAgyForeground();
    let settled = false;
    let credentialPoll = null;

    const cleanup = () => {
      clearTimeout(timeout);
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

    if (method === 'cloud-project') console.log('AGY login method: Google Cloud project');
    else console.log('AGY login method: Google OAuth');

    setTimeout(() => {
      if (settled) return;
      terminal.write(loginMethodInput(method));
      terminal.attachInput();
    }, 1000);

    const finishFromCredential = async () => {
      if (settled) return;
      try {
        await readAgyCredential();
      } catch (error) {
        if (error instanceof KeyringError) return;
        throw error;
      }
      const email = await detectActiveAccountSince(startedAt - 3000);
      if (!email) return;
      console.log(`AGY credential detected for: ${email}`);
      console.log('AGY sign-in completed. Saving session...');
      settle(null, { ok: true, email });
    };

    credentialPoll = setInterval(() => {
      finishFromCredential().catch(settle);
    }, 1000);
    finishFromCredential().catch(settle);

    terminal.onExit(({ exitCode }) => {
      if (settled) return;
      if (exitCode === 0) {
        finishFromCredential()
          .then(() => {
            if (!settled) settle(new Error('AGY exited before an authenticated credential was detected.'));
          })
          .catch(settle);
      } else {
        settle(new Error(`AGY login exited with code ${exitCode}.`));
      }
    });
  });
}

function isAuthorizationCodePrompt(buffer) {
  return /paste (the )?authorization code (below|here)/i.test(buffer);
}

function normalizeLoginMethod(method = 'oauth') {
  if (method === 'oauth' || method === 'cloud-project') return method;
  throw new Error(`Unsupported AGY login method: ${method}`);
}

function loginMethodInput(method) {
  return method === 'cloud-project' ? '\x1b[B\r' : '\r';
}

function usePipeLoginMode() {
  return Boolean(process.env.AGY_AUTHX_LOGIN_PIPE && process.env.AGY_AUTHX_LOGIN_PIPE !== '0');
}

function shouldUseDirectLogin(method) {
  if (method === 'cloud-project') return true;
  return method === 'oauth' && !usePipeLoginMode() && !process.env.AGY_AUTHX_LOGIN_FOREGROUND;
}

function formatTerminalLink(url, label) {
  if (!process.stdout.isTTY) return url;
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

function printOAuthUrl(url) {
  console.log(url);
  if (process.stdout.isTTY) console.log(formatTerminalLink(url, 'Open AGY OAuth login'));
}

export const internals = {
  cleanTerminal,
  acceptCloudTerms,
  buildAgyCredential,
  buildGoogleOAuthUrl,
  extractEmailFromIdToken,
  extractAuthorizationCode,
  extractGoogleAuthUrl,
  extractGoogleOAuthClientSecrets,
  extractOAuthCallbackCode,
  extractUrlFromOscPayload,
  exchangeOAuthCode,
  formatTerminalLink,
  extractSignedInEmail,
  isAuthorizationCodePrompt,
  isSignedIn,
  loginMethodInput,
  maskOAuthSecret,
  normalizeLoginMethod,
  normalizeCloudLocation,
  printOAuthUrl,
  readAgyAccount,
  resolveCloudProjectId,
  resolveAgyExecutable,
  resolveGoogleOAuthConfig,
  shouldUseDirectLogin,
  usePipeLoginMode,
  writeGcpSettings,
};
