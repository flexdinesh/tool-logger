import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { UUID } from './config.ts';
import { object } from './persistence.ts';

export const HARNESSES = ['codex', 'opencode'];
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export type Envelope = {
  schemaVersion: 1; eventId: string; sourceId: string;
  harness: string; recordedAt: string; native: Record<string, unknown>;
};
export type JournalRecord = { start: number; end: number; bytes: Buffer | null };
export type Position = { offset: number; identity: string };

export function envelope(bytes: Buffer, sourceId: string, harness: string): Envelope {
  const native: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(native) || native.schema_version !== 2 || native.harness !== harness
      || typeof native.event_id !== 'string' || !UUID.test(native.event_id)
      || typeof native.logged_at !== 'string'
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(native.logged_at)
      || !Number.isFinite(Date.parse(native.logged_at))
      || !object(native.event) || !object(native.metadata)
      || (harness === 'codex' && !['PreToolUse', 'PostToolUse'].includes(String(native.hook)))
      || (harness === 'opencode' && (!['tool.execute.before', 'tool.execute.after'].includes(String(native.hook))
        || (native.api_version !== 1 && native.api_version !== 2)))) {
    throw new Error('Invalid native event');
  }
  return {
    schemaVersion: 1, eventId: native.event_id, sourceId, harness,
    recordedAt: native.logged_at, native,
  };
}

// Snapshot the current end. Partial final records are retried, never acknowledged.
// Oversized records are scanned with fixed memory, retaining only their offsets.
export async function* readJournal(path: string, position: Position): AsyncGenerator<JournalRecord> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const identity = `${stat.dev}:${stat.ino}`;
    if (!stat.isFile() || stat.size < position.offset
        || (position.identity && position.identity !== identity)) {
      throw new Error('Journal replaced or truncated');
    }
    position.identity = identity;
    const chunk = Buffer.alloc(64 * 1024);
    let cursor = position.offset;
    let start = cursor;
    let length = 0;
    let parts: Buffer[] = [];
    while (cursor < stat.size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, stat.size - cursor), cursor);
      if (!bytesRead) break;
      let index = 0;
      while (index < bytesRead) {
        const newline = chunk.indexOf(10, index);
        const complete = newline >= index && newline < bytesRead;
        const end = complete ? newline : bytesRead;
        const piece = chunk.subarray(index, end);
        length += piece.length;
        if (length <= MAX_RECORD_BYTES) parts.push(Buffer.from(piece));
        else parts = [];
        cursor += piece.length + (complete ? 1 : 0);
        index = end + (complete ? 1 : 0);
        if (complete) {
          yield { start, end: cursor, bytes: length <= MAX_RECORD_BYTES ? Buffer.concat(parts, length) : null };
          start = cursor;
          length = 0;
          parts = [];
        }
      }
    }
  } finally { await file.close(); }
}
