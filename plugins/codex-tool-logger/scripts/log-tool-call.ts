import {
  closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync,
  readFileSync, realpathSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { collectMetadata } from './context.ts';
import { ensureState } from './state.ts';

export function stateDirectory(
  override = process.env.TOOL_LOGGER_STATE_DIR,
  userHome = homedir(),
): string {
  if (!override) return join(userHome, '.local/state/tool-logger');
  if (override === '~') return userHome;
  return override.startsWith('~/') ? join(userHome, override.slice(2)) : override;
}

export function parseEvent(input: string): Record<string, unknown> {
  const value: unknown = JSON.parse(input);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object');
  }
  if (!('hook_event_name' in value)
      || (value.hook_event_name !== 'PreToolUse' && value.hook_event_name !== 'PostToolUse')) {
    throw new Error('expected PreToolUse or PostToolUse');
  }
  return { ...value };
}

export function appendEvent(
  event: Record<string, unknown>,
  directory = stateDirectory(),
  write: (fd: number, data: Uint8Array) => number = writeSync,
): void {
  const loggedAt = new Date().toISOString();
  const metadata = collectMetadata(event);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { ensureState(directory); }
  catch (error) {
    metadata.errors.push({ source: 'state', message: error instanceof Error ? error.message : String(error) });
  }
  const data = Buffer.from(JSON.stringify({
    schema_version: 2,
    event_id: randomUUID(),
    logged_at: loggedAt,
    harness: 'codex',
    hook: event.hook_event_name,
    event,
    metadata,
  }) + '\n');
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
    | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(join(directory, 'codex-tool-calls.jsonl'), flags, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('log destination must be a regular file');
    // One O_APPEND write per record: the local POSIX filesystem serializes appends.
    // Never loop on a short write: another process could append between fragments.
    if (write(fd, data) !== data.length) throw new Error('incomplete log write');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    appendEvent(parseEvent(readFileSync(0, 'utf8')));
  } catch (error) {
    console.error(`codex-tool-logger: ${error instanceof Error ? error.message : String(error)}`);
    // Exit 1 reports a hook failure. Exit 2 would block a PreToolUse call.
    process.exitCode = 1;
  }
}
