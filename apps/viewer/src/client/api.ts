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
} from "../shared/api.ts";

type Cached = { etag: string; value: unknown };
type Result<T> = { value: T; changed: boolean };
const cache = new Map<string, Cached>();

async function request<T>(url: string, parse: (value: unknown) => T, signal: AbortSignal): Promise<Result<T>> {
  const cached = cache.get(url);
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
  const value: unknown = await response.json();
  const parsed = parse(value);
  const etag = response.headers.get("ETag");
  if (etag) cache.set(url, { etag, value });
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
