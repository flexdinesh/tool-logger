import { join } from 'node:path';
import type { SourceConfig } from './config.ts';
import { atomicJson, code, object, readJson } from './persistence.ts';
import type { Position } from './journal.ts';

export type Checkpoint = {
  schemaVersion: 1;
  sourceId: string;
  endpoint: string;
  journals: Record<string, Position>;
  rejectedEvents: number;
};

export function emptyCheckpoint(config: SourceConfig): Checkpoint {
  return { schemaVersion: 1, sourceId: config.sourceId, endpoint: config.endpoint, journals: {}, rejectedEvents: 0 };
}

export async function loadCheckpoint(directory: string, config: SourceConfig): Promise<Checkpoint> {
  let value: unknown;
  try { value = await readJson(join(directory, 'outbox/checkpoint.json')); }
  catch (error) {
    if (code(error) === 'ENOENT') return emptyCheckpoint(config);
    throw new Error('Checkpoint unavailable; preserve it and repair or remove to replay safely');
  }
  if (!object(value) || value.schemaVersion !== 1 || !object(value.journals)
      || !Number.isSafeInteger(value.rejectedEvents) || typeof value.rejectedEvents !== 'number'
      || value.rejectedEvents < 0) throw new Error('Invalid checkpoint; remove to replay safely');
  if (value.sourceId !== config.sourceId) {
    throw new Error('Source identity differs from checkpoint; use a fresh state directory');
  }
  const journals: Record<string, Position> = {};
  for (const [harness, entry] of Object.entries(value.journals)) {
    if (!['codex', 'opencode'].includes(harness) || !object(entry)
        || typeof entry.offset !== 'number' || !Number.isSafeInteger(entry.offset) || entry.offset < 0
        || typeof entry.identity !== 'string') throw new Error('Invalid journal checkpoint');
    journals[harness] = { offset: entry.offset, identity: entry.identity };
  }
  return { schemaVersion: 1, sourceId: config.sourceId, endpoint: config.endpoint, journals, rejectedEvents: value.rejectedEvents };
}

export async function saveCheckpoint(directory: string, checkpoint: Checkpoint): Promise<void> {
  await atomicJson(join(directory, 'outbox/checkpoint.json'), checkpoint);
}
