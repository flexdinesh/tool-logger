import { createReadStream, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureSource, loadSourceConfig, readPrivateJson, stateDirectory } from './config.ts';
import { runForwarder } from './forwarder.ts';
import { code, object, readJson } from './persistence.ts';

async function stdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 64 * 1024) throw new Error('Input too large');
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return value;
}

export async function sourceStatus(directory = stateDirectory()): Promise<Record<string, unknown>> {
  let config;
  try { config = await loadSourceConfig(directory); }
  catch { return { status: 'error', lastError: 'Source configuration unavailable or invalid', token: '[REDACTED]' }; }
  let health: unknown;
  try { health = await readJson(join(directory, 'outbox/health.json')); }
  catch (error) {
    return {
      status: code(error) === 'ENOENT' ? (config ? 'not_running' : 'waiting_configuration') : 'error',
      sourceId: config?.sourceId ?? null,
      token: '[REDACTED]',
    };
  }
  // Allowlist diagnostics. A tampered health file must not expose arbitrary fields.
  if (!object(health)) return { status: 'error', token: '[REDACTED]' };
  let running = false;
  if (typeof health.pid === 'number' && Number.isSafeInteger(health.pid) && health.pid > 0) {
    try { process.kill(health.pid, 0); running = true; }
    catch { /* Dead worker or inaccessible process. */ }
  }
  const knownStatuses = ['waiting_configuration', 'ready', 'retrying', 'error', 'stopped'];
  const statuses = typeof health.status === 'string' && knownStatuses.includes(health.status) ? health.status : 'error';
  const safeErrors = new Set([
    '', 'Waiting for source.json; journals remain local', 'Invalid acknowledgement', 'Incomplete acknowledgement',
    'Connection failed, timed out, or acknowledgement invalid', 'Journal replaced or truncated',
    'Local state or source configuration unavailable; inspect private files',
    'Checkpoint unavailable; preserve it and repair or remove to replay safely',
    'Invalid checkpoint; remove to replay safely', 'Invalid journal checkpoint',
    'Source identity changed; use a fresh state directory',
    'Source identity differs from checkpoint; use a fresh state directory',
  ]);
  const lastError = typeof health.lastError === 'string' &&
      (safeErrors.has(health.lastError) || /^HTTP [1-5]\d\d$/.test(health.lastError))
    ? health.lastError : 'Inspect private health file';
  return {
    status: config ? (running ? statuses : 'not_running') : 'waiting_configuration', sourceId: config?.sourceId ?? null,
    pendingEvents: typeof health.pendingEvents === 'number' ? health.pendingEvents : null,
    rejectedEvents: typeof health.rejectedEvents === 'number' ? health.rejectedEvents : null,
    updatedAt: typeof health.updatedAt === 'string' && Number.isFinite(Date.parse(health.updatedAt)) ? health.updatedAt : null,
    nextRetryAt: typeof health.nextRetryAt === 'string' && Number.isFinite(Date.parse(health.nextRetryAt)) ? health.nextRetryAt : null,
    hasError: typeof health.lastError === 'string' && health.lastError.length > 0,
    lastError,
    token: '[REDACTED]',
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, input, ...extra] = args;
  const directory = stateDirectory();
  if (command === 'run' && input === undefined) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    // A private inherited pipe ties a supervised worker to its collector even
    // when the collector is killed. FD 4 retains the inherited worker flock.
    const owner = process.env.TOOL_LOGGER_OWNER_FD === '3'
      ? createReadStream('', { fd: 3, autoClose: true }) : null;
    owner?.once('end', stop); owner?.once('error', stop); owner?.resume();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await runForwarder(directory, { signal: controller.signal }); }
    finally { owner?.destroy(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } else if (command === 'status' && input === undefined) {
    console.log(JSON.stringify(await sourceStatus(directory)));
  } else if (command === 'configure' && input && extra.length === 0) {
    const value = input === '-' ? await stdinJson() : await readPrivateJson(input);
    const config = await configureSource(directory, value);
    console.log(JSON.stringify({ status: 'configured', sourceId: config.sourceId, token: '[REDACTED]' }));
  } else {
    throw new Error('Usage: source run | status | configure <private-file|->');
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('tool-logger-source: command failed; check invocation, private configuration and state permissions');
    process.exitCode = 1;
  });
}
