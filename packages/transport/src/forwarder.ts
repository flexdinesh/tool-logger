import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { join } from 'node:path';
import { loadSourceConfig, stateDirectory } from './config.ts';
import type { SourceConfig } from './config.ts';
import { loadCheckpoint, saveCheckpoint } from './checkpoint.ts';
import type { Checkpoint } from './checkpoint.ts';
import { envelope, HARNESSES, readJournal } from './journal.ts';
import type { Envelope, JournalRecord, Position } from './journal.ts';
import { DeliveryError, post, sendBatch } from './http.ts';
import { atomicJson, code } from './persistence.ts';

export type Health = {
  schemaVersion: 1;
  status: 'waiting_configuration' | 'ready' | 'retrying' | 'error' | 'stopped';
  sourceId: string | null;
  pendingEvents: number;
  rejectedEvents: number;
  lastError: string;
  updatedAt: string;
  nextRetryAt: string | null;
  pid: number;
};
export type ForwarderOptions = {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?: () => number;
};
type Pending = { record: JournalRecord; event: Envelope };

export function retryDelay(attempt: number, base = 500, maximum = 30_000, random = Math.random): number {
  const ceiling = Math.min(maximum, base * 2 ** Math.min(20, Math.max(0, attempt)));
  return Math.floor(ceiling / 2 + random() * ceiling / 2);
}

async function pendingCount(directory: string, checkpoint: Checkpoint | null): Promise<number> {
  let count = 0;
  for (const harness of HARNESSES) {
    let file;
    try { file = await open(join(directory, 'outbox', `${harness}-tool-calls.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (code(error) === 'ENOENT') continue; throw error; }
    try {
      const stat = await file.stat();
      const position = checkpoint?.journals[harness];
      if (!stat.isFile() || (position && (stat.size < position.offset || position.identity !== `${stat.dev}:${stat.ino}`))) {
        throw new Error('Journal replaced or truncated');
      }
      const chunk = Buffer.alloc(64 * 1024);
      let cursor = position?.offset ?? 0;
      while (cursor < stat.size) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, stat.size - cursor), cursor);
        if (!bytesRead) break;
        for (let i = 0; i < bytesRead; i += 1) if (chunk[i] === 10) count += 1;
        cursor += bytesRead;
      }
    } finally { await file.close(); }
  }
  return count;
}

export class Forwarder {
  directory: string;
  options: ForwarderOptions;
  private config: SourceConfig | null = null;
  private checkpoint: Checkpoint | null = null;
  private heartbeatAt = 0;
  private retryAt = 0;
  private attempt = 0;
  private busy = false;
  private health: Health = {
    schemaVersion: 1, status: 'waiting_configuration', sourceId: null,
    pendingEvents: 0, rejectedEvents: 0, lastError: '', updatedAt: '', nextRetryAt: null, pid: process.pid,
  };

  constructor(directory = stateDirectory(), options: ForwarderOptions = {}) {
    this.directory = directory;
    this.options = options;
  }

  private async advance(harness: string, position: Position, end: number, rejected = false): Promise<void> {
    const checkpoint = this.checkpoint;
    if (!checkpoint) throw new Error('Source not configured');
    // Mutate in-memory progress only after atomic checkpoint persistence succeeds.
    const next: Checkpoint = {
      ...checkpoint,
      journals: { ...checkpoint.journals, [harness]: { identity: position.identity, offset: end } },
      rejectedEvents: checkpoint.rejectedEvents + (rejected ? 1 : 0),
    };
    await saveCheckpoint(this.directory, next);
    this.checkpoint = next;
  }

  private async reject(harness: string, position: Position, record: JournalRecord, reason: string, eventId?: string): Promise<void> {
    const file = await open(join(this.directory, 'outbox/rejections.jsonl'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!(await file.stat()).isFile()) throw new Error('Invalid quarantine destination');
      const data = Buffer.from(JSON.stringify({
        schemaVersion: 1, sourceId: this.config?.sourceId, harness, eventId,
        journal: `${harness}-tool-calls.jsonl`, start: record.start, end: record.end,
        reason, rejectedAt: new Date().toISOString(),
      }) + '\n');
      if ((await file.write(data)).bytesWritten !== data.length) throw new Error('Incomplete quarantine write');
      await file.sync();
    } finally { await file.close(); }
    await this.advance(harness, position, record.end, true);
  }

  private async deliver(harness: string, position: Position, batch: Pending[]): Promise<void> {
    const config = this.config;
    if (!config || batch.length === 0) return;
    try {
      await sendBatch(config, batch.map((pending) => pending.event), this.options.signal, this.options.requestTimeoutMs);
    } catch (error) {
      if (!(error instanceof DeliveryError) || !error.permanentEvent) throw error;
      if (batch.length > 1) {
        const middle = Math.floor(batch.length / 2);
        await this.deliver(harness, position, batch.slice(0, middle));
        await this.deliver(harness, position, batch.slice(middle));
      } else {
        const pending = batch[0];
        if (pending) await this.reject(harness, position, pending.record, `HTTP ${error.status}`, pending.event.eventId);
      }
      return;
    }
    const last = batch.at(-1);
    if (last) await this.advance(harness, position, last.record.end);
  }

  private async drainJournal(harness: string): Promise<void> {
    if (!this.checkpoint) return;
    const position: Position = { ...(this.checkpoint.journals[harness] ?? { offset: 0, identity: '' }) };
    const path = join(this.directory, 'outbox', `${harness}-tool-calls.jsonl`);
    let batch: Pending[] = [];
    let bytes = 0;
    let count = 0;
    try {
      for await (const record of readJournal(path, position)) {
        if (this.options.signal?.aborted) return;
        let event: Envelope | null = null;
        try { if (record.bytes && this.config) event = envelope(record.bytes, this.config.sourceId, harness); }
        catch { /* Bad records remain local, referenced by quarantine offsets. */ }
        if (!event) {
          await this.deliver(harness, position, batch);
          batch = []; bytes = 0;
          await this.reject(harness, position, record, record.bytes ? 'Invalid native event' : 'Record exceeds 8 MiB');
        } else {
          const size = Buffer.byteLength(JSON.stringify(event));
          if (batch.length && (bytes + size > 1024 * 1024 || batch.some((pending) => pending.event.eventId === event.eventId))) {
            await this.deliver(harness, position, batch);
            batch = []; bytes = 0;
          }
          batch.push({ record, event }); bytes += size;
          if (batch.length >= 100) {
            await this.deliver(harness, position, batch);
            batch = []; bytes = 0;
          }
        }
        count += 1;
        if (count >= 200) break;
      }
    } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    await this.deliver(harness, position, batch);
  }

  private async diagnostics(): Promise<void> {
    this.health.pendingEvents = await pendingCount(this.directory, this.checkpoint);
    this.health.rejectedEvents = this.checkpoint?.rejectedEvents ?? 0;
    this.health.updatedAt = new Date().toISOString();
    this.health.nextRetryAt = this.retryAt ? new Date(this.retryAt).toISOString() : null;
    await atomicJson(join(this.directory, 'outbox/health.json'), this.health);
  }

  async tick(): Promise<Health> {
    if (this.busy) throw new Error('Forwarder tick already running');
    this.busy = true;
    let configured = false;
    try {
      const config = await loadSourceConfig(this.directory);
      if (!config) {
        this.health.status = 'waiting_configuration';
        this.health.lastError = 'Waiting for source.json; journals remain local';
        await this.diagnostics();
        return { ...this.health };
      }
      if (this.config && config.sourceId !== this.config.sourceId) {
        throw new Error('Source identity changed; use a fresh state directory');
      }
      this.config = config;
      configured = true;
      this.health.sourceId = config.sourceId;
      if (!this.checkpoint) this.checkpoint = await loadCheckpoint(this.directory, config);
      if (Date.now() < this.retryAt) return { ...this.health };
      let deliveryError: unknown;
      for (const harness of HARNESSES) {
        try { await this.drainJournal(harness); }
        catch (error) { deliveryError = error; }
      }
      this.health.lastError = deliveryError instanceof DeliveryError ? deliveryError.message : '';
      this.health.status = deliveryError ? 'retrying' : 'ready';
      if (deliveryError && !(deliveryError instanceof DeliveryError)) throw deliveryError;
      await this.diagnostics();
      if (Date.now() >= this.heartbeatAt) {
        try {
          await post(config, 'heartbeat', {
            sourceId: config.sourceId, hostname: hostname(), platform: platform(), labels: config.labels,
            pendingEvents: this.health.pendingEvents, rejectedEvents: this.health.rejectedEvents,
            lastError: this.health.lastError,
          }, this.options.signal, this.options.requestTimeoutMs);
        } catch (error) { deliveryError ??= error; }
        this.heartbeatAt = Date.now() + (this.options.heartbeatMs ?? 10_000);
      }
      if (deliveryError instanceof DeliveryError) {
        this.health.status = 'retrying';
        this.health.lastError = deliveryError.message;
        this.retryAt = Date.now() + retryDelay(this.attempt++, this.options.retryBaseMs,
          this.options.retryMaxMs, this.options.random);
      } else {
        this.health.status = 'ready'; this.attempt = 0; this.retryAt = 0;
      }
      await this.diagnostics();
    } catch (error) {
      this.health.status = 'error';
      // Only fixed local messages are emitted. Never interpolate arbitrary FS/JSON errors.
      const known = error instanceof Error ? error.message : '';
      this.health.lastError = /^(Source identity|Checkpoint unavailable|Invalid checkpoint|Invalid journal checkpoint|Journal replaced)/.test(known)
        ? known : 'Local state or source configuration unavailable; inspect private files';
      this.health.updatedAt = new Date().toISOString();
      if (configured && this.config && Date.now() >= this.heartbeatAt) {
        this.heartbeatAt = Date.now() + (this.options.heartbeatMs ?? 10_000);
        try {
          await post(this.config, 'heartbeat', {
            sourceId: this.config.sourceId, hostname: hostname(), platform: platform(), labels: this.config.labels,
            pendingEvents: this.health.pendingEvents, rejectedEvents: this.checkpoint?.rejectedEvents ?? 0,
            lastError: this.health.lastError,
          }, this.options.signal, this.options.requestTimeoutMs);
        } catch { /* Keep the actionable local error if reporting it also fails. */ }
      }
      try { await atomicJson(join(this.directory, 'outbox/health.json'), this.health); }
      catch { /* Caller still receives health when disk unavailable. */ }
    } finally { this.busy = false; }
    return { ...this.health };
  }

  async stop(): Promise<void> {
    this.health.status = 'stopped';
    this.health.updatedAt = new Date().toISOString();
    await atomicJson(join(this.directory, 'outbox/health.json'), this.health);
  }
}

export async function runForwarder(directory = stateDirectory(), options: ForwarderOptions = {}): Promise<void> {
  await mkdir(join(directory, 'outbox'), { recursive: true, mode: 0o700 });
  const forwarder = new Forwarder(directory, options);
  while (!options.signal?.aborted) {
    const health = await forwarder.tick();
    const delay = health.status === 'ready' && health.pendingEvents > 0 ? 0 : 250;
    await new Promise<void>((resolve) => {
      const signal = options.signal;
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, delay);
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
  }
  await forwarder.stop();
}
