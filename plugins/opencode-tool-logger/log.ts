import {
  closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { collectMetadata } from './context.ts';
import type { MetadataError } from './context.ts';
import { ensureState, stateDirectory, v2IntentExists } from './state.ts';

export type HookName = 'tool.execute.before' | 'tool.execute.after';
type Writer = (fd: number, data: Uint8Array) => number;

function writeRecord(
  apiVersion: 1 | 2,
  hook: HookName,
  event: unknown,
  sessionCwd: string | null,
  errors: MetadataError[],
  directory: string,
  write: Writer,
  suppressV1: boolean,
  intentExists: (directory: string) => boolean,
): boolean {
  if (suppressV1 && intentExists(directory)) return false;
  const metadata = collectMetadata(apiVersion, sessionCwd, errors);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { ensureState(directory); }
  catch (error) {
    metadata.errors.push({
      source: 'state', message: error instanceof Error ? error.message : String(error),
    });
  }
  const data = Buffer.from(JSON.stringify({
    schema_version: 2,
    event_id: randomUUID(),
    logged_at: new Date().toISOString(),
    harness: 'opencode',
    api_version: apiVersion,
    hook,
    event,
    metadata,
  }) + '\n');
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
    | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(join(directory, 'opencode-tool-calls.jsonl'), flags, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('log destination must be a regular file');
    // Close the V1 race after opening. V2 publishes intent before activation, so
    // future V1 writes stop without deleting existing history.
    if (suppressV1 && intentExists(directory)) return false;
    if (write(fd, data) !== data.length) throw new Error('incomplete log write');
    fsyncSync(fd);
    return true;
  } finally {
    closeSync(fd);
  }
}

export function appendV1Event(
  hook: HookName,
  input: unknown,
  output: unknown,
  sessionCwd: string | null,
  directory = stateDirectory(),
  write: Writer = writeSync,
  intentExists: (directory: string) => boolean = v2IntentExists,
): boolean {
  return writeRecord(1, hook, { input, output }, sessionCwd, [], directory, write, true, intentExists);
}

export function appendV2Event(
  hook: HookName,
  event: unknown,
  sessionCwd: string | null,
  errors: MetadataError[] = [],
  directory = stateDirectory(),
  write: Writer = writeSync,
): boolean {
  return writeRecord(2, hook, event, sessionCwd, errors, directory, write, false, v2IntentExists);
}
