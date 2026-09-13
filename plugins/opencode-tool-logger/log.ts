import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { collectMetadata } from './context.ts';
import type { MetadataError } from './context.ts';
import { ensureState, stateDirectory } from './state.ts';

export type HookName = 'tool.execute.before' | 'tool.execute.after';
export type EventContext = { cwd: string | null; errors: MetadataError[] };

type PendingEvent = {
  apiVersion: 1 | 2;
  hook: HookName;
  eventID: string;
  loggedAt: string;
  eventJson: string | undefined;
  context: () => Promise<EventContext>;
};

export type EventLogger = {
  appendV1: (
    hook: HookName,
    input: unknown,
    output: unknown,
    sessionCwd: string | null,
  ) => void;
  appendV2: (
    hook: HookName,
    event: unknown,
    context: () => Promise<EventContext>,
  ) => void;
  drain: () => Promise<void>;
};

async function writeRecord(directory: string, pending: PendingEvent): Promise<void> {
  const details = await pending.context();
  const metadata = await collectMetadata(
    pending.apiVersion, details.cwd, details.errors,
  );
  try { await ensureState(directory); }
  catch (error) {
    metadata.errors.push({
      source: 'state', message: error instanceof Error ? error.message : String(error),
    });
  }
  let event: unknown;
  if (pending.eventJson !== undefined) event = JSON.parse(pending.eventJson);
  const data = Buffer.from(JSON.stringify({
    schema_version: 2,
    event_id: pending.eventID,
    logged_at: pending.loggedAt,
    harness: 'opencode',
    api_version: pending.apiVersion,
    hook: pending.hook,
    event,
    metadata,
  }) + '\n');
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
    | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(join(directory, 'opencode-tool-calls.jsonl'), flags, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error('log destination must be a regular file');
    const result = await file.write(data);
    if (result.bytesWritten !== data.length) throw new Error('incomplete log write');
    await file.sync();
  } finally {
    await file.close();
  }
}

export function createEventLogger(directory = stateDirectory()): EventLogger {
  let tail = Promise.resolve();

  function enqueue(
    apiVersion: 1 | 2,
    hook: HookName,
    event: unknown,
    context: () => Promise<EventContext>,
  ): void {
    try {
      const pending: PendingEvent = {
        apiVersion,
        hook,
        eventID: randomUUID(),
        loggedAt: new Date().toISOString(),
        eventJson: JSON.stringify(event),
        context,
      };
      tail = tail.then(() => writeRecord(directory, pending)).catch(() => {
        // Telemetry must never affect tool execution or later writes.
      });
    } catch {
      // Snapshot failures must never affect tool execution.
    }
  }

  return {
    appendV1: (hook, input, output, sessionCwd) => {
      enqueue(1, hook, { input, output }, async () => ({ cwd: sessionCwd, errors: [] }));
    },
    appendV2: (hook, event, context) => { enqueue(2, hook, event, context); },
    drain: () => tail,
  };
}
