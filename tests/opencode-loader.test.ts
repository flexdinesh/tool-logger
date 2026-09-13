import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function serverUrl(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`OpenCode server did not start: ${output}`)), 10_000);
    const done = (url: string) => {
      clearTimeout(timeout);
      resolve(url);
    };
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`OpenCode server exited ${code}: ${output}`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = output.match(/server listening on (http:\/\/[^\s]+)/);
      if (match?.[1]) done(match[1]);
    });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  });
}

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

test('installed OpenCode V2 activates the linked plugin', async (t) => {
  const available = spawnSync('opencode2', ['--version'], { stdio: 'ignore' });
  if (available.error || available.status !== 0) {
    t.skip('opencode2 is not installed');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'opencode loader '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const plugins = join(root, 'opencode', 'plugins');
  const state = join(root, 'state');
  mkdirSync(plugins, { recursive: true });
  mkdirSync(project);
  const entrypoint = fileURLToPath(new URL('../plugins/opencode-tool-logger/v2.ts', import.meta.url));
  symlinkSync(entrypoint, join(plugins, 'opencode-tool-logger.ts'));
  const password = 'tool-logger-loader-test';
  const environment = { ...process.env, XDG_CONFIG_HOME: root, TOOL_LOGGER_STATE_DIR: state,
    OPENCODE_SERVER_PASSWORD: password };
  const child = spawn('opencode2', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => new Promise<void>((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill();
  }));
  const url = await serverUrl(child);
  execFileSync('opencode2', ['api', '--server', url, 'v2.plugin.list'], {
    cwd: project,
    env: environment,
    stdio: 'pipe',
    timeout: 15_000,
  });
  const intent = join(state, 'opencode-v2-intent.json');
  const active = join(state, 'opencode-v2-active.json');
  await waitForFiles([intent, active]);
  assert.equal(existsSync(intent), true);
  assert.equal(existsSync(active), true);
});
