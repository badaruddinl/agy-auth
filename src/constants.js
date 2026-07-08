import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.28';
export const AGY_SERVICE = process.env.AGY_AUTH_TARGET_SERVICE || 'gemini:antigravity';
export const AGY_ACCOUNT = process.env.AGY_AUTH_TARGET_ACCOUNT || 'antigravity';
export const SNAPSHOT_SERVICE = process.env.AGY_AUTH_SNAPSHOT_SERVICE || 'agy-auth';
export const APP_DIR = process.env.AGY_AUTH_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli');
export const REGISTRY_PATH = path.join(APP_DIR, 'accounts', 'registry.json');
export const LOG_DIR = path.join(APP_DIR, 'log');
export const CLI_LOG = path.join(APP_DIR, 'cli.log');
