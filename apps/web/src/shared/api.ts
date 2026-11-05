export type JsonObject = Record<string, unknown>;
export type CallLifecycle = "awaiting" | "finished" | "result-only";
export type CallOutcome = "success" | "failure" | "unknown";
export type Source = {
  id: string; name: string; hostname: string; platform: string; labels: Record<string, string>;
  status: string; lastSeenAt: string | null; lastEventAt: string | null;
  pendingEvents: number; rejectedEvents: number; lastError: string;
};
export type SourceRequest = Pick<Source, "name" | "hostname" | "platform" | "labels">;
export type SourceCredentials = { source: Source; token: string };
export type DetailFieldCapability = { id: string; label: string; path: string; format: "text" | "code" | "json" | "timestamp" | "duration" };
export type HarnessDescriptor = {
  id: string; label: string; apiVersions: string[];
  capabilities: {
    filters: { id: string }[]; detailFields: DetailFieldCapability[]; columns: never[];
    outcomeSemantics: Record<CallOutcome, string>;
  };
};
export type HarnessList = { data: HarnessDescriptor[] };
export type ToolCallSummary = {
  id: string; sourceId: string; harness: string; harnessApiVersion: string | null;
  tool: string; observedAt: string; startedAt: string | null; finishedAt: string | null;
  lifecycle: CallLifecycle; outcome: CallOutcome; durationMs: number | null;
  sessionId: string | null; agentId: string | null; directory: string | null;
  repository: string | null; inputSummary: string; attributes: JsonObject;
};
export type ToolCallDetail = {
  summary: ToolCallSummary; input: unknown; output: unknown;
  native: { attributes: JsonObject; events: JsonObject[] };
};
export type Page = { nextCursor: string | null; hasMore: boolean };
export type ToolCallPage = { data: ToolCallSummary[]; page: Page };
export type FacetBucket = { value: string; label: string; count: number };
export type ToolCallFacets = { data: {
  tools: FacetBucket[]; sessions: FacetBucket[]; agents: FacetBucket[];
  repositories: FacetBucket[]; directories: FacetBucket[]; lifecycles: FacetBucket[]; outcomes: FacetBucket[];
} };
export type ToolCallMetrics = { data: {
  totalCalls: number; completedCalls: number; awaitingCalls: number; successCalls: number;
  failureCalls: number; unknownCalls: number; averageDurationMs: number | null; failureRate: number | null;
  window: { since: string | null; until: string | null };
  activity: { start: string; count: number; harnesses: Record<string, number> }[];
  toolUsage: { tool: string; count: number }[];
} };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error("Unexpected API object.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Unexpected API text.");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Unexpected API number.");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Unexpected API boolean.");
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function nullableNumber(value: unknown): number | null { return value === null ? null : number(value); }
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("Unexpected API list.");
  return value.map((item: unknown) => parse(item));
}
function stringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value === null ? {} : object(value))) {
    Object.defineProperty(result, key, { value: text(item), enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function numberMap(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value === null ? {} : object(value))) {
    Object.defineProperty(result, key, { value: number(item), enumerable: true, configurable: true, writable: true });
  }
  return result;
}
export function parseSource(value: unknown): Source {
  const v = object(value);
  return { id: text(v.id), name: text(v.name), hostname: text(v.hostname), platform: text(v.platform),
    labels: stringMap(v.labels), status: text(v.status), lastSeenAt: nullableText(v.lastSeenAt),
    lastEventAt: nullableText(v.lastEventAt), pendingEvents: number(v.pendingEvents),
    rejectedEvents: number(v.rejectedEvents), lastError: text(v.lastError) };
}
export function parseSources(value: unknown): Source[] { return list(object(value).data, parseSource); }
export function parseCredentials(value: unknown): SourceCredentials {
  const v = object(value);
  return { source: parseSource(v.source), token: text(v.token) };
}
export function parseHarnessList(value: unknown): HarnessList {
  return { data: list(object(value).data, (item) => {
    const v = object(item), semantics = object(v.outcomeSemantics);
    return { id: text(v.id), label: text(v.label), apiVersions: list(v.apiVersions, text),
      capabilities: { filters: [{ id: "agent" }], columns: [], detailFields: [],
        outcomeSemantics: { success: text(semantics.success), failure: text(semantics.failure), unknown: text(semantics.unknown) } } };
  }) };
}
export function parseSummary(value: unknown): ToolCallSummary {
  const v = object(value);
  if (v.lifecycle !== "awaiting" && v.lifecycle !== "finished" && v.lifecycle !== "result-only") throw new Error("Unexpected call lifecycle.");
  if (v.outcome !== "success" && v.outcome !== "failure" && v.outcome !== "unknown") throw new Error("Unexpected call outcome.");
  return { id: text(v.id), sourceId: text(v.sourceId), harness: text(v.harness), harnessApiVersion: nullableText(v.harnessApiVersion),
    tool: text(v.tool), observedAt: text(v.observedAt), startedAt: nullableText(v.startedAt), finishedAt: nullableText(v.finishedAt),
    lifecycle: v.lifecycle, outcome: v.outcome, durationMs: nullableNumber(v.durationMs), sessionId: nullableText(v.sessionId),
    agentId: nullableText(v.agentId), directory: nullableText(v.directory), repository: nullableText(v.repository),
    inputSummary: text(v.inputSummary), attributes: v.attributes === null ? {} : object(v.attributes) };
}
export function parseToolCallPage(value: unknown): ToolCallPage {
  const v = object(value), page = object(v.page);
  return { data: list(v.data, parseSummary), page: { nextCursor: nullableText(page.nextCursor), hasMore: boolean(page.hasMore) } };
}
export function parseToolCallDetail(value: unknown): ToolCallDetail {
  const v = object(value), native = object(v.native);
  if (!("input" in v) || !("output" in v)) throw new Error("Missing call evidence.");
  return { summary: parseSummary(v.summary), input: v.input, output: v.output,
    native: { attributes: native.attributes === null ? {} : object(native.attributes), events: list(native.events, object) } };
}
export function parseToolCallFacets(value: unknown): ToolCallFacets {
  const v = object(object(value).data);
  const buckets = (value: unknown) => list(value, (item) => {
    const b = object(item); return { value: text(b.value), label: text(b.label), count: number(b.count) };
  });
  return { data: { tools: buckets(v.tools), sessions: buckets(v.sessions), agents: buckets(v.agents),
    repositories: buckets(v.repositories), directories: buckets(v.directories),
    lifecycles: buckets(v.lifecycles), outcomes: buckets(v.outcomes) } };
}
export function parseToolCallMetrics(value: unknown): ToolCallMetrics {
  const v = object(object(value).data), window = object(v.window);
  return { data: { totalCalls: number(v.totalCalls), completedCalls: number(v.completedCalls),
    awaitingCalls: number(v.awaitingCalls), successCalls: number(v.successCalls), failureCalls: number(v.failureCalls),
    unknownCalls: number(v.unknownCalls), averageDurationMs: nullableNumber(v.averageDurationMs),
    failureRate: nullableNumber(v.failureRate), window: { since: nullableText(window.since), until: nullableText(window.until) },
    activity: list(v.activity, (item) => { const b = object(item); return { start: text(b.start), count: number(b.count), harnesses: numberMap(b.harnesses) }; }),
    toolUsage: list(v.toolUsage, (item) => { const b = object(item); return { tool: text(b.tool), count: number(b.count) }; }) } };
}
