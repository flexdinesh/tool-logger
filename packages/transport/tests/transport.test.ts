import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { configureSource, loadSourceConfig, parseSourceConfig } from '../src/config.ts';
import { Forwarder, retryDelay } from '../src/forwarder.ts';
import { envelope, MAX_RECORD_BYTES, readJournal } from '../src/journal.ts';
import { object } from '../src/persistence.ts';
import { syncTransport } from '../sync.ts';

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const cli = join(repository, 'packages/transport/src/cli.ts');
const sourceId = '550e8400-e29b-41d4-a716-446655440000';
const token = 'private-test-token-never-print';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'source-transport-'));
  mkdirSync(join(directory, 'outbox'), { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function native(harness = 'codex', extra: Record<string, unknown> = {}) {
  const call = randomUUID();
  return {
    schema_version: 2, event_id: randomUUID(), logged_at: '2026-11-04T00:00:00.000Z',
    harness, hook: harness === 'codex' ? 'PreToolUse' : 'tool.execute.after',
    ...(harness === 'opencode' ? { api_version: 2 } : {}),
    event: harness === 'codex'
      ? { hook_event_name: 'PreToolUse', tool_name: 'read', tool_use_id: call, session_id: 'session', tool_input: { untouched: [1, null, 'café'] } }
      : { tool: 'read', id: call, sessionID: 'session', status: 'completed', result: { content: 'café' } },
    metadata: { collector: { version: 'test' } }, ...extra,
  };
}

function append(directory: string, records: ReturnType<typeof native>[], harness = 'codex') {
  const path = join(directory, 'outbox', `${harness}-tool-calls.jsonl`);
  appendFileSync(path, records.map((record) => JSON.stringify(record) + '\n').join(''), { mode: 0o600 });
  return path;
}

function config(endpoint: string) {
  return { schemaVersion: 1, sourceId, endpoint, token, name: 'Test source', labels: { 'service.name': 'tool-logger' } };
}

async function server(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void) {
  const app = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.ok(object(body));
    handle(request, response, body);
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  t.after(() => { app.closeAllConnections(); app.close(); });
  return `http://127.0.0.1:${address.port}`;
}

function events(body: Record<string, unknown>): Record<string, unknown>[] {
  assert.ok(Array.isArray(body.events));
  return body.events.map((event: unknown) => { assert.ok(object(event)); return event; });
}

function ack(response: ServerResponse, values: Record<string, unknown>[], duplicates = false) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    accepted: duplicates ? [] : values.map((event) => event.eventId),
    duplicates: duplicates ? values.map((event) => event.eventId) : [],
  }));
}

async function until(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Condition timed out');
    await setTimeout(20);
  }
}

test('configuration validates identity, endpoint and private files without echoing credentials', async (t) => {
  const directory = fixture(t);
  const input = config('http://127.0.0.1:4317/');
  assert.equal(parseSourceConfig(input).endpoint, 'http://127.0.0.1:4317');
  for (const override of [
    { sourceId: 'hostname' }, { token: 'secret\nheader' }, { endpoint: 'file:///tmp/source' },
    { endpoint: 'https://user:password@example.invalid' }, { endpoint: 'https://example.invalid/?token=secret' },
    { endpoint: 'https://example.invalid/?' }, { endpoint: 'https://example.invalid/#' },
    { schemaVersion: 2 }, { labels: { number: 4 } }, { name: '' },
  ]) assert.throws(() => parseSourceConfig({ ...input, ...override }));
  assert.throws(() => parseSourceConfig({
    ...input, labels: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`key${index}`, 'x'.repeat(4096)])),
  }), /too large/);
  await configureSource(directory, input);
  assert.equal(statSync(join(directory, 'source.json')).mode & 0o777, 0o600);
  assert.equal((await loadSourceConfig(directory))?.token, token);
  await assert.rejects(configureSource(directory, { ...input, sourceId: randomUUID() }), /fresh state/);
  await configureSource(directory, { ...input, token: 'rotated-token' });
  chmodSync(join(directory, 'source.json'), 0o644);
  await assert.rejects(loadSourceConfig(directory), /unavailable or invalid/);
  assert.equal(readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
});

test('absent config queues only fresh outbox; legacy journal remains byte-identical', async (t) => {
  const directory = fixture(t);
  const record = native();
  const legacy = join(directory, 'codex-tool-calls.jsonl');
  writeFileSync(legacy, 'legacy history must never upload\n');
  const journal = append(directory, [record]);
  const initial = readFileSync(journal);
  const forwarder = new Forwarder(directory);
  const waiting = await forwarder.tick();
  assert.equal(waiting.status, 'waiting_configuration');
  assert.equal(waiting.pendingEvents, 1);
  assert.equal(existsSync(join(directory, 'source.json')), false);
  let calls = 0;
  const endpoint = await server(t, (request, response, body) => {
    if (request.url?.endsWith('/heartbeat')) { response.writeHead(204).end(); return; }
    const batch = events(body); calls += batch.length;
    assert.deepEqual(batch, [envelope(Buffer.from(JSON.stringify(record)), sourceId, 'codex')]);
    ack(response, batch);
  });
  await configureSource(directory, config(endpoint));
  assert.equal((await forwarder.tick()).status, 'ready');
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(journal), initial);
  assert.equal(readFileSync(legacy, 'utf8'), 'legacy history must never upload\n');
});

test('outages retain checkpoint, retry with stable bytes and deduplicate an ACK lost after commit', async (t) => {
  const directory = fixture(t);
  const record = native();
  const journal = append(directory, [record]);
  let attempts = 0;
  const received: Record<string, unknown>[][] = [];
  const heartbeats: Record<string, unknown>[] = [];
  const endpoint = await server(t, (request, response, body) => {
    if (request.url?.endsWith('/heartbeat')) { heartbeats.push(body); response.writeHead(204).end(); return; }
    attempts += 1;
    received.push(events(body));
    if (attempts === 1) { response.writeHead(503).end(token); return; }
    if (attempts === 2) { response.destroy(); return; } // durable server commit, ACK lost
    ack(response, events(body), true);
  });
  await configureSource(directory, config(endpoint));
  const worker = new Forwarder(directory, { retryBaseMs: 0 });
  const first = await worker.tick();
  assert.equal(first.status, 'retrying');
  assert.equal(first.pendingEvents, 1);
  assert.equal(existsSync(join(directory, 'outbox/checkpoint.json')), false);
  await worker.tick();
  assert.equal(existsSync(join(directory, 'outbox/checkpoint.json')), false);
  const restarted = new Forwarder(directory);
  assert.equal((await restarted.tick()).pendingEvents, 0);
  assert.equal(attempts, 3);
  assert.deepEqual(received[0], received[1]);
  assert.deepEqual(received[1], received[2]);
  assert.ok(heartbeats.some((heartbeat) => heartbeat.pendingEvents === 1 && heartbeat.lastError === 'HTTP 503'));
  assert.doesNotMatch(readFileSync(join(directory, 'outbox/health.json'), 'utf8'), new RegExp(token));
  const checkpoint: unknown = JSON.parse(readFileSync(join(directory, 'outbox/checkpoint.json'), 'utf8'));
  assert.ok(object(checkpoint) && object(checkpoint.journals) && object(checkpoint.journals.codex));
  assert.equal(checkpoint.journals.codex.offset, statSync(journal).size);
  await restarted.tick();
  assert.equal(attempts, 3);
});

test('permanent batch rejection isolates bad events, retains evidence and continues both harnesses', async (t) => {
  const directory = fixture(t);
  const good = native();
  const bad = native('codex', { event: { invalid: true } });
  const later = native();
  const opencode = native('opencode');
  const journal = append(directory, [good, bad, later]);
  append(directory, [opencode], 'opencode');
  const accepted: unknown[] = [];
  const endpoint = await server(t, (request, response, body) => {
    if (request.url?.endsWith('/heartbeat')) { response.writeHead(204).end(); return; }
    const batch = events(body);
    if (batch.some((event) => event.eventId === bad.event_id)) { response.writeHead(422).end(token); return; }
    accepted.push(...batch.map((event) => event.eventId)); ack(response, batch);
  });
  await configureSource(directory, config(endpoint));
  const health = await new Forwarder(directory).tick();
  assert.equal(health.status, 'ready');
  assert.equal(health.pendingEvents, 0);
  assert.equal(health.rejectedEvents, 1);
  assert.deepEqual(accepted, [good.event_id, later.event_id, opencode.event_id]);
  assert.equal(readFileSync(journal, 'utf8').split('\n').filter(Boolean).length, 3);
  const rejection: unknown = JSON.parse(readFileSync(join(directory, 'outbox/rejections.jsonl'), 'utf8'));
  assert.ok(object(rejection));
  assert.equal(rejection.eventId, bad.event_id);
  assert.equal(rejection.reason, 'HTTP 422');
  assert.doesNotMatch(JSON.stringify(rejection), new RegExp(token));
  const restarted = await new Forwarder(directory).tick();
  assert.equal(restarted.rejectedEvents, 1);
  assert.equal(accepted.length, 3);
});

test('authentication, redirects and incomplete ACK never checkpoint or quarantine', async (t) => {
  for (const mode of ['authentication', 'redirect', 'incomplete', 'conflict']) {
    const directory = fixture(t);
    append(directory, [native()]);
    let endpoint = '';
    endpoint = await server(t, (request, response, body) => {
      if (request.url?.endsWith('/heartbeat')) { response.writeHead(204).end(); return; }
      if (mode === 'authentication') response.writeHead(401).end(token);
      else if (mode === 'redirect') response.writeHead(307, { location: endpoint + '/credential-leak' }).end();
      else if (mode === 'conflict') response.writeHead(409).end(token);
      else { assert.ok(body.events); response.end(JSON.stringify({ accepted: [], duplicates: [] })); }
    });
    await configureSource(directory, config(endpoint));
    const health = await new Forwarder(directory).tick();
    if (mode === 'conflict') {
      assert.equal(health.rejectedEvents, 1); assert.equal(health.pendingEvents, 0);
    } else {
      assert.equal(health.status, 'retrying'); assert.equal(health.pendingEvents, 1);
      assert.equal(existsSync(join(directory, 'outbox/checkpoint.json')), false);
      assert.equal(existsSync(join(directory, 'outbox/rejections.jsonl')), false);
    }
    assert.doesNotMatch(JSON.stringify(health), new RegExp(token));
  }
});

test('partial records wait for newline, malformed/oversized records retain offsets and later records deliver', async (t) => {
  const directory = fixture(t);
  const record = native();
  const path = join(directory, 'outbox/codex-tool-calls.jsonl');
  writeFileSync(path, JSON.stringify(record));
  let received = 0;
  const endpoint = await server(t, (request, response, body) => {
    if (request.url?.endsWith('/heartbeat')) { response.writeHead(204).end(); return; }
    const batch = events(body); received += batch.length; ack(response, batch);
  });
  await configureSource(directory, config(endpoint));
  const worker = new Forwarder(directory);
  await worker.tick();
  assert.equal(received, 0);
  assert.equal(existsSync(join(directory, 'outbox/checkpoint.json')), false);
  appendFileSync(path, '\nmalformed\n' + 'x'.repeat(MAX_RECORD_BYTES + 1) + '\n');
  append(directory, [native()]);
  const health = await worker.tick();
  assert.equal(received, 2);
  assert.equal(health.rejectedEvents, 2);
  assert.equal(health.pendingEvents, 0);
  const rows = readFileSync(join(directory, 'outbox/rejections.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 2);
  assert.match(rows[1] ?? '', /Record exceeds 8 MiB/);
  const position = { offset: 0, identity: '' };
  const records = [];
  for await (const entry of readJournal(path, position)) records.push(entry);
  assert.equal(records.length, 4);
  assert.equal(records[2]?.bytes, null);
  assert.equal(records.at(-1)?.end, statSync(path).size);
});

test('checkpoint write failure replays server-accepted records safely on recovery', async (t) => {
  const directory = fixture(t);
  append(directory, [native()]);
  let requests = 0;
  const errors: unknown[] = [];
  const checkpoint = join(directory, 'outbox/checkpoint.json');
  const endpoint = await server(t, (request, response, body) => {
    if (request.url?.endsWith('/heartbeat')) { errors.push(body.lastError); response.writeHead(204).end(); return; }
    requests += 1;
    if (requests === 1) mkdirSync(checkpoint);
    ack(response, events(body), requests > 1);
  });
  await configureSource(directory, config(endpoint));
  // Load the empty checkpoint, then prevent its atomic rename after the server commit.
  assert.equal((await new Forwarder(directory).tick()).status, 'error');
  assert.ok(errors.includes('Local state or source configuration unavailable; inspect private files'));
  rmSync(checkpoint, { recursive: true });
  assert.equal((await new Forwarder(directory).tick()).pendingEvents, 0);
  assert.equal(requests, 2);
  assert.equal(readdirSync(join(directory, 'outbox')).some((name) => name.endsWith('.tmp')), false);
});

test('journal replacement and corrupt checkpoint fail visibly rather than skip records', async (t) => {
  const directory = fixture(t);
  const journal = append(directory, [native()]);
  const endpoint = await server(t, (request, response, body) => {
    if (request.url?.endsWith('/heartbeat')) { response.writeHead(204).end(); return; }
    ack(response, events(body));
  });
  await configureSource(directory, config(endpoint));
  await new Forwarder(directory).tick();
  writeFileSync(journal, 'short\n');
  assert.equal((await new Forwarder(directory).tick()).status, 'error');
  writeFileSync(join(directory, 'outbox/checkpoint.json'), '{broken');
  const health = await new Forwarder(directory).tick();
  assert.equal(health.status, 'error');
  assert.match(health.lastError, /Checkpoint unavailable/);
});

test('retry is exponentially bounded with jitter', () => {
  assert.equal(retryDelay(0, 100, 1000, () => 0), 50);
  assert.equal(retryDelay(1, 100, 1000, () => 1), 200);
  assert.equal(retryDelay(50, 100, 1000, () => 1), 1000);
});

test('large backlog drains in bounded requests under a constrained worker heap', async (t) => {
  const directory = fixture(t);
  const total = 5000;
  const padding = 'synthetic payload '.repeat(800);
  const ids = new Set<string>();
  for (let index = 0; index < total; index += 1) {
    const record = native('codex', { event: { index, padding } });
    ids.add(record.event_id); append(directory, [record]);
  }
  // About 70 MiB on disk, larger than the worker's 48 MiB V8 heap.
  assert.ok(statSync(join(directory, 'outbox/codex-tool-calls.jsonl')).size > 48 * 1024 * 1024);
  let received = 0;
  const endpoint = await server(t, (request, response, body) => {
    if (request.url?.endsWith('/heartbeat')) { response.writeHead(204).end(); return; }
    const batch = events(body);
    assert.ok(batch.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1024 * 1024 + 100);
    for (const event of batch) { assert.equal(typeof event.eventId, 'string'); assert.ok(ids.delete(String(event.eventId))); }
    received += batch.length; ack(response, batch);
  });
  await configureSource(directory, config(endpoint));
  const child = spawn(process.execPath, ['--max-old-space-size=48', cli, 'run'], {
    cwd: directory, env: { ...process.env, TOOL_LOGGER_STATE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    await until(() => {
      assert.equal(child.exitCode, null, output);
      return received === total && existsSync(join(directory, 'outbox/health.json'))
        && /"pendingEvents":0/.test(readFileSync(join(directory, 'outbox/health.json'), 'utf8'));
    }, 30_000);
    assert.equal(ids.size, 0);
    const done = once(child, 'exit'); child.kill('SIGTERM');
    const [exitCode] = await done;
    assert.equal(exitCode, 0, output);
    assert.equal(output, '');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('CLI configure/status redact token, reject public/symlink files, and installed worker is self-contained', async (t) => {
  const directory = fixture(t);
  const copied = join(directory, 'installed');
  cpSync(join(repository, 'plugins/codex-tool-logger'), copied, { recursive: true });
  const installed = join(copied, 'transport/cli.ts');
  const options: SpawnSyncOptionsWithStringEncoding = {
    cwd: directory, env: { ...process.env, TOOL_LOGGER_STATE_DIR: directory }, encoding: 'utf8',
  };
  const input = JSON.stringify(config('http://127.0.0.1:4317'));
  const configured = spawnSync(process.execPath, [installed, 'configure', '-'], { ...options, input });
  assert.equal(configured.status, 0, configured.stderr);
  assert.doesNotMatch(configured.stdout + configured.stderr, new RegExp(token));
  assert.match(configured.stdout, /REDACTED/);
  const status = execFileSync(process.execPath, [installed, 'status'], options);
  assert.match(status, /not_running/);
  assert.doesNotMatch(status, new RegExp(token));
  writeFileSync(join(directory, 'outbox/health.json'), JSON.stringify({
    status: 'retrying', pid: process.pid, pendingEvents: 1, rejectedEvents: 0, lastError: token,
    token, unexpected: token, updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const safeStatus = execFileSync(process.execPath, [installed, 'status'], options);
  assert.doesNotMatch(safeStatus, new RegExp(token));
  assert.match(safeStatus, /Inspect private health file/);
  const publicFile = join(directory, 'public.json');
  writeFileSync(publicFile, input, { mode: 0o644 });
  const publicResult = spawnSync(process.execPath, [installed, 'configure', publicFile], options);
  assert.equal(publicResult.status, 1);
  assert.doesNotMatch(publicResult.stdout + publicResult.stderr, new RegExp(token));
  const link = join(directory, 'link.json');
  symlinkSync(join(directory, 'source.json'), link);
  assert.equal(spawnSync(process.execPath, [installed, 'configure', link], options).status, 1);
  const invalid = spawnSync(process.execPath, [installed, 'configure', '-'], { ...options, input: token });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, new RegExp(token));
});

test('worker process killed after durable commit replays exact event and exits silently on SIGTERM', async (t) => {
  const directory = fixture(t);
  const record = native();
  append(directory, [record]);
  let received = 0;
  let duplicate = false;
  const endpoint = await server(t, (request, response, body) => {
    if (request.url?.endsWith('/heartbeat')) { response.writeHead(204).end(); return; }
    const batch = events(body);
    assert.equal(batch[0]?.eventId, record.event_id);
    received += 1;
    if (received === 1) return; // persist server commit, deliberately hold ACK
    duplicate = true; ack(response, batch, true);
  });
  await configureSource(directory, config(endpoint));
  function start() {
    const child = spawn(process.execPath, [cli, 'run'], {
      cwd: directory, env: { ...process.env, TOOL_LOGGER_STATE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    return { child, output: () => output };
  }
  const first = start();
  await until(() => received === 1);
  const dead = once(first.child, 'exit'); first.child.kill('SIGKILL'); await dead;
  assert.equal(existsSync(join(directory, 'outbox/checkpoint.json')), false);
  const second = start();
  await until(() => existsSync(join(directory, 'outbox/checkpoint.json')));
  assert.equal(duplicate, true);
  const stopped = once(second.child, 'exit'); second.child.kill('SIGTERM');
  const [exitCode] = await stopped;
  assert.equal(exitCode, 0);
  assert.equal(first.output() + second.output(), '');
});

test('transport copies are exact, missing/stale/changed copies fail check and sync repairs them', async (t) => {
  const directory = fixture(t);
  mkdirSync(join(directory, 'packages/transport/src'), { recursive: true });
  writeFileSync(join(directory, 'packages/transport/src/file.ts'), 'export {};\n');
  await assert.rejects(syncTransport(directory, true), /missing/);
  await syncTransport(directory);
  await syncTransport(directory, true);
  const destination = join(directory, 'plugins/codex-tool-logger/transport');
  writeFileSync(join(destination, 'file.ts'), 'changed');
  await assert.rejects(syncTransport(directory, true), /Transport drift/);
  await syncTransport(directory);
  writeFileSync(join(destination, 'stale.ts'), 'stale');
  await assert.rejects(syncTransport(directory, true), /file drift/);
  await syncTransport(directory);
  await syncTransport(directory, true);
  await syncTransport(repository, true);
});
