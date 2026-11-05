import type { ToolCallFacets } from "../../shared/api.ts";
export type FilterValues = {
  search: string; status: string; lifecycle: string; outcome: string; tool: string; session: string;
  range: string; since: string; until: string; directory: string; repository: string; agent: string;
};
export type FilterOptions = {
  tool: string[]; session: string[]; directory: string[]; repository: string[];
  agent: string[]; lifecycle: string[]; outcome: string[];
};
export const emptyFilters: FilterValues = {
  search: "", status: "all", lifecycle: "all", outcome: "all", tool: "all", session: "all",
  range: "all", since: "", until: "", directory: "all", repository: "all", agent: "all",
};
export const emptyOptions: FilterOptions = { tool: [], session: [], directory: [], repository: [], agent: [], lifecycle: [], outcome: [] };
export function filterOptions(facets: ToolCallFacets | undefined): FilterOptions {
  const values = (buckets: { value: string }[] | undefined) => buckets?.map((b) => b.value) ?? [];
  return { tool: values(facets?.data.tools), session: values(facets?.data.sessions),
    directory: values(facets?.data.directories), repository: values(facets?.data.repositories),
    agent: values(facets?.data.agents), lifecycle: ["awaiting", "finished", "result-only"],
    outcome: ["success", "failure", "unknown"] };
}
export function hasFilters(filters: FilterValues): boolean {
  return Object.entries(filters).some(([key, value]) => ["search", "since", "until"].includes(key) ? Boolean(value.trim()) : value !== "all");
}
export function queryParameters(filters: FilterValues, now = Date.now(), bounded = true): URLSearchParams {
  const q = new URLSearchParams();
  if (filters.search.trim()) q.set("q", filters.search.trim());
  for (const key of ["tool", "session", "agent", "repository", "directory", "lifecycle", "outcome"]) {
    const value = Reflect.get(filters, key);
    if (typeof value === "string" && value !== "all") for (const item of value.split(";").map((s) => s.trim()).filter(Boolean)) q.append(key, item);
  }
  if (filters.status.startsWith("lifecycle:")) q.set("lifecycle", filters.status.slice(10));
  if (filters.status.startsWith("outcome:")) q.set("outcome", filters.status.slice(8));
  if (filters.range === "custom") {
    if (filters.since && Number.isFinite(Date.parse(filters.since))) q.set("since", new Date(filters.since).toISOString());
    if (filters.until && Number.isFinite(Date.parse(filters.until))) q.set("until", new Date(filters.until).toISOString());
  } else if (filters.range !== "all") {
    const hours = Number(filters.range);
    if (Number.isFinite(hours) && hours > 0) q.set("since", new Date(now - hours * 3_600_000).toISOString());
    if (bounded) q.set("until", new Date(now).toISOString());
  }
  return q;
}
export function filtersFromUrl(q: URLSearchParams): FilterValues {
  const repeated = (key: string) => q.getAll(key).join("; ") || "all";
  const nativeRanges: Record<string, string> = { "All time": "all", "15 minutes": "0.25", "1 hour": "1", "24 hours": "24", "7 days": "168", Custom: "custom" };
  const rawRange = q.get("range");
  const range = rawRange ? nativeRanges[rawRange] ?? rawRange : null;
  return { ...emptyFilters, search: q.get("q") ?? "", lifecycle: repeated("lifecycle"), outcome: repeated("outcome"),
    tool: repeated("tool"), session: repeated("session"), agent: repeated("agent"),
    repository: repeated("repository"), directory: repeated("directory"),
    range: ["0.25", "1", "24", "168", "custom"].includes(range ?? "") ? range ?? "all" : (q.has("since") || q.has("until")) ? "custom" : "all",
    since: q.get("since") ?? "", until: q.get("until") ?? "" };
}
