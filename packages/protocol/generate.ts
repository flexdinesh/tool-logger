import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const text = { type: 'string' };
const number = { type: 'number' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const timestamp = { type: 'string', format: 'date-time' };
const uuid = { type: 'string', format: 'uuid' };
const nullable = (value: unknown) => ({ anyOf: [value, { type: 'null' }] });
const array = (items: unknown) => ({ type: 'array', items });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const map = (additionalProperties: unknown) => ({ type: 'object', additionalProperties });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const native = { type: 'object', required: ['schema_version', 'event_id', 'harness', 'logged_at', 'hook', 'event', 'metadata'], properties: {
  schema_version: { const: 2 }, event_id: uuid, harness: { enum: ['codex', 'opencode'] }, logged_at: timestamp, hook: text, event: map(true), metadata: map(true),
}, additionalProperties: true };
const event = object({ schemaVersion: { const: 1 }, eventId: uuid, sourceId: uuid, harness: { enum: ['codex', 'opencode'] }, recordedAt: timestamp, native });
const bucket = object({ value: text, label: text, count: integer });
const sourceRequest = object({ name: { type: 'string', minLength: 1, maxLength: 200 }, hostname: text, platform: text, labels: map(text) }, ['name']);
const source = object({ id: uuid, name: text, hostname: text, platform: text, labels: map(text), status: { enum: ['never-seen', 'online', 'stale', 'degraded', 'revoked'] }, lastSeenAt: nullable(timestamp), lastEventAt: nullable(timestamp), pendingEvents: integer, rejectedEvents: integer, lastError: text });
const summary = object({ id: text, sourceId: uuid, harness: text, harnessApiVersion: nullable(text), tool: text, observedAt: timestamp, startedAt: nullable(timestamp), finishedAt: nullable(timestamp), lifecycle: { enum: ['awaiting', 'finished', 'result-only'] }, outcome: { enum: ['success', 'failure', 'unknown'] }, durationMs: nullable(number), sessionId: nullable(text), agentId: nullable(text), directory: nullable(text), repository: nullable(text), inputSummary: text, attributes: map(true) });
const schemas = {
  Connection: object({ schemaVersion: { const: 1 }, endpoint: { type: 'string', pattern: '^(unix:///|https://)' }, token: text, fingerprint: { type: 'string', pattern: '^[0-9a-f]{64}$' }, serverId: uuid }, ['schemaVersion', 'endpoint', 'token', 'serverId']),
  SourceConfig: object({ schemaVersion: { const: 1 }, sourceId: uuid, endpoint: text, token: text, name: text, labels: map(text) }),
  ServerStatus: object({ ready: boolean, pid: integer, workerPid: integer, workerError: text, serverId: uuid, remoteEndpoint: text }, ['ready', 'pid', 'workerPid', 'serverId']),
  RemoteRequest: object({ listen: text, advertise: text }),
  Invitation: object({ connectionString: text, endpoint: text, fingerprint: text, serverId: uuid, expiresAt: timestamp }),
  PairRequest: object({ code: text }),
  LocalSourceRequest: object({ workerPath: text }),
  RemoteClientList: object({ data: array(object({ id: uuid, createdAt: timestamp })) }),
  Event: event,
  IngestRequest: object({ events: { ...array(ref('Event')), minItems: 1, maxItems: 500 } }),
  Acknowledgement: object({ accepted: array(uuid), duplicates: array(uuid) }),
  Heartbeat: object({ sourceId: uuid, hostname: text, platform: text, labels: map(text), pendingEvents: { type: 'integer', minimum: 0 }, rejectedEvents: { type: 'integer', minimum: 0 }, lastError: text }),
  Source: source, SourceRequest: sourceRequest,
  SourcePatch: object(sourceRequest.properties, []),
  SourceCredentials: object({ source: ref('Source'), token: text }),
  SourceList: object({ data: array(ref('Source')) }),
  HarnessList: object({ data: array(object({ id: text, label: text, apiVersions: array(text), outcomeSemantics: map(text) })) }),
  CallSummary: summary,
  CallDetail: object({ summary: ref('CallSummary'), input: true, output: true, native: object({ attributes: map(true), events: array(map(true)) }) }),
  CallPage: object({ data: array(ref('CallSummary')), page: object({ nextCursor: nullable(text), hasMore: boolean }) }),
  Facets: object({ data: object(Object.fromEntries(['tools', 'sessions', 'agents', 'repositories', 'directories', 'lifecycles', 'outcomes'].map(key => [key, array(bucket)]))) }),
  Metrics: object({ data: object({ totalCalls: integer, completedCalls: integer, awaitingCalls: integer, successCalls: integer, failureCalls: integer, unknownCalls: integer, averageDurationMs: nullable(number), failureRate: nullable(number), window: object({ since: nullable(timestamp), until: nullable(timestamp) }), activity: array(object({ start: timestamp, count: integer, harnesses: map(integer) })), toolUsage: array(object({ tool: text, count: integer })) }) }),
  Problem: object({ type: text, title: text, status: integer, detail: text }, ['type', 'title', 'status']),
};
const query = ['source', 'harness', 'q', 'lifecycle', 'outcome', 'tool', 'session', 'agent', 'repository', 'directory', 'since', 'until', 'limit', 'cursor'].map(name => ({ name, in: 'query', description: `Filter by ${name}. Repeated categorical parameters match any supplied value.`, schema: name === 'limit' ? { type: 'integer', minimum: 1, maximum: 500, default: 100 } : text }));
const json = (schema: unknown) => ({ 'application/json': { schema } });
function operation(operationId: string, response: string | null, options: { body?: string; source?: boolean; parameters?: unknown[]; status?: number; public?: boolean } = {}) {
  return {
    operationId, summary: operationId.replaceAll(/([a-z])([A-Z])/g, '$1 $2'), security: options.public ? [] : [{ [options.source ? 'SourceToken' : 'AdminToken']: [] }],
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.body ? { requestBody: { required: true, content: json(ref(options.body)) } } : {}),
    responses: {
      [String(options.status ?? 200)]: { description: 'Success', ...(response ? { content: json(ref(response)) } : {}) },
      '400': { description: 'Invalid request', content: { 'application/problem+json': { schema: ref('Problem') } } },
      '401': { description: 'Missing or invalid credential', content: { 'application/problem+json': { schema: ref('Problem') } } },
      '409': { description: 'Conflicting immutable event contents', content: { 'application/problem+json': { schema: ref('Problem') } } },
      default: { description: 'Structured request, authentication, conflict, or server error', content: { 'application/problem+json': { schema: ref('Problem') } } },
    },
  };
}
const id = (name: string) => [{ name, in: 'path', required: true, schema: text }];
const openapi = {
  openapi: '3.1.0', info: { title: 'Tool Logger REST API', version: '1.0.0', license: { name: 'Private local workspace', identifier: 'LicenseRef-Private' }, description: 'Native observation and durable source ingestion. Tokens are separate read/admin and source-scoped write credentials. Requests are bounded to 9 MiB, accommodating 8 MiB native journal records plus envelope overhead. Acknowledgements follow durable commit. Source/event IDs deduplicate retries; conflicting contents return 409. Native payloads remain complete JSON objects.' },
  servers: [{ url: 'http://localhost', description: 'Synthetic HTTP base carried over the private Unix socket. Remote connections use pinned HTTPS.' }],
  paths: {
    '/api/v1/pair': { post: operation('pairRemoteClient', 'Connection', { public: true, body: 'PairRequest' }) },
    '/api/v1/control/status': { get: operation('getCollectorStatus', 'ServerStatus') },
    '/api/v1/control/stop': { post: operation('stopCollector', null, { status: 204 }) },
    '/api/v1/control/remote': { post: operation('enableRemote', 'Invitation', { body: 'RemoteRequest' }) },
    '/api/v1/control/local-source': { post: operation('ensureLocalSource', 'SourceConfig', { body: 'LocalSourceRequest' }) },
    '/api/v1/control/clients': { get: operation('listRemoteClients', 'RemoteClientList') },
    '/api/v1/control/clients/{id}': { delete: operation('revokeRemoteClient', null, { parameters: id('id'), status: 204 }) },
    '/healthz': { get: { ...operation('getHealth', null, { public: true }), responses: { '200': { description: 'Server alive', content: json(object({ status: text })) }, '405': { description: 'Method not allowed' } } } },
    '/api/v1/harnesses': { get: operation('listHarnesses', 'HarnessList') },
    '/api/v1/sources': { get: operation('listSources', 'SourceList'), post: operation('createSource', 'SourceCredentials', { body: 'SourceRequest', status: 201 }) },
    '/api/v1/sources/{id}': { patch: operation('updateSource', 'Source', { body: 'SourcePatch', parameters: id('id') }) },
    '/api/v1/sources/{id}/rotate-token': { post: operation('rotateSourceToken', 'SourceCredentials', { parameters: id('id') }) },
    '/api/v1/sources/{id}/token': { delete: operation('revokeSourceToken', null, { parameters: id('id'), status: 204 }) },
    '/api/v1/ingest/events': { post: operation('ingestEvents', 'Acknowledgement', { source: true, body: 'IngestRequest' }) },
    '/api/v1/ingest/heartbeat': { post: operation('recordHeartbeat', null, { source: true, body: 'Heartbeat', status: 204 }) },
    '/api/v1/tool-calls': { get: operation('listToolCalls', 'CallPage', { parameters: query }) },
    '/api/v1/tool-calls/{id}': { get: operation('getToolCall', 'CallDetail', { parameters: id('id') }) },
    '/api/v1/tool-call-facets': { get: operation('getFacets', 'Facets', { parameters: query.filter(item => !['cursor', 'limit'].includes(item.name)) }) },
    '/api/v1/tool-call-metrics': { get: operation('getMetrics', 'Metrics', { parameters: query.filter(item => !['cursor', 'limit'].includes(item.name)) }) },
  },
  components: { schemas, securitySchemes: { AdminToken: { type: 'http', scheme: 'bearer', description: 'Native query and administration credential. Cannot ingest.' }, SourceToken: { type: 'http', scheme: 'bearer', description: 'Revocable write credential bound to one source. Cannot read or administer.' } } },
};
for (const [name, value] of Object.entries({ 'openapi.json': openapi, 'event.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', ...event } })) {
  const path = new URL(name, import.meta.url);
  const content = JSON.stringify(value, null, 2)+'\n';
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`Regenerate ${fileURLToPath(path)} with protocol generate`);
  } else writeFileSync(path, content);
}
