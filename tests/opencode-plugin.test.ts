import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { collectMetadata } from '../plugins/opencode-tool-logger/context.ts';
import { appendV1Event, appendV2Event } from '../plugins/opencode-tool-logger/log.ts';
import { promoteV2 } from '../plugins/opencode-tool-logger/state.ts';
import opencodeToolLoggerV1 from '../plugins/opencode-tool-logger/v1.ts';
import opencodeToolLoggerV2 from '../plugins/opencode-tool-logger/v2.ts';
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

test('V1 hooks preserve both native callback values and session metadata', (t) => {
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
  const actual = records(f.log);
  assert.equal(actual.length, 2);
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

test('V2 registers native hooks, resolves session cwd, and records success and error', async (t) => {
  const f = fixture(t);
  let before: ((event: unknown) => void | Promise<void>) | undefined;
  let after: ((event: unknown) => void | Promise<void>) | undefined;
  let sessionReads = 0;
  const success = {
    tool: 'read', sessionID: 'session-v2', agent: 'build', messageID: 'message-1',
    id: 'call-1', input: { filePath: '/tmp/a' }, status: 'completed',
    result: { content: 'value', metadata: { bytes: 5 } }, future: true,
  };
  const failure = {
    tool: 'bash', sessionID: 'session-v2', agent: 'build', messageID: 'message-2',
    id: 'call-2', input: { command: 'false' }, status: 'error',
    error: { name: 'ToolError', message: 'failed' },
  };
  await withStateDirectoryAsync(f.directory, async () => {
    await opencodeToolLoggerV2.setup({
      tool: { hook: async (name, callback) => {
        if (name === 'execute.before') before = callback;
        else after = callback;
      } },
      session: { get: async () => {
        sessionReads += 1;
        return { location: { directory: f.temp } };
      } },
      location: { directory: '/plugin-location' },
    });
    if (!before || !after) throw new Error('hooks not registered');
    await before({ ...success, status: undefined, result: undefined });
    await after(success);
    await after(failure);
  });
  const actual = records(f.log);
  assert.equal(actual.length, 3);
  assert.deepEqual(actual.map((value) => value.api_version), [2, 2, 2]);
  assert.deepEqual(actual.map((value) => value.hook), [
    'tool.execute.before', 'tool.execute.after', 'tool.execute.after',
  ]);
  assert.deepEqual(actual[1]?.event, success);
  assert.deepEqual(actual[2]?.event, failure);
  assert.equal(object(actual[2]?.metadata).session_cwd, f.temp);
  assert.equal(sessionReads, 1);
  assert.equal(statSync(f.log).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.directory, 'opencode-v2-intent.json')).mode & 0o777, 0o600);
});

test('V2 records session lookup failure and uses plugin-location fallback', async (t) => {
  const f = fixture(t);
  let before: ((event: unknown) => void | Promise<void>) | undefined;
  await withStateDirectoryAsync(f.directory, async () => {
    await opencodeToolLoggerV2.setup({
      tool: { hook: async (name, callback) => { if (name === 'execute.before') before = callback; } },
      session: { get: async () => { throw new Error('session unavailable'); } },
      location: { directory: f.temp },
    });
    if (!before) throw new Error('before hook not registered');
    await before({ tool: 'read', sessionID: 'missing', id: 'call' });
  });
  const metadata = object(records(f.log)[0]?.metadata);
  assert.equal(metadata.session_cwd, f.temp);
  assert.match(JSON.stringify(metadata.errors), /"source":"session","message":"session unavailable"/);
});

test('V2 bounds stalled session lookup and still records the event', async (t) => {
  const f = fixture(t);
  let before: ((event: unknown) => void | Promise<void>) | undefined;
  await withStateDirectoryAsync(f.directory, async () => {
    await opencodeToolLoggerV2.setup({
      tool: { hook: async (name, callback) => { if (name === 'execute.before') before = callback; } },
      session: { get: () => new Promise(() => { /* Deliberately stalled client. */ }) },
      location: { directory: f.temp },
    });
    if (!before) throw new Error('before hook not registered');
    const started = performance.now();
    await before({ tool: 'read', sessionID: 'stalled', id: 'call' });
    assert.ok(performance.now() - started < 1_000);
  });
  const metadata = object(records(f.log)[0]?.metadata);
  assert.equal(metadata.session_cwd, f.temp);
  assert.match(JSON.stringify(metadata.errors), /session lookup timed out/);
});

test('V2 promotion preserves V1 history and permanently suppresses later V1 writes', async (t) => {
  const f = fixture(t);
  mkdirSync(f.directory, { recursive: true });
  appendV1Event('tool.execute.before', { callID: 'old' }, { args: {} }, f.temp, f.directory);
  const original = readFileSync(f.log, 'utf8');
  const codex = join(f.directory, 'codex-tool-calls.jsonl');
  writeFileSync(codex, 'codex stays\n');
  await promoteV2(f.directory);
  assert.equal(readFileSync(f.log, 'utf8'), original);
  assert.equal(readFileSync(codex, 'utf8'), 'codex stays\n');
  assert.ok(existsSync(join(f.directory, 'opencode-v2-intent.json')));
  assert.ok(existsSync(join(f.directory, 'opencode-v2-active.json')));
  assert.equal(appendV1Event('tool.execute.after', { callID: 'late' }, {}, f.temp, f.directory), false);
  assert.equal(readFileSync(f.log, 'utf8'), original);
  appendV2Event('tool.execute.before', { id: 'v2' }, f.temp, [], f.directory);
  const afterActivation = readFileSync(f.log, 'utf8');
  assert.deepEqual(records(f.log).map((value) => value.api_version), [1, 2]);
  await promoteV2(f.directory);
  assert.equal(readFileSync(f.log, 'utf8'), afterActivation);
});

test('V1 checks V2 intent before and after opening without writing', (t) => {
  const f = fixture(t);
  let checks = 0;
  let writes = 0;
  const afterOpen = appendV1Event(
    'tool.execute.before', {}, {}, f.temp, f.directory,
    () => { writes += 1; return 0; },
    () => { checks += 1; return checks === 2; },
  );
  assert.equal(afterOpen, false);
  assert.equal(checks, 2);
  assert.equal(writes, 0);
  assert.equal(readFileSync(f.log, 'utf8'), '');
  rmSync(f.directory, { recursive: true });
  checks = 0;
  const beforeOpen = appendV1Event(
    'tool.execute.before', {}, {}, f.temp, f.directory, undefined,
    () => { checks += 1; return true; },
  );
  assert.equal(beforeOpen, false);
  assert.equal(checks, 1);
  assert.equal(existsSync(f.log), false);
});

test('concurrent and interrupted V2 promotions converge on one active generation', async (t) => {
  const f = fixture(t);
  mkdirSync(f.directory, { recursive: true });
  writeFileSync(f.log, 'old V1 data\n');
  const lock = join(f.directory, '.opencode-v2-promotion.lock');
  writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647 }) + '\n');
  const old = new Date(Date.now() - 10_000);
  utimesSync(lock, old, old);
  await Promise.all(Array.from({ length: 20 }, () => promoteV2(f.directory)));
  assert.ok(existsSync(join(f.directory, 'opencode-v2-active.json')));
  assert.equal(existsSync(lock), false);
  assert.equal(readFileSync(f.log, 'utf8'), 'old V1 data\n');
});

test('large concurrent process appends remain complete JSONL records', async (t) => {
  const f = fixture(t);
  await promoteV2(f.directory);
  const module = pathToFileURL(join(process.cwd(), 'plugins/opencode-tool-logger/log.ts')).href;
  const source = `import {appendV2Event} from ${JSON.stringify(module)}; appendV2Event('tool.execute.after',{id:process.argv[1],large:'🐟\\n'.repeat(25000)},null);`;
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
  mkdirSync(f.directory, { recursive: true });
  const target = join(f.temp, 'keep');
  writeFileSync(target, 'keep');
  symlinkSync(target, f.log);
  withStateDirectory(f.directory, () => {
    const hooks = opencodeToolLoggerV1({ directory: f.temp });
    assert.doesNotThrow(() => hooks['tool.execute.after']({}, {}));
  });
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.ok((statSync(f.directory).mode & 0o777) === 0o700);
});

test('metadata bounds Git requests and retains root when status fails', (t) => {
  const f = fixture(t);
  const timeouts: number[] = [];
  const metadata = collectMetadata(2, f.temp, [], (_cwd, args, timeout) => {
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
