import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type {
  FacetBucket,
  FilterCapability,
  HarnessCapabilities,
  HarnessDescriptor,
  HarnessList,
  Health,
  JsonObject,
  Problem,
  SourceHealth,
  ToolCallDetail,
  ToolCallFacets,
  ToolCallMetrics,
  ToolCallPage,
  ToolCallSummary,
} from "../shared/api.ts";
import { callContext, isObject } from "../model.ts";
import type { HarnessDataset, Snapshot, ToolCall } from "../model.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_FILTER_VALUES = 100;
const MAX_SEARCH_LENGTH = 500;
const queryKeys = new Set([
  "q", "lifecycle", "outcome", "tool", "session", "agent", "repository", "directory", "since", "until", "limit", "cursor",
]);

type Cursor = { observedAt: string; id: string; query: string };
type Query = {
  q: string;
  lifecycle: string[];
  outcome: string[];
  tool: string[];
  session: string[];
  agent: string[];
  repository: string[];
  directory: string[];
  since: number | null;
  until: number | null;
  limit: number;
  cursor: Cursor | null;
};
type ProjectedCall = { call: ToolCall; summary: ToolCallSummary };

export type SnapshotLoader = () => Promise<Snapshot>;

class HttpProblem extends Error {
  readonly status: number;
  readonly title: string;

  constructor(status: number, title: string, detail: string) {
    super(detail);
    this.status = status;
    this.title = title;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function inputSummary(input: unknown): string {
  if (isObject(input)) {
    for (const key of ["command", "cmd", "query", "path", "file_path", "filePath", "url"]) {
      const value = input[key];
      if (typeof value === "string") return value.replace(/\s+/g, " ");
    }
  }
  return input === null ? "No input recorded" : JSON.stringify(input) ?? "";
}

function attributes(call: ToolCall): JsonObject {
  const context = callContext(call);
  return {
    ...(call.callId ? { callId: call.callId } : {}),
    ...(call.turn ? { turnId: call.turn } : {}),
    ...(call.message ? { messageId: call.message } : {}),
    ...(call.title ? { title: call.title } : {}),
    ...(context.branch ? { branch: context.branch } : {}),
    ...(context.commit ? { commit: context.commit } : {}),
    ...(context.upstream ? { upstream: context.upstream } : {}),
    ...(context.divergence ? { divergence: context.divergence } : {}),
    ...(context.dirty === null ? {} : { dirty: context.dirty }),
  };
}

export function summarizeCall(call: ToolCall): ToolCallSummary {
  const context = callContext(call);
  const lifecycle = call.pre && call.post ? "finished" : call.post ? "result-only" : "awaiting";
  const outcome = call.harness === "opencode" && call.apiVersion === 2
    ? call.status === "failed" ? "failure" : call.post ? "success" : "unknown"
    : "unknown";
  return {
    id: call.id,
    harness: call.harness,
    harnessApiVersion: call.apiVersion,
    tool: call.tool,
    observedAt: call.time,
    startedAt: call.pre?.logged_at ?? null,
    finishedAt: call.post?.logged_at ?? null,
    lifecycle,
    outcome,
    durationMs: call.durationMs,
    sessionId: text(call.session),
    agentId: text(call.agent),
    directory: text(context.directory),
    repository: text(context.root),
    inputSummary: inputSummary(call.input),
    attributes: attributes(call),
  };
}

export function detailCall(call: ToolCall): ToolCallDetail {
  return {
    summary: summarizeCall(call),
    input: call.input,
    output: call.harness === "opencode" && call.apiVersion === 1 && call.resultMetadata !== null
      ? { output: call.output, metadata: call.resultMetadata } : call.output,
    native: {
      attributes: { ...attributes(call), ...(call.resultMetadata === null ? {} : { resultMetadata: call.resultMetadata }) },
      events: [...(call.pre ? [call.pre] : []), ...(call.post ? [call.post] : [])],
    },
  };
}

function safeSourceLabel(source: string, homeDirectory: string | undefined): string {
  if (!source.startsWith("/")) return source;
  if (homeDirectory && (source === homeDirectory || source.startsWith(`${homeDirectory}/`))) {
    return `~${source.slice(homeDirectory.length)}`;
  }
  return basename(source);
}

function versions(dataset: HarnessDataset): (string | number)[] {
  return [...new Set(dataset.calls.flatMap((call) => call.apiVersion === null ? [] : [call.apiVersion]))].sort();
}

function sourceHealth(dataset: HarnessDataset, snapshot: Snapshot): SourceHealth {
  const latest = dataset.calls.map((call) => call.time).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const warnings = [
    ...(dataset.truncated ? ["Older events are outside the loaded window."] : []),
    ...(dataset.skipped ? [`${dataset.skipped} malformed record${dataset.skipped === 1 ? "" : "s"} skipped.`] : []),
  ];
  return {
    harness: dataset.harness,
    status: dataset.missing ? "missing" : dataset.error ? "unreadable" : warnings.length ? "partial" : "healthy",
    sourceLabel: safeSourceLabel(dataset.source, snapshot.homeDirectory),
    apiVersions: versions(dataset),
    skippedRecords: dataset.skipped,
    lastObservedAt: latest,
    ...(dataset.error ? { message: "Unable to read this log source." }
      : warnings.length ? { message: warnings.join(" ") } : {}),
  };
}

function capabilities(dataset: HarnessDataset): HarnessCapabilities {
  const filter = (id: string, label: string): FilterCapability => ({ id, label, type: "multi-select", queryParameter: id });
  return {
    filters: [filter("tool", "Tool"), filter("session", "Session"), filter("repository", "Repository"),
      filter("directory", "Directory"), ...(dataset.calls.some((call) => Boolean(call.agent)) ? [filter("agent", "Agent")] : [])],
    columns: [
      { id: "tool", label: "Tool / input", defaultVisible: true, sortable: false },
      { id: "repository", label: "Repository / directory", defaultVisible: true, sortable: false },
      { id: "lifecycle", label: "Status", defaultVisible: true, sortable: false },
      { id: "durationMs", label: "Duration", defaultVisible: true, sortable: false },
      { id: "sessionId", label: "Session", defaultVisible: true, sortable: false },
      { id: "observedAt", label: "Time", defaultVisible: true, sortable: false },
    ],
    outcomeSemantics: dataset.calls.some((call) => call.harness === "opencode" && call.apiVersion === 2)
      ? { success: "Harness reported success", failure: "Harness reported failure", unknown: "No conclusive result observed" }
      : { success: "Not reported", failure: "Not reported", unknown: "Result presence does not imply success" },
    detailFields: [],
  };
}

function harnessDescriptor(dataset: HarnessDataset): HarnessDescriptor {
  return { id: dataset.harness, label: dataset.label, apiVersions: versions(dataset), capabilities: capabilities(dataset) };
}

function one(url: URL, key: string): string {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) throw new HttpProblem(400, "Invalid query", `${key} must appear once.`);
  return values[0] ?? "";
}

function many(url: URL, key: string): string[] {
  const values = url.searchParams.getAll(key);
  if (values.length > MAX_FILTER_VALUES || values.some((value) => !value)) {
    throw new HttpProblem(400, "Invalid query", `${key} has invalid values.`);
  }
  return [...new Set(values)].sort();
}

function timestamp(value: string, key: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new HttpProblem(400, "Invalid query", `${key} must be an RFC 3339 timestamp.`);
  return parsed;
}

function cursor(value: string): Cursor | null {
  if (!value) return null;
  if (value.length > 4096) throw new HttpProblem(400, "Invalid query", "cursor is too long.");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isObject(parsed) || typeof parsed.observedAt !== "string" || typeof parsed.id !== "string" || typeof parsed.query !== "string") {
      throw new Error("invalid cursor");
    }
    return { observedAt: parsed.observedAt, id: parsed.id, query: parsed.query };
  } catch {
    throw new HttpProblem(400, "Invalid query", "cursor is invalid.");
  }
}

function fingerprint(query: Query): string {
  return createHash("sha256").update(JSON.stringify({
    q: query.q, lifecycle: query.lifecycle, outcome: query.outcome, tool: query.tool, session: query.session,
    agent: query.agent, repository: query.repository, directory: query.directory, since: query.since, until: query.until,
  })).digest("base64url");
}

function parseQuery(url: URL, paged: boolean): Query {
  for (const key of url.searchParams.keys()) {
    if (!queryKeys.has(key) || (!paged && (key === "limit" || key === "cursor"))) {
      throw new HttpProblem(400, "Invalid query", `Unsupported query parameter: ${key}.`);
    }
  }
  const q = one(url, "q").trim();
  if (q.length > MAX_SEARCH_LENGTH) throw new HttpProblem(400, "Invalid query", `q must be at most ${MAX_SEARCH_LENGTH} characters.`);
  const lifecycle = many(url, "lifecycle");
  if (lifecycle.some((value) => !["awaiting", "finished", "result-only"].includes(value))) {
    throw new HttpProblem(400, "Invalid query", "lifecycle is unsupported.");
  }
  const outcome = many(url, "outcome");
  if (outcome.some((value) => !["success", "failure", "unknown"].includes(value))) {
    throw new HttpProblem(400, "Invalid query", "outcome is unsupported.");
  }
  const limitValue = paged ? one(url, "limit") : "";
  const limit = limitValue ? Number(limitValue) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new HttpProblem(400, "Invalid query", `limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  const query: Query = {
    q, lifecycle, outcome, tool: many(url, "tool"), session: many(url, "session"), agent: many(url, "agent"),
    repository: many(url, "repository"), directory: many(url, "directory"),
    since: timestamp(one(url, "since"), "since"), until: timestamp(one(url, "until"), "until"),
    limit, cursor: paged ? cursor(one(url, "cursor")) : null,
  };
  if (query.since !== null && query.until !== null && query.since >= query.until) {
    throw new HttpProblem(400, "Invalid query", "since must be earlier than until.");
  }
  if (query.cursor && query.cursor.query !== fingerprint(query)) {
    throw new HttpProblem(400, "Invalid query", "cursor does not match the current filters.");
  }
  return query;
}

function compare(left: ToolCallSummary, right: ToolCallSummary): number {
  return Date.parse(right.observedAt) - Date.parse(left.observedAt) || right.id.localeCompare(left.id);
}

function afterCursor(call: ToolCallSummary, value: Cursor): boolean {
  const time = Date.parse(call.observedAt) - Date.parse(value.observedAt);
  return time < 0 || (time === 0 && call.id.localeCompare(value.id) < 0);
}

function selected(values: string[], value: string | null): boolean {
  return values.length === 0 || values.includes(value ?? "unknown");
}

function matches(call: ToolCall, summary: ToolCallSummary, query: Query, omitted = ""): boolean {
  return (omitted === "lifecycle" || selected(query.lifecycle, summary.lifecycle))
    && (omitted === "outcome" || selected(query.outcome, summary.outcome))
    && (omitted === "tool" || selected(query.tool, summary.tool))
    && (omitted === "session" || selected(query.session, summary.sessionId))
    && (omitted === "agent" || selected(query.agent, summary.agentId))
    && (omitted === "repository" || selected(query.repository, summary.repository))
    && (omitted === "directory" || selected(query.directory, summary.directory))
    && (query.since === null || Date.parse(summary.observedAt) >= query.since)
    && (query.until === null || Date.parse(summary.observedAt) < query.until)
    && (!query.q || JSON.stringify(call).toLowerCase().includes(query.q.toLowerCase()));
}

function queryCalls(dataset: HarnessDataset, query: Query, omitted = ""): ProjectedCall[] {
  return dataset.calls.map((call) => ({ call, summary: summarizeCall(call) }))
    .filter((entry) => matches(entry.call, entry.summary, query, omitted)).sort((left, right) => compare(left.summary, right.summary));
}

function nextCursor(call: ToolCallSummary, query: Query): string {
  return Buffer.from(JSON.stringify({ observedAt: call.observedAt, id: call.id, query: fingerprint(query) })).toString("base64url");
}

function facet(calls: ProjectedCall[], value: (call: ToolCallSummary) => string | null): FacetBucket[] {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const item = value(call.summary) ?? "unknown";
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, label: value, count }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function metricData(calls: ProjectedCall[], query: Query): ToolCallMetrics["data"] {
  const summaries = calls.map((entry) => entry.summary);
  const durations = summaries.flatMap((call) => call.durationMs === null ? [] : [call.durationMs]);
  const known = summaries.filter((call) => call.outcome !== "unknown");
  const failures = summaries.filter((call) => call.outcome === "failure").length;
  const times = summaries.map((call) => Date.parse(call.observedAt));
  const end = query.until ?? (times.length ? Math.max(...times) + 1 : Date.now());
  const start = query.since ?? (times.length ? Math.min(...times) : end - 3_600_000);
  const width = Math.max(end - start, 60_000);
  const activity = Array.from({ length: 36 }, (_, index) => ({ start: new Date(start + (index / 36) * width).toISOString(), count: 0 }));
  for (const time of times) {
    const bucket = activity[Math.min(35, Math.floor(((time - start) / width) * 36))];
    if (bucket) bucket.count += 1;
  }
  return {
    totalCalls: summaries.length,
    completedCalls: summaries.filter((call) => call.lifecycle !== "awaiting").length,
    awaitingCalls: summaries.filter((call) => call.lifecycle === "awaiting").length,
    successCalls: summaries.filter((call) => call.outcome === "success").length,
    failureCalls: failures,
    unknownCalls: summaries.filter((call) => call.outcome === "unknown").length,
    averageDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    failureRate: known.length ? failures / known.length : null,
    window: { since: new Date(start).toISOString(), until: new Date(end).toISOString() },
    activity,
    toolUsage: facet(calls, (call) => call.tool).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .map((entry) => ({ tool: entry.value, count: entry.count })),
  };
}

function body(response: ServerResponse, request: IncomingMessage, status: number, value: unknown, contentType = "application/json; charset=utf-8") {
  const serialized = JSON.stringify(value);
  const tag = `"${createHash("sha256").update(serialized).digest("base64url")}"`;
  response.setHeader("ETag", tag);
  if (request.headers["if-none-match"] === tag) {
    response.writeHead(304).end();
    return;
  }
  response.writeHead(status, { "Content-Type": contentType });
  response.end(request.method === "HEAD" ? undefined : serialized);
}

function problem(response: ServerResponse, request: IncomingMessage, error: HttpProblem) {
  const value: Problem = {
    type: `https://tool-logger.local/problems/${error.status}`,
    title: error.title,
    status: error.status,
    detail: error.message,
    instance: request.url ?? "/",
  };
  body(response, request, error.status, value, "application/problem+json; charset=utf-8");
}

function segments(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new HttpProblem(400, "Invalid URL", "Path encoding is invalid.");
  }
}

function dataset(snapshot: Snapshot, harness: string): HarnessDataset {
  const value = snapshot.harnesses.find((entry) => entry.harness === harness);
  if (!value || value.missing || value.error) throw new HttpProblem(404, "Not found", "Harness was not found.");
  return value;
}

export class RestApi {
  private readonly load: SnapshotLoader;

  constructor(load: SnapshotLoader) { this.load = load; }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const parts = segments(url.pathname);
    if (url.pathname !== "/healthz" && (parts[0] !== "api" || parts[1] !== "v1")) return false;
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      problem(response, request, new HttpProblem(405, "Method not allowed", "This resource only supports GET and HEAD."));
      return true;
    }
    try {
      const snapshot = await this.load();
      if (url.pathname === "/healthz") {
        const sources = snapshot.harnesses.map((entry) => sourceHealth(entry, snapshot));
        const value: Health = {
          status: sources.some((source) => source.status !== "healthy") ? "degraded" : "ok",
          checkedAt: new Date().toISOString(),
          sources,
        };
        body(response, request, 200, value);
        return true;
      }
      if (parts.length === 3 && parts[2] === "harnesses") {
        const value: HarnessList = {
          data: snapshot.harnesses.filter((entry) => !entry.missing && !entry.error).map(harnessDescriptor),
          sourceHealth: snapshot.harnesses.map((entry) => sourceHealth(entry, snapshot)),
          demo: snapshot.demo,
        };
        body(response, request, 200, value);
        return true;
      }
      if (parts.length < 5 || parts[2] !== "harnesses") throw new HttpProblem(404, "Not found", "Resource not found.");
      const source = dataset(snapshot, parts[3] ?? "");
      const health = sourceHealth(source, snapshot);
      if (parts[4] === "tool-calls" && parts.length === 5) {
        const query = parseQuery(url, true);
        const matches = queryCalls(source, query);
        const visible = query.cursor ? matches.filter((entry) => afterCursor(entry.summary, query.cursor ?? { observedAt: "", id: "", query: "" })) : matches;
        const page = visible.slice(0, query.limit);
        const last = page.at(-1)?.summary;
        const value: ToolCallPage = {
          data: page.map((entry) => entry.summary),
          page: { nextCursor: visible.length > page.length && last ? nextCursor(last, query) : null, hasMore: visible.length > page.length },
          sourceHealth: health,
        };
        body(response, request, 200, value);
        return true;
      }
      if (parts[4] === "tool-calls" && parts.length === 6) {
        if ([...url.searchParams].length) throw new HttpProblem(400, "Invalid query", "Tool-call detail has no query parameters.");
        const call = source.calls.find((entry) => entry.id === parts[5]);
        if (!call) throw new HttpProblem(404, "Not found", "Tool call was not found.");
        body(response, request, 200, detailCall(call));
        return true;
      }
      if (parts[4] === "tool-call-facets" && parts.length === 5) {
        const query = parseQuery(url, false);
        const value: ToolCallFacets = {
          data: {
            tools: facet(queryCalls(source, query, "tool"), (call) => call.tool),
            sessions: facet(queryCalls(source, query, "session"), (call) => call.sessionId),
            agents: facet(queryCalls(source, query, "agent"), (call) => call.agentId),
            repositories: facet(queryCalls(source, query, "repository"), (call) => call.repository),
            directories: facet(queryCalls(source, query, "directory"), (call) => call.directory),
            lifecycles: facet(queryCalls(source, query, "lifecycle"), (call) => call.lifecycle),
            outcomes: facet(queryCalls(source, query, "outcome"), (call) => call.outcome),
          },
          sourceHealth: health,
        };
        body(response, request, 200, value);
        return true;
      }
      if (parts[4] === "tool-call-metrics" && parts.length === 5) {
        const query = parseQuery(url, false);
        const value: ToolCallMetrics = { data: metricData(queryCalls(source, query), query), sourceHealth: health };
        body(response, request, 200, value);
        return true;
      }
      throw new HttpProblem(404, "Not found", "Resource not found.");
    } catch (error) {
      const value = error instanceof HttpProblem ? error : new HttpProblem(500, "Internal server error", "The request could not be completed.");
      problem(response, request, value);
      return true;
    }
  }
}
