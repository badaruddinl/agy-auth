import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

const WINDOWS_INSTALL_URL = 'https://antigravity.google/cli/install.ps1';
const UNIX_INSTALL_URL = 'https://antigravity.google/cli/install.sh';

export function resolveAgyExecutable() {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, ['agy'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';
}

export function readAgyVersion() {
  const executable = resolveAgyExecutable();
  if (!executable) return '';
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  return String(result.stdout || result.stderr || '').trim();
}

export function getAgyInstallCommand({ shell = defaultInstallShell() } = {}) {
  if (process.platform === 'win32') {
    if (shell === 'cmd') {
      return `curl -fsSL ${WINDOWS_INSTALL_URL.replace(/\.ps1$/, '.cmd')} -o install.cmd && install.cmd && del install.cmd`;
    }
    return `irm ${WINDOWS_INSTALL_URL} | iex`;
  }
  return `curl -fsSL ${UNIX_INSTALL_URL} | bash`;
}

export function getAgyInstallInstructions() {
  const command = getAgyInstallCommand();
  const pathHint = process.platform === 'win32'
    ? '%LOCALAPPDATA%\\agy\\bin'
    : '$HOME/.local/bin';
  return {
    command,
    pathHint,
    docsUrl: 'https://antigravity.google/docs/cli-install',
  };
}

export function getAgyStatus() {
  const path = resolveAgyExecutable();
  return {
    installed: Boolean(path),
    path,
    version: path ? readAgyVersion() : '',
    platform: `${process.platform}/${os.arch()}`,
    install: getAgyInstallInstructions(),
  };
}

export async function installAgy({ output = console.log } = {}) {
  if (resolveAgyExecutable()) {
    return {
      ok: true,
      alreadyInstalled: true,
      path: resolveAgyExecutable(),
      version: readAgyVersion(),
    };
  }

  output('Installing AGY CLI using the official Google Antigravity installer...');
  output(`Installer: ${process.platform === 'win32' ? WINDOWS_INSTALL_URL : UNIX_INSTALL_URL}`);

  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${WINDOWS_INSTALL_URL} | iex`], {
      stdio: 'inherit',
      windowsHide: false,
    })
    : spawn('bash', ['-lc', `curl -fsSL ${UNIX_INSTALL_URL} | bash`], {
      stdio: 'inherit',
    });

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });

  const path = resolveAgyExecutable();
  return {
    ok: exitCode === 0 && Boolean(path),
    exitCode,
    path,
    version: path ? readAgyVersion() : '',
    alreadyInstalled: false,
  };
}

function defaultInstallShell() {
  if (process.platform !== 'win32') return 'sh';
  return process.env.ComSpec?.toLowerCase().includes('cmd.exe') ? 'cmd' : 'powershell';
}
