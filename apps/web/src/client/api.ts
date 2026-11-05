import {
  isObject, parseCredentials, parseHarnessList, parseSource, parseSources,
  parseToolCallDetail, parseToolCallFacets, parseToolCallMetrics, parseToolCallPage,
} from "../shared/api.ts";
import type { SourceRequest, ToolCallPage, ToolCallSummary } from "../shared/api.ts";

export type Result<T> = { value: T; changed: boolean };
type Cached = { etag: string; value: unknown; size: number };
const cache = new Map<string, Cached>();
let cacheBytes = 0;
export function clearApiCache() { cache.clear(); cacheBytes = 0; }
function discard(url: string) {
  cacheBytes -= cache.get(url)?.size ?? 0;
  cache.delete(url);
}
function remember(url: string, item: Cached) {
  discard(url);
  if (item.size > 8_000_000) return;
  cache.set(url, item); cacheBytes += item.size;
  while (cache.size > 96 || cacheBytes > 8_000_000) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    discard(oldest);
  }
}
export async function checkedResponse(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, credentials: "same-origin" });
  if (!response.ok && response.status !== 304) {
    if (response.status === 401 && url.startsWith("/api/")) {
      clearApiCache();
      window.dispatchEvent(new Event("tool-logger:session-expired"));
    }
    let message = `Request failed (HTTP ${response.status}).`;
    try {
      const value: unknown = await response.json();
      if (isObject(value)) {
        if (typeof value.detail === "string" && value.detail) message = value.detail;
        else if (typeof value.title === "string") message = value.title;
      }
    } catch { /* Keep the HTTP error if the body is unavailable. */ }
    throw new Error(message);
  }
  return response;
}
async function request<T>(url: string, parse: (value: unknown) => T, signal: AbortSignal): Promise<Result<T>> {
  const cached = cache.get(url);
  const response = await checkedResponse(url, cached
    ? { signal, headers: { "If-None-Match": cached.etag } } : { signal });
  if (response.status === 304 && cached) return { value: parse(cached.value), changed: false };
  const serialized = await response.text();
  const value: unknown = JSON.parse(serialized);
  const parsed = parse(value);
  const etag = response.headers.get("ETag");
  if (etag) remember(url, { etag, value, size: serialized.length * 2 }); else discard(url);
  return { value: parsed, changed: true };
}
async function mutation<T>(url: string, method: string, parse: (value: unknown) => T, body?: SourceRequest): Promise<T> {
  const response = await checkedResponse(url, { method, headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  clearApiCache();
  return parse(await response.json());
}
export const api = {
  harnesses: (signal: AbortSignal) => request("/api/v1/harnesses", parseHarnessList, signal),
  sources: (signal: AbortSignal) => request("/api/v1/sources", parseSources, signal),
  calls: (query: URLSearchParams, signal: AbortSignal) => request(`/api/v1/tool-calls?${query}`, parseToolCallPage, signal),
  facets: (query: URLSearchParams, signal: AbortSignal) => request(`/api/v1/tool-call-facets?${query}`, parseToolCallFacets, signal),
  metrics: (query: URLSearchParams, signal: AbortSignal) => request(`/api/v1/tool-call-metrics?${query}`, parseToolCallMetrics, signal),
  detail: (id: string, signal: AbortSignal) => request(`/api/v1/tool-calls/${encodeURIComponent(id)}`, parseToolCallDetail, signal),
  createSource: (body: SourceRequest) => mutation("/api/v1/sources", "POST", parseCredentials, body),
  updateSource: (id: string, body: SourceRequest) => mutation(`/api/v1/sources/${encodeURIComponent(id)}`, "PATCH", parseSource, body),
  rotateSource: (id: string) => mutation(`/api/v1/sources/${encodeURIComponent(id)}/rotate-token`, "POST", parseCredentials),
  revokeSource: async (id: string) => {
    await checkedResponse(`/api/v1/sources/${encodeURIComponent(id)}/token`, { method: "DELETE" });
    clearApiCache();
  },
};
export function callKey(call: Pick<ToolCallSummary, "sourceId" | "id">): string {
  return JSON.stringify([call.sourceId, call.id]);
}
export async function loadCallPages(query: URLSearchParams, pageCount: number, signal: AbortSignal): Promise<ToolCallPage> {
  const calls = new Map<string, ToolCallSummary>();
  let result: ToolCallPage | undefined;
  let cursor: string | null = null;
  for (let page = 0; page < pageCount; page += 1) {
    const parameters = new URLSearchParams(query);
    if (cursor) parameters.set("cursor", cursor);
    result = (await api.calls(parameters, signal)).value;
    for (const call of result.data) calls.set(callKey(call), call);
    cursor = result.page.nextCursor;
    if (!cursor || !result.page.hasMore) break;
  }
  if (!result) throw new Error("At least one tool-call page is required.");
  return { data: [...calls.values()], page: result.page };
}
