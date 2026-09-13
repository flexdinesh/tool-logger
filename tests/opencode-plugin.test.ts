import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { collectMetadata } from '../plugins/opencode-tool-logger/context.ts';
import { createEventLogger } from '../plugins/opencode-tool-logger/log.ts';
import opencodeToolLoggerV1 from '../plugins/opencode-tool-logger/v1.ts';
import opencodeToolLoggerV2 from '../plugins/opencode-tool-logger/v2.ts';
import type { V2Registration } from '../plugins/opencode-tool-logger/v2.ts';
import { object } from '../scripts/workspace.ts';

function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'opencode logger '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const directory = join(temp, 'state');
  const log = join(directory, 'opencode-tool-calls.jsonl');
  return { temp, directory, log };
}

function records(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').trimEnd();
  if (!text) return [];
  return text.split('\n').map((line) => object(JSON.parse(line)));
}

function withStateDirectory<T>(directory: string, run: () => T): T {
  const previous = process.env.TOOL_LOGGER_STATE_DIR;
  process.env.TOOL_LOGGER_STATE_DIR = directory;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.TOOL_LOGGER_STATE_DIR;
    else process.env.TOOL_LOGGER_STATE_DIR = previous;
  }
}

async function withStateDirectoryAsync<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TOOL_LOGGER_STATE_DIR;
  process.env.TOOL_LOGGER_STATE_DIR = directory;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.TOOL_LOGGER_STATE_DIR;
    else process.env.TOOL_LOGGER_STATE_DIR = previous;
  }
}

function registration(dispose: () => Promise<void> = async () => {}): V2Registration {
  return { dispose };
}

async function waitForRecordCount(path: string, count: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (records(path).length >= count) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
  assert.fail(`timed out waiting for ${count} records`);
}

test('V1 hooks preserve both native callback values and session metadata', async (t) => {
  const f = fixture(t);
  execFileSync('git', ['init', '-q', '-b', 'logger-test'], { cwd: f.temp });
  const input = { tool: 'bash', sessionID: 'session-v1', callID: 'call-v1', future: ['kept'] };
  const before = { args: { command: 'printf fish' }, extension: { value: 1 } };
  const after = { title: 'Done', output: 'fish', metadata: { duration: 12 } };
  withStateDirectory(f.directory, () => {
    const hooks = opencodeToolLoggerV1({ directory: f.temp });
    hooks['tool.execute.before'](input, before);
    hooks['tool.execute.after']({ ...input, args: before.args }, after);
  });
  await waitForRecordCount(f.log, 2);
  const actual = records(f.log);
  assert.deepEqual(actual.map((value) => value.hook), ['tool.execute.before', 'tool.execute.after']);
  assert.deepEqual(object(actual[0]).event, { input, output: before });
  assert.deepEqual(object(actual[1]).event, { input: { ...input, args: before.args }, output: after });
  for (const value of actual) {
    assert.equal(value.schema_version, 2);
    assert.equal(value.harness, 'opencode');
    assert.equal(value.api_version, 1);
    assert.equal(typeof value.event_id, 'string');
    assert.ok(Number.isFinite(Date.parse(String(value.logged_at))));
    const metadata = object(value.metadata);
    assert.equal(metadata.session_cwd, f.temp);
    assert.equal(object(metadata.git).branch, 'logger-test');
    const collector = object(metadata.collector);
    assert.equal(collector.name, 'opencode-tool-logger');
    assert.equal(collector.version, '0.1.0');
    assert.ok(collector.runtime === 'node' || collector.runtime === 'bun');
  }
});

test('V2 registers hooks, snapshots events, caches session cwd, and drains on cleanup', async (t) => {
  const f = fixture(t);
  let before: ((event: unknown) => void) | undefined;
  let after: ((event: unknown) => void) | undefined;
  let sessionReads = 0;
  let disposals = 0;
  const success: Record<string, unknown> = {
    tool: 'read', sessionID: 'session-v2', agent: 'build', messageID: 'message-1',
    id: 'call-1', status: 'completed', result: { content: 'value' },
  };
  await withStateDirectoryAsync(f.directory, async () => {
    const cleanup = await opencodeToolLoggerV2.setup({
      tool: { hook: async (name, callback) => {
        if (name === 'execute.before') before = callback;
        else after = callback;
        return registration(async () => { disposals += 1; });
      } },
      session: { get: async () => {
        sessionReads += 1;
        return { location: { directory: f.temp } };
      } },
      location: { directory: '/plugin-location' },
    });
    if (!before || !after) throw new Error('hooks not registered');
    before({ ...success, status: undefined, result: undefined });
    after(success);
    success.status = 'mutated-after-hook';
    after({ tool: 'bash', sessionID: 'session-v2', id: 'call-2', status: 'error' });
    await cleanup();
  });
  const actual = records(f.log);
  assert.equal(actual.length, 3);
  assert.deepEqual(actual.map((value) => value.hook), [
    'tool.execute.before', 'tool.execute.after', 'tool.execute.after',
  ]);
  assert.equal(object(actual[1]?.event).status, 'completed');
  assert.equal(object(actual[2]?.metadata).session_cwd, f.temp);
  assert.equal(sessionReads, 1);
  assert.equal(disposals, 2);
  assert.equal(statSync(f.log).mode & 0o777, 0o600);
});

test('V2 session work is off hook path and timeout is recorded on drain', async (t) => {
  const f = fixture(t);
  let before: ((event: unknown) => void) | undefined;
  await withStateDirectoryAsync(f.directory, async () => {
    const cleanup = await opencodeToolLoggerV2.setup({
      tool: { hook: async (name, callback) => {
        if (name === 'execute.before') before = callback;
        return registration();
      } },
      session: { get: () => new Promise(() => { /* Deliberately stalled client. */ }) },
      location: { directory: f.temp },
    });
    if (!before) throw new Error('before hook not registered');
    const started = performance.now();
    before({ tool: 'read', sessionID: 'stalled', id: 'call' });
    assert.ok(performance.now() - started < 50);
    assert.equal(existsSync(f.log), false);
    await cleanup();
  });
  const metadata = object(records(f.log)[0]?.metadata);
  assert.equal(metadata.session_cwd, f.temp);
  assert.match(JSON.stringify(metadata.errors), /session lookup timed out/);
});

test('V1 and V2 append mixed history while legacy markers remain untouched', async (t) => {
  const f = fixture(t);
  mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  const intent = join(f.directory, 'opencode-v2-intent.json');
  const active = join(f.directory, 'opencode-v2-active.json');
  writeFileSync(intent, 'legacy intent\n');
  writeFileSync(active, 'legacy active\n');
  const logger = createEventLogger(f.directory);
  logger.appendV2('tool.execute.before', { id: 'v2' }, async () => ({ cwd: null, errors: [] }));
  logger.appendV1('tool.execute.after', { callID: 'v1-later' }, {}, null);
  await logger.drain();
  assert.deepEqual(records(f.log).map((value) => value.api_version), [2, 1]);
  assert.equal(readFileSync(intent, 'utf8'), 'legacy intent\n');
  assert.equal(readFileSync(active, 'utf8'), 'legacy active\n');
});

test('event queue preserves order when earlier background work is slower', async (t) => {
  const f = fixture(t);
  const logger = createEventLogger(f.directory);
  logger.appendV2('tool.execute.before', { id: 'first' }, async () => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
    return { cwd: null, errors: [] };
  });
  logger.appendV2('tool.execute.after', { id: 'second' }, async () => ({ cwd: null, errors: [] }));
  await logger.drain();
  assert.deepEqual(records(f.log).map((value) => object(value.event).id), ['first', 'second']);
});

test('V2 setup failure disposes partial registration', async () => {
  let calls = 0;
  let disposals = 0;
  await assert.rejects(opencodeToolLoggerV2.setup({
    tool: { hook: async () => {
      calls += 1;
      if (calls === 2) throw new Error('after registration failed');
      return registration(async () => { disposals += 1; });
    } },
  }), /after registration failed/);
  assert.equal(disposals, 1);
});

test('large concurrent process appends remain complete JSONL records', async (t) => {
  const f = fixture(t);
  const module = pathToFileURL(join(process.cwd(), 'plugins/opencode-tool-logger/log.ts')).href;
  const source = `import {createEventLogger} from ${JSON.stringify(module)}; const logger=createEventLogger(); logger.appendV2('tool.execute.after',{id:process.argv[1],large:'🐟\\n'.repeat(25000)},async()=>({cwd:null,errors:[]})); await logger.drain();`;
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source, String(index)], {
      env: { ...process.env, TOOL_LOGGER_STATE_DIR: f.directory }, stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  })));
  assert.deepEqual(results, Array.from({ length: 24 }, () => 0));
  const actual = records(f.log);
  assert.equal(actual.length, 24);
  assert.equal(new Set(actual.map((value) => object(value.event).id)).size, 24);
});

test('hooks are silent and fail open on serialization and filesystem failures', async (t) => {
  const f = fixture(t);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  withStateDirectory(f.directory, () => {
    const hooks = opencodeToolLoggerV1({ directory: f.temp });
    assert.doesNotThrow(() => hooks['tool.execute.before']({}, cycle));
  });
  mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  const target = join(f.temp, 'keep');
  writeFileSync(target, 'keep');
  symlinkSync(target, f.log);
  const logger = createEventLogger(f.directory);
  logger.appendV1('tool.execute.after', {}, {}, f.temp);
  await assert.doesNotReject(logger.drain());
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.ok((statSync(f.directory).mode & 0o777) === 0o700);
});

test('metadata bounds Git requests and retains root when status fails', async (t) => {
  const f = fixture(t);
  const timeouts: number[] = [];
  const metadata = await collectMetadata(2, f.temp, [], async (_cwd, args, timeout) => {
    timeouts.push(timeout);
    if (args[0] === 'rev-parse') return f.temp + '\n';
    throw new Error('status unavailable');
  });
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts.every((timeout) => timeout > 0 && timeout <= 750));
  assert.equal(metadata.git?.root, f.temp);
  assert.equal(metadata.git?.dirty, null);
  assert.equal(metadata.git?.error, 'status unavailable');
});
