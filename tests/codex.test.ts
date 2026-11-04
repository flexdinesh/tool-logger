import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CATALOG, ROOT, linkCodexPlugin, object } from '../scripts/workspace.ts';

function listHooks(cwd: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let finished = false;
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error(`hooks/list timed out: ${stderr}`)), 20_000);
    function finish(error?: Error, result?: unknown) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(result);
    }
    function send(value: unknown) { child.stdin.write(JSON.stringify(value) + '\n'); }
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(new Error(`app-server exited ${code}: ${stderr}`)));
    child.stdin.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const value: unknown = JSON.parse(line);
          const message = object(value);
          if (message.error) throw new Error(JSON.stringify(message.error));
          if (message.id === 1) {
            send({ method: 'initialized' });
            send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
          }
          if (message.id === 2) finish(undefined, message.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'local-plugin-test', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    } });
  });
}

test('real Codex loads both linked hooks and their commands run under fish when available', async (t) => {
  const available = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT') {
    t.skip('Codex CLI is not installed');
    return;
  }
  assert.equal(available.status, 0, available.stderr);
  const temp = mkdtempSync(join(tmpdir(), 'codex-loader-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'repo');
  cpSync(join(ROOT, 'plugins'), join(root, 'plugins'), { recursive: true });
  mkdirSync(dirname(join(root, CATALOG)), { recursive: true });
  cpSync(join(ROOT, CATALOG), join(root, CATALOG));
  const codexHome = join(temp, 'codex');
  mkdirSync(codexHome);
  const env = { ...process.env, CODEX_HOME: codexHome, TOOL_LOGGER_STATE_DIR: join(temp, 'logs') };
  linkCodexPlugin(root, 'codex-tool-logger', {
    codexHome,
    runCodex: (args) => { execFileSync('codex', args, { env, timeout: 20_000, stdio: 'pipe' }); },
  });
  const result = object(await listHooks(root, env));
  assert.ok(Array.isArray(result.data));
  const entry = object(result.data[0]);
  assert.deepEqual(entry.errors, []);
  assert.ok(Array.isArray(entry.hooks));
  const hooks = entry.hooks.map(object).filter((hook) => hook.pluginId === 'codex-tool-logger@tool-logger');
  assert.deepEqual(hooks.map((hook) => hook.eventName).sort(), ['postToolUse', 'preToolUse'], JSON.stringify(result));
  for (const hook of hooks) {
    assert.equal(hook.enabled, true);
    assert.equal(hook.trustStatus, 'untrusted', 'installation must not bypass hook trust');
    assert.equal(typeof hook.command, 'string');
    const shell = ['/usr/bin/fish', '/opt/homebrew/bin/fish'].find((path) => existsSync(path)) ?? '/bin/sh';
    const stdout = execFileSync(shell, ['-c', String(hook.command)], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({
        hook_event_name: hook.eventName === 'preToolUse' ? 'PreToolUse' : 'PostToolUse',
        cwd: root, tool_name: 'integration-check', session_id: 'test', tool_use_id: '1',
      }),
    });
    assert.equal(stdout, '');
  }
  const lines = readFileSync(join(env.TOOL_LOGGER_STATE_DIR, 'outbox/codex-tool-calls.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
});
