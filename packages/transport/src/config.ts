import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, code, object, readJson } from './persistence.ts';

export type SourceConfig = {
  schemaVersion: 1;
  sourceId: string;
  endpoint: string;
  token: string;
  name: string;
  labels: Record<string, string>;
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function stateDirectory(override = process.env.TOOL_LOGGER_STATE_DIR, home = homedir()): string {
  if (!override) return join(home, '.local/state/tool-logger');
  if (override === '~') return home;
  return override.startsWith('~/') ? join(home, override.slice(2)) : override;
}

export function parseSourceConfig(value: unknown): SourceConfig {
  if (!object(value) || value.schemaVersion !== 1
      || typeof value.sourceId !== 'string' || !UUID.test(value.sourceId)
      || typeof value.endpoint !== 'string'
      || typeof value.token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value.token)
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256
      || !object(value.labels) || Object.keys(value.labels).length > 100) {
    throw new Error('Invalid source configuration');
  }
  let endpoint: URL;
  try { endpoint = new URL(value.endpoint); }
  catch { throw new Error('Invalid source endpoint'); }
  if (!['http:', 'https:', 'unix:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || value.endpoint.includes('?') || value.endpoint.includes('#')) {
    throw new Error('Invalid source endpoint');
  }
  if (endpoint.protocol === 'unix:' && (endpoint.host || !endpoint.pathname.startsWith('/') || endpoint.pathname === '/')) {
    throw new Error('Invalid source endpoint');
  }
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value.labels)) {
    if (!key || key.length > 256 || typeof label !== 'string' || label.length > 4096) {
      throw new Error('Invalid source labels');
    }
    Object.defineProperty(labels, key, { value: label, enumerable: true, configurable: true, writable: true });
  }
  const config: SourceConfig = {
    schemaVersion: 1, sourceId: value.sourceId, endpoint: endpoint.href.replace(/\/$/, ''),
    token: value.token, name: value.name, labels,
  };
  if (Buffer.byteLength(JSON.stringify(config)) + 1 > 64 * 1024) throw new Error('Source configuration too large');
  return config;
}

export async function readPrivateJson(path: string): Promise<unknown> {
  return readJson(path, 64 * 1024, true);
}

export async function loadSourceConfig(directory: string): Promise<SourceConfig | null> {
  try { return parseSourceConfig(await readPrivateJson(join(directory, 'source.json'))); }
  catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw new Error('Source configuration unavailable or invalid');
  }
}

export async function configureSource(directory: string, value: unknown): Promise<SourceConfig> {
  const config = parseSourceConfig(value);
  // An existing source identity may not be reassigned to another source:
  // old journal records have no source ID until wrapped by the sender.
  const previous = await loadSourceConfig(directory);
  if (previous && previous.sourceId !== config.sourceId) {
    throw new Error('Source identity change requires a fresh state directory');
  }
  await atomicJson(join(directory, 'source.json'), config);
  return config;
}
