import {
  closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const INTENT = 'opencode-v2-intent.json';
const ACTIVE = 'opencode-v2-active.json';
const LOCK = '.opencode-v2-promotion.lock';
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const EMPTY_LOCK_STALE_MS = 500;

function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
}

function record(value: unknown): object | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function markerPath(directory: string, name: string): string {
  return join(directory, name);
}

function validateMarker(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile()) throw new Error(`${path} must be a regular file`);
  return true;
}

function publishMarker(directory: string, name: string, value: Record<string, unknown>): void {
  const path = markerPath(directory, name);
  if (validateMarker(path)) return;
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  try {
    try { linkSync(temporary, path); }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      validateMarker(path);
    }
  } finally {
    unlinkSync(temporary);
  }
}

export function stateDirectory(
  override = process.env.TOOL_LOGGER_STATE_DIR,
  userHome = homedir(),
): string {
  if (!override) return join(userHome, '.local/state/tool-logger');
  if (override === '~') return userHome;
  return override.startsWith('~/') ? join(userHome, override.slice(2)) : override;
}

export function ensureState(directory: string, homeDirectory = homedir()): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'state.json');
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isFile()) throw new Error('state.json must be a regular file');
    return;
  }
  const temporary = join(directory, `.state-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ schema_version: 1, home_directory: homeDirectory }) + '\n', {
    flag: 'wx', mode: 0o600, flush: true,
  });
  try {
    try { linkSync(temporary, path); }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
}

export function v2IntentExists(directory: string): boolean {
  try { return validateMarker(markerPath(directory, INTENT)); }
  catch { return true; }
}

function v2ActiveExists(directory: string): boolean {
  return validateMarker(markerPath(directory, ACTIVE));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) !== 'ESRCH'; }
}

function lockCanBeRecovered(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const value = record(parsed);
    const pid = value && 'pid' in value ? value.pid : null;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    // A process may die between exclusive creation and writing its ownership record.
  }
  try { return Date.now() - statSync(path).mtimeMs >= EMPTY_LOCK_STALE_MS; }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function tryAcquireLock(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    return false;
  }
  try {
    const data = Buffer.from(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + '\n');
    if (writeSync(fd, data) !== data.length) throw new Error('incomplete promotion lock write');
    fsyncSync(fd);
    return true;
  } catch (error) {
    try { unlinkSync(path); } catch { /* Preserve the original error. */ }
    throw error;
  } finally {
    closeSync(fd);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

async function acquirePromotion(directory: string): Promise<boolean> {
  const path = markerPath(directory, LOCK);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (v2ActiveExists(directory)) return false;
    if (tryAcquireLock(path)) return true;
    if (lockCanBeRecovered(path)) {
      try { unlinkSync(path); }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      continue;
    }
    await delay(LOCK_WAIT_MS);
  }
  throw new Error('timed out waiting for OpenCode V2 promotion');
}

export async function promoteV2(directory = stateDirectory()): Promise<void> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensureState(directory);
  publishMarker(directory, INTENT, {
    schema_version: 1, generation: 2, created_at: new Date().toISOString(),
  });
  if (v2ActiveExists(directory)) return;
  const owner = await acquirePromotion(directory);
  if (!owner) return;
  const lock = markerPath(directory, LOCK);
  try {
    if (v2ActiveExists(directory)) return;
    publishMarker(directory, ACTIVE, {
      schema_version: 1, generation: 2, activated_at: new Date().toISOString(),
    });
  } finally {
    try { unlinkSync(lock); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}
