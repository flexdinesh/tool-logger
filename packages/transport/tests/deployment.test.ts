import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTCPServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { configureSource } from '../src/config.ts';
import { Forwarder } from '../src/forwarder.ts';
import { object } from '../src/persistence.ts';

const exec = promisify(execFile);
const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const source = join(repository, 'packages/transport/src');
const sourceId = '550e8400-e29b-41d4-a716-446655440000';
const token = 'synthetic-deployment-source-token';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'transport-deployment-'));
  mkdirSync(join(directory, 'outbox'), { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function append(directory: string) {
  const id = randomUUID();
  appendFileSync(join(directory, 'outbox/codex-tool-calls.jsonl'), JSON.stringify({
    schema_version: 2, event_id: id, logged_at: new Date().toISOString(), harness: 'codex', hook: 'PreToolUse',
    event: { hook_event_name: 'PreToolUse', session_id: 'deployment', tool_use_id: id, tool_name: 'read', tool_input: {} },
    metadata: {},
  }) + '\n', { mode: 0o600 });
  return id;
}

async function wait(predicate: () => boolean, limit = 30_000) {
  const deadline = Date.now() + limit;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Deployment condition timed out');
    await setTimeout(30);
  }
}

async function listener(t: TestContext, host = '127.0.0.1') {
  const received: string[] = [];
  const app = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.ok(object(body));
    if (request.url === '/api/v1/ingest/heartbeat') { response.writeHead(204).end(); return; }
    assert.equal(request.url, '/api/v1/ingest/events');
    assert.ok(Array.isArray(body.events));
    const ids = body.events.map((event: unknown) => {
      assert.ok(object(event) && typeof event.eventId === 'string');
      assert.equal(event.sourceId, sourceId);
      assert.ok(object(event.native));
      assert.equal(event.eventId, event.native.event_id);
      return event.eventId;
    });
    received.push(...ids);
    response.end(JSON.stringify({ accepted: ids, duplicates: [] }));
  });
  app.listen(0, host); await once(app, 'listening');
  const address = app.address(); assert.ok(address && typeof address !== 'string');
  t.after(() => { app.closeAllConnections(); app.close(); });
  return { port: address.port, received };
}

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
}

test('Docker worker reaches Linux host gateway and resumes from persistent volume checkpoint', async (t) => {
  const available = spawnSync('docker', ['image', 'inspect', 'node:26-alpine'], { cwd: repository, stdio: 'ignore', timeout: 5000 });
  if (available.status !== 0) { t.skip('Docker daemon or preloaded node:26-alpine unavailable'); return; }
  const directory = fixture(t);
  const app = await listener(t, '0.0.0.0');
  await configureSource(directory, {
    schemaVersion: 1, sourceId, token, name: 'Docker fixture', labels: { 'container.name': 'transport-fixture' },
    endpoint: `http://host.docker.internal:${app.port}`,
  });
  const name = `tool-logger-transport-test-${randomUUID()}`;
  const ids = [append(directory)];
  let output = '';
  async function stop() {
    await exec('docker', ['stop', '-t', '3', name], { cwd: repository, timeout: 10_000 }).catch(() => {});
    await exec('docker', ['rm', '-f', name], { cwd: repository, timeout: 10_000 }).catch(() => {});
  }
  t.after(stop);
  function start() {
    const child = spawn('docker', [
      'run', '--rm', '--name', name, '--add-host', 'host.docker.internal:host-gateway',
      '--user', `${userInfo().uid}:${userInfo().gid}`,
      '--mount', `type=bind,src=${source},dst=/runtime,readonly`,
      '--mount', `type=bind,src=${directory},dst=/state`, '-e', 'TOOL_LOGGER_STATE_DIR=/state',
      'node:26-alpine', 'node', '/runtime/cli.ts', 'run',
    ], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    return child;
  }
  const first = start();
  try {
    await wait(() => {
      assert.equal(first.exitCode, null, output);
      return existsSync(join(directory, 'outbox/checkpoint.json'));
    });
    await stop();
    await terminate(first);
    ids.push(append(directory));
    const second = start();
    try {
      await wait(() => app.received.length === 2);
      await wait(() => {
        const health: unknown = JSON.parse(readFileSync(join(directory, 'outbox/health.json'), 'utf8'));
        return object(health) && health.pendingEvents === 0;
      });
      assert.deepEqual(app.received, ids);
    } finally { await stop(); await terminate(second); }
    assert.equal(output, '');
  } finally { await stop(); await terminate(first); }
});

async function unusedPort() {
  const socket = createTCPServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('SSH reverse tunnel delivers, retries after tunnel loss and resumes without changing source identity', async (t) => {
  const sshd = '/usr/bin/sshd';
  if (!existsSync(sshd) || spawnSync('ssh-keygen', ['-V'], { cwd: repository, stdio: 'ignore' }).error) {
    t.skip('OpenSSH server/keygen unavailable'); return;
  }
  const directory = fixture(t);
  const hostKey = join(directory, 'host');
  const clientKey = join(directory, 'client');
  for (const path of [hostKey, clientKey]) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], { cwd: directory });
  const port = await unusedPort();
  const tunnelPort = await unusedPort();
  const app = await listener(t);
  const configPath = join(directory, 'sshd_config');
  writeFileSync(configPath, [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `PidFile ${directory}/sshd.pid`,
    `AuthorizedKeysFile ${clientKey}.pub`, 'StrictModes no', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'UsePAM no', 'AllowTcpForwarding yes', 'GatewayPorts no',
    `AllowUsers ${userInfo().username}`, 'LogLevel ERROR',
  ].join('\n') + '\n', { mode: 0o600 });
  const daemon = spawn(sshd, ['-D', '-e', '-f', configPath], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let daemonError = '';
  daemon.stderr.on('data', (chunk: Buffer) => { daemonError += chunk.toString(); });
  t.after(() => terminate(daemon));
  await setTimeout(150);
  if (daemon.exitCode !== null) {
    t.skip(`Unprivileged test SSH daemon unavailable: ${daemonError.trim()}`); return;
  }
  let tunnel: ChildProcess | null = null;
  async function connect() {
    tunnel = spawn('ssh', [
      '-N', '-T', '-p', String(port), '-i', clientKey, '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${tunnelPort}:127.0.0.1:${app.port}`,
      `${userInfo().username}@127.0.0.1`,
    ], { cwd: directory, stdio: 'ignore' });
    await setTimeout(300);
    assert.equal(tunnel.exitCode, null, 'SSH reverse tunnel must stay connected');
  }
  t.after(async () => { if (tunnel) await terminate(tunnel); });
  await configureSource(directory, {
    schemaVersion: 1, sourceId, token, name: 'SSH fixture', labels: {}, endpoint: `http://127.0.0.1:${tunnelPort}`,
  });
  const worker = new Forwarder(directory, { requestTimeoutMs: 500, retryBaseMs: 0 });
  const ids = [append(directory)];
  try {
    await connect();
    assert.equal((await worker.tick()).status, 'ready');
    if (tunnel) await terminate(tunnel);
    ids.push(append(directory));
    assert.equal((await worker.tick()).status, 'retrying');
    await connect();
    assert.equal((await worker.tick()).pendingEvents, 0);
    assert.deepEqual(app.received, ids);
  } finally { if (tunnel) await terminate(tunnel); await terminate(daemon); }
});

test('Linux service template validates after replacing installation-specific executable paths', (t) => {
  if (process.platform !== 'linux'
      || spawnSync('systemd-analyze', ['--version'], { cwd: repository, stdio: 'ignore' }).status !== 0) {
    t.skip('Linux systemd-analyze unavailable'); return;
  }
  const directory = fixture(t);
  const template = readFileSync(join(repository, 'packages/transport/examples/tool-logger-source.service'), 'utf8');
  const path = join(directory, 'tool-logger-source.service');
  writeFileSync(path, template.replace('/usr/local/bin/node', process.execPath)
    .replace('/absolute/plugin', join(repository, 'plugins/codex-tool-logger')));
  execFileSync('systemd-analyze', ['--user', 'verify', path], { cwd: directory, stdio: 'pipe' });
});
