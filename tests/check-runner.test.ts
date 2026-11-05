import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { platform } from 'node:process';
import test from 'node:test';
import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tl-check-runner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'commands');
  const source = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.CHECK_TEST_LOG, JSON.stringify([tool, ...args]) + '\\n');
if (process.env.CHECK_TEST_FAILURE === 'vet' && tool === 'go' && args[0] === 'vet') process.exit(3);
if (process.env.CHECK_TEST_FAILURE === 'display' && tool === 'xvfb-run') process.exit(1);
if (args.includes('-json')) {
  for (const name of ['TestDesktopQuitLeavesCollectorRunning', 'TestDesktopConnectionsKeepNativeProfilesAndHistoriesSeparate']) {
    console.log(JSON.stringify({ Test: name, Action: process.env.CHECK_TEST_FAILURE === 'skip' ? 'skip' : 'pass' }));
  }
}
`;
  for (const name of ['node', 'pnpm', 'go', 'xvfb-run']) writeFileSync(join(directory, name), source, { mode: 0o755 });
  const run = (mode: string, failure = '') => spawnSync(process.execPath, [resolve(import.meta.dirname, '../scripts/check-pr.ts'), mode], {
    encoding: 'utf8', env: { ...process.env, PATH: directory, DISPLAY: '', WAYLAND_DISPLAY: '', CHECK_TEST_LOG: log, CHECK_TEST_FAILURE: failure },
  });
  return { run, commands: () => readFileSync(log, 'utf8').trim().split('\n').map((line): unknown => JSON.parse(line)) };
}

test('full gate builds frontend once, uses fresh process tests and runs native automation before packaging', (t) => {
  const f = fixture(t);
  const result = f.run('full');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const commands = f.commands().map((command) => JSON.stringify(command));
  assert.equal(commands.filter((command) => command.includes('@tool-logger/web') && command.includes('"build"')).length, 1);
  assert.ok(commands.some((command) => command.includes('"-race"') && command.includes('"-count=1"')));
  const native = commands.findIndex((command) => command.includes('"-json"'));
  const packaging = commands.findIndex((command) => command.includes('"pnpm","build:prepared"'));
  assert.ok(native >= 0 && packaging > native);
});

test('failed boundary checks stop the gate before native automation or packaging', (t) => {
  const f = fixture(t);
  const result = f.run('full', 'vet');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed with 3/);
  assert.doesNotMatch(result.stdout, /full passed/);
  assert.ok(f.commands().every((command) => !JSON.stringify(command).includes('"-json"') && !JSON.stringify(command).includes('"build:prepared"')));
});

test('zero-exit native skips fail the gate and prevent packaging', (t) => {
  const f = fixture(t);
  const result = f.run('full', 'skip');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skipped or missing tests do not pass/);
  assert.ok(f.commands().every((command) => !JSON.stringify(command).includes('"build:prepared"')));
});

test('missing Linux display support blocks native checks before builds, while default stays headless', { skip: platform !== 'linux' }, (t) => {
  const f = fixture(t);
  const full = f.run('full', 'display');
  assert.equal(full.status, 1);
  assert.match(full.stderr, /needs a display or xvfb-run/);
  assert.equal(f.commands().length, 1);
  const headless = f.run('default', 'display');
  assert.equal(headless.status, 0, headless.stdout + headless.stderr);
});

test('selection-only invocation defaults to PR mode and starts no checks', (t) => {
  const f = fixture(t);
  const result = f.run('--list');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[check\] pr: default checks/);
  assert.doesNotMatch(result.stdout, /\[check\] frontend build/);
});
