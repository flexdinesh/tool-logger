import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { link, lstat, mkdir, unlink, writeFile } from 'node:fs/promises';

function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
}

async function validateState(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error('state.json must be a regular file');
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
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

export async function ensureState(directory: string, homeDirectory = homedir()): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'state.json');
  if (await validateState(path)) return;
  const temporary = join(directory, `.state-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({
    schema_version: 1,
    home_directory: homeDirectory,
  }) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  try {
    try { await link(temporary, path); }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      await validateState(path);
    }
  } finally {
    await unlink(temporary);
  }
}
