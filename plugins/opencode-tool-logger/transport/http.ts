import type { SourceConfig } from './config.ts';
import { object } from './persistence.ts';
import type { Envelope } from './journal.ts';

export class DeliveryError extends Error {
  status: number;
  permanentEvent: boolean;
  constructor(status: number, message = `HTTP ${status}`) {
    super(message);
    this.status = status;
    this.permanentEvent = [400, 409, 413, 415, 422].includes(status);
  }
}

export async function post(
  config: SourceConfig, route: string, body: unknown, signal?: AbortSignal,
  timeoutMs = 5_000,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${config.endpoint}/api/v1/ingest/${route}`, {
      method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    // Never print a response body: a proxy/server may echo credentials or payloads.
    if (!response.ok) {
      await response.body?.cancel();
      throw new DeliveryError(response.status);
    }
    if (response.status === 204) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 128 * 1024) throw new Error('Invalid acknowledgement');
        chunks.push(chunk);
      }
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value;
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    // Network errors may contain the URL or tokens; expose only fixed diagnostics.
    throw new DeliveryError(0, 'Connection failed, timed out, or acknowledgement invalid');
  }
}

export async function sendBatch(
  config: SourceConfig, events: Envelope[], signal?: AbortSignal, timeoutMs?: number,
): Promise<void> {
  const value = await post(config, 'events', { events }, signal, timeoutMs);
  if (!object(value) || !Array.isArray(value.accepted) || !Array.isArray(value.duplicates)) {
    throw new DeliveryError(0, 'Invalid acknowledgement');
  }
  const expected = new Set(events.map((event) => event.eventId));
  const received = [...value.accepted, ...value.duplicates];
  if (received.length !== expected.size || received.some((id: unknown) => typeof id !== 'string' || !expected.has(id))
      || new Set(received).size !== expected.size) {
    throw new DeliveryError(0, 'Incomplete acknowledgement');
  }
}
