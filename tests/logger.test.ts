import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  readdirSync, statSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { appendEvent, parseEvent, stateDirectory } from '../plugins/codex-tool-logger/scripts/log-tool-call.ts';
import { collectMetadata } from '../plugins/codex-tool-logger/scripts/context.ts';
import { ensureState } from '../plugins/codex-tool-logger/scripts/state.ts';
import { object, readJson, ROOT } from '../scripts/workspace.ts';

const plugin = join(ROOT, 'plugins/codex-tool-logger');
const script = join(plugin, 'scripts/log-tool-call.ts');

function event(index = 0, phase = 'PreToolUse') {
  return {
    hook_event_name: phase, session_id: 'session-1', turn_id: 'turn-1',
    tool_use_id: `call-${index}`, tool_name: 'mcp__example__read',
    tool_input: { text: 'new\nline: café 🐟', index },
  };
}

function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'codex logger '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const directory = join(temp, 'state');
  const log = join(directory, 'codex-tool-calls.jsonl');
  function run(input: string, command = process.execPath, args = [script], extraEnv = {}) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: temp, env: { ...process.env, TOOL_LOGGER_STATE_DIR: directory, ...extraEnv },
        stdio: 'pipe', timeout: 10_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.on('error', reject);
      child.stdin.end(input);
    });
  }
  return { temp, directory, log, run, invoke: (value: unknown) => run(JSON.stringify(value)) };
}

function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => {
    const value: unknown = JSON.parse(line);
    return object(value);
  });
}

test('preserves existing bytes and full pre/post events, with silent stdout', async (t) => {
  const f = fixture(t);
  mkdirSync(f.directory);
  const prefix = '{"existing":true}\n';
  writeFileSync(f.log, prefix);
  const events = [event(), { ...event(0, 'PostToolUse'), tool_response: { ok: true } }];
  for (const value of events) {
    const result = await f.invoke(value);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.ok(readFileSync(f.log, 'utf8').startsWith(prefix));
  const added = records(f.log).slice(1);
  assert.deepEqual(added.map((record) => record.event), events);
  for (const record of added) {
    assert.equal(record.schema_version, 2);
    assert.equal(record.harness, 'codex');
    assert.equal(typeof record.event_id, 'string');
    assert.equal(typeof record.logged_at, 'string');
    assert.ok(record.hook === 'PreToolUse' || record.hook === 'PostToolUse');
    assert.ok(Number.isFinite(Date.parse(String(record.logged_at))));
  }
});

test('40 concurrent processes preserve large records without loss or interleaving', async (t) => {
  const f = fixture(t);
  const events = Array.from({ length: 40 }, (_, index) => ({
    ...event(index), tool_input: { index, large: '🐟\n'.repeat(25_000) },
  }));
  const results = await Promise.all(events.map(f.invoke));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const actual = records(f.log).map((record) => object(record.event));
  assert.deepEqual(readJson(join(f.directory, 'state.json')), { schema_version: 1, home_directory: homedir() });
  assert.equal(readdirSync(f.directory).some((name) => name.endsWith('.tmp')), false);
  assert.equal(actual.length, events.length);
  assert.deepEqual(
    new Map(actual.map((value) => [value.tool_use_id, value])),
    new Map(events.map((value) => [value.tool_use_id, value])),
  );
});

test('creates private state directory and file', async (t) => {
  const f = fixture(t);
  const result = await f.invoke(event());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(statSync(f.log).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.directory, 'state.json')).mode & 0o777, 0o600);
});

test('state preserves the original host home and never rewrites existing state or log bytes', (t) => {
  const f = fixture(t);
  ensureState(f.directory, '/Users/original');
  const path = join(f.directory, 'state.json');
  const initial = readFileSync(path);
  const modified = statSync(path).mtimeMs;
  writeFileSync(f.log, 'existing log bytes\n');
  ensureState(f.directory, '/root');
  assert.deepEqual(readFileSync(path), initial);
  assert.equal(statSync(path).mtimeMs, modified);
  assert.equal(readFileSync(f.log, 'utf8'), 'existing log bytes\n');
});

test('state creation failure is recorded without preventing tool logging', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.directory, 'state.json'), { recursive: true });
  appendEvent(event(), f.directory);
  const record = records(f.log)[0];
  assert.ok(record);
  assert.deepEqual(record.event, event());
  assert.match(JSON.stringify(object(record.metadata).errors), /state.json must be a regular file/);
});

test('preserves all Codex fields and records collector and transcript metadata', async (t) => {
  const f = fixture(t);
  const transcript = join(f.temp, 'transcript.jsonl');
  writeFileSync(transcript, 'transcript content stays in its own file\n');
  const payload = {
    ...event(), cwd: f.temp, model: 'example-model', permission_mode: 'default',
    transcript_path: transcript, future_extension: { nested: ['untouched', 42, null] },
  };
  const result = await f.run(JSON.stringify(payload), process.execPath, [script], {
    TEST_UNRELATED_SECRET: 'do-not-copy-environment',
  });
  assert.equal(result.code, 0, result.stderr);
  const stored = records(f.log)[0];
  assert.ok(stored);
  assert.deepEqual(stored.event, payload);
  const metadata = object(stored.metadata);
  const collector = object(metadata.collector);
  assert.equal(collector.name, 'codex-tool-logger');
  assert.equal(collector.version, '0.2.0');
  assert.equal(collector.node_version, process.version);
  assert.equal(typeof collector.pid, 'number');
  assert.equal(object(metadata.host).platform, process.platform);
  const file = object(metadata.transcript);
  assert.equal(file.path, transcript);
  assert.equal(file.size_bytes, statSync(transcript).size);
  assert.equal(file.exists, true);
  assert.equal(file.is_file, true);
  assert.doesNotMatch(JSON.stringify(metadata), /do-not-copy-environment|transcript content stays/);
});

test('Git snapshots capture the event repository before and after changes', (t) => {
  const f = fixture(t);
  const git = (...args: string[]) => execFileSync('git', ['-C', f.temp, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'test-context');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Fixture');
  const commit = git('rev-parse', 'HEAD').trim();
  const before = collectMetadata({ ...event(), cwd: f.temp });
  assert.equal(before.git?.branch, 'test-context');
  assert.equal(before.git?.commit, commit);
  assert.equal(before.git?.dirty, false);
  writeFileSync(join(f.temp, 'new file.txt'), 'change');
  const after = collectMetadata({ ...event(0, 'PostToolUse'), cwd: f.temp });
  assert.equal(after.git?.dirty, true);
  assert.match(after.git?.status_porcelain_v2 ?? '', /\? new file.txt\0/);
});

test('missing transcripts and unavailable Git retain the event and explicit unknowns', (t) => {
  const f = fixture(t);
  const metadata = collectMetadata({ ...event(), cwd: f.temp, transcript_path: 'missing.jsonl' }, () => {
    throw new Error('Git unavailable');
  });
  assert.equal(metadata.git, null);
  assert.equal(metadata.transcript?.exists, false);
  assert.equal(metadata.transcript?.size_bytes, null);
  assert.deepEqual(metadata.errors, [{ source: 'git', message: 'Git unavailable' }]);
  appendEvent({ ...event(), cwd: join(f.temp, 'missing-directory') }, f.directory);
  assert.equal(records(f.log).length, 1);
});

test('Git enrichment has bounded requests and preserves root when status fails', (t) => {
  const f = fixture(t);
  const timeouts: number[] = [];
  const metadata = collectMetadata({ ...event(), cwd: f.temp }, (_cwd, args, timeout) => {
    timeouts.push(timeout);
    if (args[0] === 'rev-parse') return f.temp + '\n';
    throw new Error('status timed out');
  });
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts.every((timeout) => timeout > 0 && timeout <= 750));
  assert.equal(metadata.git?.root, f.temp);
  assert.equal(metadata.git?.dirty, null);
  assert.equal(metadata.git?.error, 'status timed out');
});

test('default path uses home/.local/state; supports explicit state override', (t) => {
  const f = fixture(t);
  const directory = stateDirectory('', f.temp);
  assert.equal(directory, join(f.temp, '.local/state/tool-logger'));
  appendEvent(event(), directory);
  assert.ok(existsSync(join(directory, 'codex-tool-calls.jsonl')));
  assert.equal(stateDirectory('~/custom', f.temp), join(f.temp, 'custom'));
  assert.equal(stateDirectory(f.directory), f.directory);
});

test('invalid events and malformed JSON fail without policy output or writes', async (t) => {
  const f = fixture(t);
  for (const input of ['[]', 'null', '{"hook_event_name":"Stop"}', 'not json']) {
    const result = await f.run(input);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /codex-tool-logger:/);
  }
  assert.equal(existsSync(f.log), false);
  assert.throws(() => parseEvent('{}'), /expected PreToolUse or PostToolUse/);
});

test('refuses symlink log destination without modifying its target', async (t) => {
  const f = fixture(t);
  mkdirSync(f.directory);
  const target = join(f.temp, 'keep.txt');
  writeFileSync(target, 'keep');
  symlinkSync(target, f.log);
  const result = await f.invoke(event());
  assert.equal(result.code, 1);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('write failures report failure without policy output', async (t) => {
  const f = fixture(t);
  writeFileSync(f.directory, 'not a directory');
  const result = await f.invoke(event());
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /codex-tool-logger:/);
});

test('short writes fail without retrying fragments or overwriting history', (t) => {
  const f = fixture(t);
  mkdirSync(f.directory);
  writeFileSync(f.log, 'existing\n');
  let calls = 0;
  assert.throws(() => appendEvent(event(), f.directory, (fd, data) => {
    calls += 1;
    return writeSync(fd, data.subarray(0, 5));
  }), /incomplete log write/);
  assert.equal(calls, 1);
  assert.equal(readFileSync(f.log, 'utf8'), 'existing\n{"sch');
});

test('packaged hooks run standalone and through symlinks from unrelated cwd', async (t) => {
  const f = fixture(t);
  const copy = join(f.temp, 'standalone plugin');
  const link = join(f.temp, 'plugin symlink');
  cpSync(plugin, copy, { recursive: true });
  symlinkSync(copy, link, 'dir');
  // Ensure the hook uses the same Node runtime as the test.
  const bin = join(f.temp, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  const hooks = object(readJson(join(copy, 'hooks/hooks.json')).hooks);
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse']);
  for (const root of [copy, link]) {
    for (const [phase, value] of Object.entries(hooks)) {
      assert.ok(Array.isArray(value));
      const groups: unknown[] = value;
      const group = object(groups[0]);
      assert.equal('matcher' in group, false);
      assert.ok(Array.isArray(group.hooks));
      const handlers: unknown[] = group.hooks;
      const command = object(handlers[0]).command;
      assert.ok(typeof command === 'string');
      const result = await f.run(JSON.stringify(event(0, phase)), '/bin/sh', ['-c', command], {
        PLUGIN_ROOT: root, PATH: `${bin}:${process.env.PATH ?? ''}`,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, '');
    }
  }
  assert.equal(records(f.log).length, 4);
});
