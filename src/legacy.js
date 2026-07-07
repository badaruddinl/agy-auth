import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const LEGACY_PACKAGE = '@badaruddinl/agy-auth';
export const AUTHX_PACKAGE = '@badaruddinl/agy-authx';
export const MAX_MANAGED_LEGACY_VERSION = '0.1.21';

const execFileAsync = promisify(execFile);

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function defaultRunner(command, args) {
  const result = await execFileAsync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function normalizeAction(action = 'status') {
  if (action === 'enable') return 'enabled';
  if (action === 'disable') return 'disabled';
  if (['status', 'enabled', 'disabled'].includes(action)) return action;
  throw new Error('Usage: agy-authx legacy <status|enabled|disabled>');
}

function parseVersion(value = '') {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft[index] > parsedRight[index]) return 1;
    if (parsedLeft[index] < parsedRight[index]) return -1;
  }
  return 0;
}

function isManagedLegacyVersion(version) {
  const comparison = compareVersions(version, MAX_MANAGED_LEGACY_VERSION);
  return comparison !== null && comparison <= 0;
}

function parseGlobalPackage(text, packageName = LEGACY_PACKAGE) {
  const payload = JSON.parse(text || '{}');
  const item = payload.dependencies?.[packageName];
  if (!item) {
    return {
      installed: false,
      packageName,
      version: '',
      managedBridge: false,
    };
  }

  const version = item.version || '';
  return {
    installed: true,
    packageName,
    version,
    managedBridge: isManagedLegacyVersion(version),
    invalid: Boolean(item.invalid),
    problems: item.problems || [],
  };
}

async function readLegacyBridge(runner = defaultRunner) {
  try {
    const result = await runner(npmCommand(), ['ls', '-g', LEGACY_PACKAGE, '--depth=0', '--json']);
    return parseGlobalPackage(result.stdout, LEGACY_PACKAGE);
  } catch (error) {
    if (error?.stdout) return parseGlobalPackage(error.stdout, LEGACY_PACKAGE);
    return {
      installed: false,
      packageName: LEGACY_PACKAGE,
      version: '',
      managedBridge: false,
    };
  }
}

function assertManagedLegacyBridge(legacy) {
  if (!legacy.installed) return;
  if (isManagedLegacyVersion(legacy.version)) return;
  throw new Error(
    `Refusing to modify ${LEGACY_PACKAGE}@${legacy.version}. `
    + `Only ${LEGACY_PACKAGE} versions <= ${MAX_MANAGED_LEGACY_VERSION} are managed by this command.`,
  );
}

async function uninstallLegacyBridge(runner = defaultRunner) {
  return runner(npmCommand(), ['uninstall', '-g', LEGACY_PACKAGE]);
}

async function installLegacyBridge(runner = defaultRunner) {
  return runner(npmCommand(), ['install', '-g', LEGACY_PACKAGE]);
}

function printLegacyResult(payload, jsonMode, output = console.log) {
  if (jsonMode) {
    output(JSON.stringify(payload, null, 2));
    return;
  }

  if (payload.action === 'status') {
    output(`legacy bridge: ${payload.installed ? `${payload.packageName}@${payload.version}` : 'not installed'}`);
    output(`managed      : ${payload.managedBridge ? 'yes' : 'no'}`);
    output(`agy-auth cmd : provided by ${LEGACY_PACKAGE} when installed globally`);
    return;
  }

  if (payload.action === 'disabled') {
    if (payload.removed) output(`removed ${LEGACY_PACKAGE}@${payload.version}`);
    else output(`no managed ${LEGACY_PACKAGE} bridge is installed`);
    output(`agy-auth cmd is disabled; use agy-authx directly`);
    return;
  }

  if (payload.action === 'enabled') {
    if (payload.removed) output(`removed ${LEGACY_PACKAGE}@${payload.version}`);
    output(`installed ${LEGACY_PACKAGE}`);
    output('agy-auth cmd is enabled through the bridge package');
  }
}

export async function runLegacyCommand(args, options = {}) {
  const action = normalizeAction(args[0] || 'status');
  const jsonMode = Boolean(options.jsonMode);
  const runner = options.runner || defaultRunner;
  const output = options.output || console.log;
  const authxVersion = options.authxVersion || '0.0.0';
  const legacy = await readLegacyBridge(runner);
  assertManagedLegacyBridge(legacy);

  const payload = {
    ok: true,
    action,
    packageName: LEGACY_PACKAGE,
    maxManagedLegacyVersion: MAX_MANAGED_LEGACY_VERSION,
    authxPackage: AUTHX_PACKAGE,
    authxVersion,
    installed: legacy.installed,
    version: legacy.version || null,
    managedBridge: legacy.managedBridge,
    removed: false,
    installedLegacyBridge: false,
  };

  if (action === 'disabled' && legacy.installed) {
    await uninstallLegacyBridge(runner);
    payload.removed = true;
  }

  if (action === 'enabled') {
    if (legacy.installed) {
      await uninstallLegacyBridge(runner);
      payload.removed = true;
    }
    await installLegacyBridge(runner);
    payload.installedLegacyBridge = true;
  }

  printLegacyResult(payload, jsonMode, output);
  return 0;
}

export const internals = {
  assertManagedLegacyBridge,
  compareVersions,
  installLegacyBridge,
  isManagedLegacyVersion,
  normalizeAction,
  npmCommand,
  parseGlobalPackage,
  parseVersion,
  printLegacyResult,
  readLegacyBridge,
  uninstallLegacyBridge,
};
