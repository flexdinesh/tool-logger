export type JsonObject = Record<string, unknown>;
export type ApiVersion = string | number;
export type CallLifecycle = "awaiting" | "finished" | "result-only";
export type CallOutcome = "success" | "failure" | "unknown";
export type SourceStatus = "healthy" | "missing" | "partial" | "unreadable";

export type FilterCapability = {
  id: string;
  label: string;
  type: "text" | "single-select" | "multi-select" | "datetime";
  queryParameter: string;
};

export type ColumnCapability = {
  id: string;
  label: string;
  defaultVisible: boolean;
  sortable: boolean;
};

export type DetailFieldCapability = {
  id: string;
  label: string;
  path: string;
  format: "text" | "code" | "json" | "timestamp" | "duration";
};

export type HarnessCapabilities = {
  filters: FilterCapability[];
  columns: ColumnCapability[];
  outcomeSemantics: { success: string; failure: string; unknown: string };
  detailFields: DetailFieldCapability[];
};

export type HarnessDescriptor = {
  id: string;
  label: string;
  apiVersions: ApiVersion[];
  capabilities: HarnessCapabilities;
};

export type SourceHealth = {
  harness: string;
  status: SourceStatus;
  sourceLabel: string;
  apiVersions: ApiVersion[];
  skippedRecords: number;
  lastObservedAt: string | null;
  message?: string;
};

export type HarnessList = {
  data: HarnessDescriptor[];
  sourceHealth: SourceHealth[];
  demo: boolean;
};

export type ToolCallSummary = {
  id: string;
  harness: string;
  harnessApiVersion: ApiVersion | null;
  tool: string;
  observedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lifecycle: CallLifecycle;
  outcome: CallOutcome;
  durationMs: number | null;
  sessionId: string | null;
  agentId: string | null;
  directory: string | null;
  repository: string | null;
  inputSummary: string;
  attributes: JsonObject;
};

export type ToolCallDetail = {
  summary: ToolCallSummary;
  input: unknown;
  output: unknown;
  native: { attributes: JsonObject; events: JsonObject[] };
};

export type Page = { nextCursor: string | null; hasMore: boolean };
export type ToolCallPage = { data: ToolCallSummary[]; page: Page; sourceHealth: SourceHealth };

export type FacetBucket = { value: string; label: string; count: number };
export type ToolCallFacets = {
  data: {
    tools: FacetBucket[];
    sessions: FacetBucket[];
    agents: FacetBucket[];
    repositories: FacetBucket[];
    directories: FacetBucket[];
    lifecycles: FacetBucket[];
    outcomes: FacetBucket[];
  };
  sourceHealth: SourceHealth;
};

export type ToolCallMetrics = {
  data: {
    totalCalls: number;
    completedCalls: number;
    awaitingCalls: number;
    successCalls: number;
    failureCalls: number;
    unknownCalls: number;
    averageDurationMs: number | null;
    failureRate: number | null;
    window: { since: string | null; until: string | null };
    activity: { start: string; count: number; harnesses?: Record<string, number> }[];
    toolUsage: { tool: string; count: number }[];
  };
  sourceHealth: SourceHealth;
};

export type Health = { status: "ok" | "degraded"; checkedAt: string; sources: SourceHealth[] };
export type Problem = { type: string; title: string; status: number; detail?: string; instance?: string };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableNumber(value: unknown): boolean {
  return value === null || typeof value === "number";
}

function apiVersion(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number";
}

function sourceStatus(value: unknown): boolean {
  return value === "healthy" || value === "missing" || value === "partial" || value === "unreadable";
}

function isSourceHealth(value: unknown): value is SourceHealth {
  return isObject(value) && typeof value.harness === "string" && sourceStatus(value.status)
    && typeof value.sourceLabel === "string"
    && Array.isArray(value.apiVersions) && value.apiVersions.every(apiVersion)
    && typeof value.skippedRecords === "number" && nullableString(value.lastObservedAt)
    && (value.message === undefined || typeof value.message === "string");
}

function isFilter(value: unknown): value is FilterCapability {
  return isObject(value) && typeof value.id === "string" && typeof value.label === "string"
    && (value.type === "text" || value.type === "single-select" || value.type === "multi-select" || value.type === "datetime")
    && typeof value.queryParameter === "string";
}

function isColumn(value: unknown): value is ColumnCapability {
  return isObject(value) && typeof value.id === "string" && typeof value.label === "string"
    && typeof value.defaultVisible === "boolean" && typeof value.sortable === "boolean";
}

function isDetailField(value: unknown): value is DetailFieldCapability {
  return isObject(value) && typeof value.id === "string" && typeof value.label === "string"
    && typeof value.path === "string" && ["text", "code", "json", "timestamp", "duration"].includes(String(value.format));
}

function isHarness(value: unknown): value is HarnessDescriptor {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.label !== "string"
    || !Array.isArray(value.apiVersions) || !value.apiVersions.every(apiVersion) || !isObject(value.capabilities)) return false;
  const semantics = value.capabilities.outcomeSemantics;
  return Array.isArray(value.capabilities.filters) && value.capabilities.filters.every(isFilter)
    && Array.isArray(value.capabilities.columns) && value.capabilities.columns.every(isColumn)
    && Array.isArray(value.capabilities.detailFields) && value.capabilities.detailFields.every(isDetailField)
    && isObject(semantics) && typeof semantics.success === "string" && typeof semantics.failure === "string"
    && typeof semantics.unknown === "string";
}

function isSummary(value: unknown): value is ToolCallSummary {
  return isObject(value) && typeof value.id === "string" && typeof value.harness === "string"
    && (value.harnessApiVersion === null || apiVersion(value.harnessApiVersion)) && typeof value.tool === "string"
    && typeof value.observedAt === "string" && nullableString(value.startedAt) && nullableString(value.finishedAt)
    && (value.lifecycle === "awaiting" || value.lifecycle === "finished" || value.lifecycle === "result-only")
    && (value.outcome === "success" || value.outcome === "failure" || value.outcome === "unknown")
    && nullableNumber(value.durationMs) && nullableString(value.sessionId) && nullableString(value.agentId)
    && nullableString(value.directory) && nullableString(value.repository) && typeof value.inputSummary === "string"
    && isObject(value.attributes);
}

function isFacet(value: unknown): value is FacetBucket {
  return isObject(value) && typeof value.value === "string" && typeof value.label === "string" && typeof value.count === "number";
}

function isHarnessList(value: unknown): value is HarnessList {
  return isObject(value) && Array.isArray(value.data) && value.data.every(isHarness)
    && Array.isArray(value.sourceHealth) && value.sourceHealth.every(isSourceHealth) && typeof value.demo === "boolean";
}

function isToolCallPage(value: unknown): value is ToolCallPage {
  return isObject(value) && Array.isArray(value.data) && value.data.every(isSummary) && isObject(value.page)
    && nullableString(value.page.nextCursor) && typeof value.page.hasMore === "boolean" && isSourceHealth(value.sourceHealth);
}

function isToolCallDetail(value: unknown): value is ToolCallDetail {
  return isObject(value) && isSummary(value.summary) && isObject(value.native)
    && isObject(value.native.attributes) && Array.isArray(value.native.events)
    && value.native.events.every(isObject) && "input" in value && "output" in value;
}

function isToolCallFacets(value: unknown): value is ToolCallFacets {
  if (!isObject(value) || !isObject(value.data) || !isSourceHealth(value.sourceHealth)) return false;
  const groups = [value.data.tools, value.data.sessions, value.data.agents, value.data.repositories,
    value.data.directories, value.data.lifecycles, value.data.outcomes];
  return groups.every((group) => Array.isArray(group) && group.every(isFacet));
}

function isToolCallMetrics(value: unknown): value is ToolCallMetrics {
  return isObject(value) && isObject(value.data) && isSourceHealth(value.sourceHealth)
    && typeof value.data.totalCalls === "number" && typeof value.data.completedCalls === "number"
    && typeof value.data.awaitingCalls === "number" && typeof value.data.successCalls === "number"
    && typeof value.data.failureCalls === "number" && typeof value.data.unknownCalls === "number"
    && nullableNumber(value.data.averageDurationMs) && nullableNumber(value.data.failureRate)
    && isObject(value.data.window) && nullableString(value.data.window.since) && nullableString(value.data.window.until)
    && Array.isArray(value.data.activity) && value.data.activity.every((entry) => isObject(entry)
      && typeof entry.start === "string" && typeof entry.count === "number"
      && (entry.harnesses === undefined || (isObject(entry.harnesses)
        && Object.values(entry.harnesses).every((count) => typeof count === "number"))))
    && Array.isArray(value.data.toolUsage) && value.data.toolUsage.every((entry) => isObject(entry)
      && typeof entry.tool === "string" && typeof entry.count === "number");
}

export function parseHarnessList(value: unknown): HarnessList {
  if (!isHarnessList(value)) throw new Error("Unexpected harness response.");
  return value;
}

export function parseToolCallPage(value: unknown): ToolCallPage {
  if (!isToolCallPage(value)) throw new Error("Unexpected tool-call response.");
  return value;
}

export function parseToolCallDetail(value: unknown): ToolCallDetail {
  if (!isToolCallDetail(value)) throw new Error("Unexpected tool-call detail response.");
  return value;
}

export function parseToolCallFacets(value: unknown): ToolCallFacets {
  if (!isToolCallFacets(value)) throw new Error("Unexpected facet response.");
  return value;
}

export function parseToolCallMetrics(value: unknown): ToolCallMetrics {
  if (!isToolCallMetrics(value)) throw new Error("Unexpected metrics response.");
  return value;
}
