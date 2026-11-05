import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseSourceConfig } from '../src/config.ts';
import { DeliveryError, post } from '../src/http.ts';

test('private Unix HTTP preserves auth, bounded acknowledgements, cancellation and retryable failures', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tl-unix-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const socket = join(directory, 'collector.sock');
  let mode = 'success';
  const app = createServer(async (request, response) => {
    assert.equal(request.url, '/api/v1/ingest/events');
    assert.equal(request.headers.authorization, 'Bearer private-token');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), { events: [] });
    if (mode === 'hang') return;
    if (mode === 'oversized') { response.end('x'.repeat(128 * 1024 + 1)); return; }
    if (mode === 'unauthorized') { response.writeHead(401).end(); return; }
    if (mode === 'redirect') { response.writeHead(302, { location: 'http://127.0.0.1:1/leak' }).end(); return; }
    response.end(JSON.stringify({ accepted: [], duplicates: [] }));
  });
  app.listen(socket);
  await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const config = parseSourceConfig({ schemaVersion: 1, sourceId: '550e8400-e29b-41d4-a716-446655440000', endpoint: `unix://${socket}`, token: 'private-token', name: 'Local', labels: {} });
  assert.deepEqual(await post(config, 'events', { events: [] }), { accepted: [], duplicates: [] });
  const failures: [string, number][] = [['unauthorized', 401], ['redirect', 302], ['oversized', 0]];
  for (const [next, status] of failures) {
    mode = next;
    await assert.rejects(post(config, 'events', { events: [] }), (error: unknown) => error instanceof DeliveryError && error.status === status && !error.permanentEvent);
  }
  mode = 'hang';
  await assert.rejects(post(config, 'events', { events: [] }, undefined, 30), DeliveryError);
  const controller = new AbortController();
  const pending = post(config, 'events', { events: [] }, controller.signal);
  controller.abort();
  await assert.rejects(pending, DeliveryError);
  for (const endpoint of ['unix://host/tmp/socket', 'unix:///', 'unix:relative', 'unix:///tmp/socket?secret=1']) {
    assert.throws(() => parseSourceConfig({ ...config, endpoint }));
  }
});
