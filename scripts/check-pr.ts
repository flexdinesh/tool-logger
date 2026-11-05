import { spawn, spawnSync } from 'node:child_process';
import { realpathSync, readdirSync } from 'node:fs';
import { arch, platform } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { changedFiles, selectChecks } from './check-plan.ts';
import type { CheckMode } from './check-plan.ts';

type Command = [string, ...string[]];
type Task = { name: string; commands: Command[]; cwd?: string; env?: NodeJS.ProcessEnv; native?: boolean };
const root = resolve(import.meta.dirname, '..');
const desktop = resolve(root, 'apps/desktop');
const nativeTests: Command = ['go', 'test', '-vet=off', '-tags', 'e2e', './internal/desktop', './cmd/tool-logger-desktop', '-count=1', '-json'];
const requiredNativeTests = ['TestDesktopQuitLeavesCollectorRunning', 'TestDesktopConnectionsKeepNativeProfilesAndHistoriesSeparate'];

function e2eCommand(os: NodeJS.Platform, hasDisplay: boolean, hasXvfb: boolean, command: Command): Command {
  if (os !== 'linux' || hasDisplay) return command;
  if (hasXvfb) return ['xvfb-run', '-a', ...command];
  throw new Error('Linux native automation needs a display or xvfb-run; install Xvfb or use a desktop session');
}

async function run(command: Command, task: Task): Promise<void> {
  const [file, ...args] = command;
  const child = spawn(file, args, { cwd: task.cwd ?? root, env: task.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const nativePassed = new Set<string>();
  let nativeSkipped = false;
  let pending = '';
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    if (!task.native) return;
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      if (typeof event !== 'object' || event === null || !('Test' in event) || !('Action' in event)) continue;
      if (event.Action === 'skip') nativeSkipped = true;
      if (event.Action === 'pass' && typeof event.Test === 'string') nativePassed.add(event.Test);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) reject(new Error(`${task.name}: ${command.join(' ')} failed with ${signal ?? code}`));
      else if (task.native && (nativeSkipped || requiredNativeTests.some((name) => !nativePassed.has(name)))) reject(new Error('Native automation must execute and pass both process tests; skipped or missing tests do not pass'));
      else resolve();
    });
  });
}

async function runTasks(tasks: Task[]): Promise<void> {
  const queue = tasks.values();
  let failed = false;
  const worker = async () => {
    for (const task of queue) {
      if (failed) return;
      const started = performance.now();
      console.log(`\n[check] ${task.name}`);
      try {
        for (const command of task.commands) await run(command, task);
      } catch (error) { failed = true; throw error; }
      console.log(`[check] ${task.name}: ${((performance.now() - started) / 1000).toFixed(2)}s`);
    }
  };
  const results = await Promise.allSettled([worker(), worker()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

async function check(mode: CheckMode, list: boolean): Promise<void> {
  let paths: string[] | null = null;
  if (mode === 'pr') {
    try { paths = changedFiles(root); }
    catch (error) { console.error(`[check] Full fallback: ${error instanceof Error ? error.message : error}`); }
  }
  const selected = selectChecks(mode, paths);
  console.log(`[check] ${mode}: default checks${selected.size ? ', ' + [...selected.keys()].join(', ') : ''}`);
  for (const [suite, reasons] of selected) console.log(`[check] ${suite}: ${reasons.join(', ')}`);
  if (list) return;
  // Resolve required display support before spending time on other checks.
  const native = selected.has('native') ? e2eCommand(platform, Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY), spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status === 0, nativeTests) : null;
  const started = performance.now();
  await runTasks([
    { name: 'static and contract checks', commands: [
      ['node', 'scripts/workspace.ts', 'check'], ['node', 'scripts/installers.ts', '--check'],
      ['pnpm', '--filter', '@tool-logger/transport', 'check'], ['pnpm', '--filter', '@tool-logger/protocol', 'check'], ['pnpm', 'typecheck'],
    ] },
    { name: 'frontend build', commands: [['pnpm', '--filter', '@tool-logger/web', 'build']] },
  ]);
  const excluded = new Set(['distribution.test.ts', 'codex.test.ts', 'opencode-loader.test.ts']);
  const tests = readdirSync(resolve(root, 'tests')).filter((name) => name.endsWith('.test.ts') && !excluded.has(name)).sort().map((name) => 'tests/' + name);
  const goCommands: Command[] = selected.has('go')
    ? [['go', 'test', '-vet=off', '-race', '-count=1', './...']]
    : [
      ['go', 'test', '-vet=off', './apps/server/internal/harnesses', './apps/server/internal/sqlite', './apps/server/internal/httpapi', './packages/client', './packages/webui'],
      ['go', 'test', '-vet=off', '-count=1', './apps/server/internal/app', './apps/desktop/internal/desktop'],
    ];
  // Execute cross-language boundary tests: Go cannot observe files opened by
  // Node subprocesses. Compilation still uses the normal Go build cache.
  const tasks: Task[] = [
    { name: 'Node features', commands: [['node', '--test', ...tests], ['pnpm', '--filter', '@tool-logger/web', 'test']] },
    { name: selected.has('go') ? 'Go race and process contracts' : 'Go boundary contracts', commands: [['go', 'vet', './...'], ...goCommands] },
    { name: 'transport contracts', commands: [['node', '--test', ...(selected.has('transport') ? [] : ['--test-skip-pattern=^large backlog']), 'packages/transport/tests/transport.test.ts', 'packages/transport/tests/unix.test.ts']] },
  ];
  if (selected.has('distribution')) tasks.push({ name: 'distribution contracts', commands: [['node', '--test', 'tests/distribution.test.ts']] });
  if (selected.has('harness')) tasks.push({ name: 'installed harness contracts (availability reported by each test)', commands: [['node', '--test', 'tests/codex.test.ts', 'tests/opencode-loader.test.ts']] });
  if (selected.has('transport')) tasks.push({ name: 'deployment contracts (availability reported by each test)', commands: [['node', '--test', '--test-concurrency=1', 'packages/transport/tests/deployment.test.ts']] });
  if (selected.has('browser')) tasks.push({ name: 'browser features', cwd: resolve(root, 'apps/web'), commands: [['pnpm', 'exec', 'playwright', 'test']] });
  await runTasks(tasks);
  // Native processes and packaging share generated resources. Run after the
  // parallel tasks and never rebuild the frontend here.
  if (native) await runTasks([{ name: 'native automation', cwd: desktop, env: { ...process.env, TOOL_LOGGER_NATIVE_E2E: '1' }, native: true, commands: [native] }]);
  if (selected.has('package')) await runTasks([{ name: 'host packaging', cwd: desktop, commands: [['go', 'tool', 'mygo', 'vet'], ['pnpm', 'build:prepared']] }]);
  console.log(`[check] ${mode} passed on ${platform}/${arch} in ${((performance.now() - started) / 1000).toFixed(2)}s. Other platforms not verified. Optional harness/deployment skips remain unverified.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => arg !== '--list');
  const mode = positional[0] ?? 'pr';
  if ((mode !== 'default' && mode !== 'pr' && mode !== 'full') || positional.length > 1) {
    console.error('Usage: node scripts/check-pr.ts [default|pr|full] [--list]');
    process.exitCode = 1;
  } else await check(mode, args.includes('--list')).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
