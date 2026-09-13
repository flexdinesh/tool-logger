import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PLUGIN_ID = 'opencode-tool-logger';
const PASSWORD = 'tool-logger-loader-test';

function majorVersion(output: string | null): number | null {
  if (!output) return null;
  const match = output.match(/\bv?(\d+)\./);
  if (!match?.[1]) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isNaN(major) ? null : major;
}

function installedCommand(): string | null {
  const stable = spawnSync('opencode', ['--version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
  });
  const stableMajor = majorVersion(stable.stdout);
  if (!stable.error && stable.status === 0 && stableMajor !== null && stableMajor >= 2) {
    return 'opencode';
  }
  const preview = spawnSync('opencode2', ['--version'], {
    stdio: 'ignore', timeout: 5_000,
  });
  return !preview.error && preview.status === 0 ? 'opencode2' : null;
}

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

function pluginIds(value: unknown): string[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('location' in value) || typeof value.location !== 'object' || value.location === null) {
    return null;
  }
  if (!('data' in value) || !Array.isArray(value.data)) return null;
  const ids: string[] = [];
  for (const entry of value.data) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    if (!('id' in entry) || typeof entry.id !== 'string') return null;
    ids.push(entry.id);
  }
  return ids;
}

async function waitForPlugin(url: string, project: string): Promise<string[]> {
  const deadline = Date.now() + 15_000;
  let detail = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/plugin', url), {
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`,
          'x-opencode-directory': project,
        },
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.text();
      detail = `HTTP ${response.status}: ${body}`;
      if (response.ok) {
        const value: unknown = JSON.parse(body);
        const ids = pluginIds(value);
        if (ids?.includes(PLUGIN_ID)) return ids;
        if (!ids) detail = `invalid plugin response: ${body}`;
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  throw new Error(`OpenCode did not load ${PLUGIN_ID}: ${detail}`);
}

async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  child.kill();
  await Promise.race([
    exited,
    new Promise<void>((resolve) => { setTimeout(resolve, 2_000); }),
  ]);
  if (child.exitCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    new Promise<void>((resolve) => { setTimeout(resolve, 2_000); }),
  ]);
}

test('installed OpenCode V2 activates the linked plugin', async (t) => {
  const command = installedCommand();
  if (!command) {
    t.skip('OpenCode V2 is not installed');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'opencode loader '));
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (child) await stopServer(child);
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(root, 'project');
  const plugins = join(root, 'opencode', 'plugins');
  const state = join(root, 'state');
  mkdirSync(plugins, { recursive: true });
  mkdirSync(project);
  const entrypoint = fileURLToPath(new URL('../plugins/opencode-tool-logger/v2.ts', import.meta.url));
  const linkedEntrypoint = join(plugins, 'opencode-tool-logger.ts');
  symlinkSync(entrypoint, linkedEntrypoint);
  writeFileSync(join(project, 'opencode.json'), `${JSON.stringify({ plugins: [linkedEntrypoint] })}\n`);
  const environment = { ...process.env, XDG_CONFIG_HOME: root, TOOL_LOGGER_STATE_DIR: state,
    OPENCODE_SERVER_PASSWORD: PASSWORD };
  child = spawn(command, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await serverUrl(child);
  const ids = await waitForPlugin(url, project);
  assert.equal(ids.includes(PLUGIN_ID), true);
});
