import {
  isObject,
  parseHarnessList,
  parseToolCallDetail,
  parseToolCallFacets,
  parseToolCallMetrics,
  parseToolCallPage,
} from "../shared/api.ts";
import type {
  HarnessList,
  ToolCallDetail,
  ToolCallFacets,
  ToolCallMetrics,
  ToolCallPage,
  ToolCallSummary,
} from "../shared/api.ts";

type Cached = { etag: string; value: unknown; size: number };
type Result<T> = { value: T; changed: boolean };
const MAX_CACHE_ENTRIES = 200;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, Cached>();
let cacheBytes = 0;

function discard(url: string): void {
  const previous = cache.get(url);
  if (previous) cacheBytes -= previous.size;
  cache.delete(url);
}

function remember(url: string, item: Cached): void {
  discard(url);
  if (item.size > MAX_CACHE_BYTES) return;
  cache.set(url, item);
  cacheBytes += item.size;
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    discard(oldest);
  }
}

async function request<T>(url: string, parse: (value: unknown) => T, signal: AbortSignal): Promise<Result<T>> {
  const cached = cache.get(url);
  if (cached) {
    cache.delete(url);
    cache.set(url, cached);
  }
  const response = await fetch(url, cached
    ? { signal, headers: { "If-None-Match": cached.etag } }
    : { signal });
  if (response.status === 304 && cached) return { value: parse(cached.value), changed: false };
  if (!response.ok) {
    let message = `Request failed (HTTP ${response.status}).`;
    try {
      const value: unknown = await response.json();
      if (isObject(value) && typeof value.detail === "string") message = value.detail;
    } catch {
      // Preserve the HTTP error when the response is not JSON.
    }
    throw new Error(message);
  }
  const serialized = await response.text();
  const value: unknown = JSON.parse(serialized);
  const parsed = parse(value);
  const etag = response.headers.get("ETag");
  // Budget the UTF-16 response text; parsed-object overhead varies by payload.
  if (etag) remember(url, { etag, value, size: serialized.length * 2 });
  else discard(url);
  return { value: parsed, changed: true };
}

export const api = {
  harnesses: (signal: AbortSignal): Promise<Result<HarnessList>> =>
    request("/api/v1/harnesses", parseHarnessList, signal),
  calls: (harness: string, query: URLSearchParams, signal: AbortSignal): Promise<Result<ToolCallPage>> =>
    request(`/api/v1/harnesses/${encodeURIComponent(harness)}/tool-calls?${query}`, parseToolCallPage, signal),
  facets: (harness: string, query: URLSearchParams, signal: AbortSignal): Promise<Result<ToolCallFacets>> =>
    request(`/api/v1/harnesses/${encodeURIComponent(harness)}/tool-call-facets?${query}`, parseToolCallFacets, signal),
  metrics: (harness: string, query: URLSearchParams, signal: AbortSignal): Promise<Result<ToolCallMetrics>> =>
    request(`/api/v1/harnesses/${encodeURIComponent(harness)}/tool-call-metrics?${query}`, parseToolCallMetrics, signal),
  detail: (harness: string, id: string, signal: AbortSignal): Promise<Result<ToolCallDetail>> =>
    request(`/api/v1/harnesses/${encodeURIComponent(harness)}/tool-calls/${encodeURIComponent(id)}`, parseToolCallDetail, signal),
};

export async function loadCallPages(
  harness: string, query: URLSearchParams, pageCount: number, signal: AbortSignal,
): Promise<ToolCallPage> {
  const data: ToolCallSummary[] = [];
  let result: ToolCallPage | undefined;
  let cursor: string | null = null;
  for (let page = 0; page < pageCount; page += 1) {
    const parameters = new URLSearchParams(query);
    if (cursor) parameters.set("cursor", cursor);
    result = (await api.calls(harness, parameters, signal)).value;
    data.push(...result.data);
    cursor = result.page.nextCursor;
    if (!cursor) break;
  }
  if (!result) throw new Error("At least one tool-call page is required.");
  return { ...result, data };
}
