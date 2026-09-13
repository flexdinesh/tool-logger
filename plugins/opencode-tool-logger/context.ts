import { execFile } from 'node:child_process';
import { hostname, release } from 'node:os';
import { resolve } from 'node:path';

export type MetadataError = { source: string; message: string };
export type GitRunner = (cwd: string, args: string[], timeout: number) => Promise<string>;

const GIT_BUDGET_MS = 750;
const COLLECTOR_VERSION = '0.1.0';

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1024);
}

const runGit: GitRunner = (cwd, args, timeout) => new Promise((resolve, reject) => {
  execFile('git', ['--no-optional-locks', '-C', cwd, ...args], {
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
    windowsHide: true,
  }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

async function gitContext(cwd: string, git: GitRunner) {
  const deadline = performance.now() + GIT_BUDGET_MS;
  function query(args: string[]): Promise<string> {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return Promise.reject(new Error('Git metadata collection timed out'));
    return git(cwd, args, remaining);
  }
  const root = (await query(['rev-parse', '--show-toplevel'])).trimEnd();
  try {
    const status = await query(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
    const entries = status.split('\0').filter(Boolean);
    const headers = new Map<string, string>();
    let index = 0;
    for (const entry of entries) {
      if (!entry.startsWith('# ')) break;
      const separator = entry.indexOf(' ', 2);
      if (separator > 0) headers.set(entry.slice(2, separator), entry.slice(separator + 1));
      index += 1;
    }
    return {
      root, branch: headers.get('branch.head') ?? null,
      commit: headers.get('branch.oid') ?? null,
      upstream: headers.get('branch.upstream') ?? null,
      ahead_behind: headers.get('branch.ab') ?? null,
      dirty: entries.length > index,
      status_porcelain_v2: status,
      error: null,
    };
  } catch (error) {
    return {
      root, branch: null, commit: null, upstream: null, ahead_behind: null,
      dirty: null, status_porcelain_v2: null, error: message(error),
    };
  }
}

export async function collectMetadata(
  apiVersion: 1 | 2,
  sessionCwd: string | null,
  initialErrors: MetadataError[] = [],
  git: GitRunner = runGit,
) {
  const started = performance.now();
  const errors = [...initialErrors];
  function optional<T>(source: string, collect: () => T): T | null {
    try { return collect(); }
    catch (error) { errors.push({ source, message: message(error) }); return null; }
  }
  async function optionalAsync<T>(source: string, collect: () => Promise<T>): Promise<T | null> {
    try { return await collect(); }
    catch (error) { errors.push({ source, message: message(error) }); return null; }
  }
  const hookCwd = optional('hook_cwd', () => process.cwd());
  const repository = sessionCwd
    ? await optionalAsync('git', () => gitContext(sessionCwd, git)) : null;
  const bunVersion = process.versions.bun;
  return {
    collector: {
      name: 'opencode-tool-logger', version: COLLECTOR_VERSION, api_version: apiVersion,
      runtime: bunVersion ? 'bun' : 'node', runtime_version: bunVersion ?? process.version,
      node_version: process.version, executable: process.execPath,
      pid: process.pid, parent_pid: process.ppid, cwd: hookCwd,
      plugin_root: resolve(import.meta.dirname),
    },
    host: {
      hostname: optional('hostname', hostname), platform: process.platform,
      architecture: process.arch, os_release: optional('os_release', release),
      timezone: optional('timezone', () => Intl.DateTimeFormat().resolvedOptions().timeZone),
    },
    session_cwd: sessionCwd,
    git: repository,
    collection_ms: Math.round((performance.now() - started) * 100) / 100,
    errors,
  };
}

export function errorMessage(error: unknown): string {
  return message(error);
}
