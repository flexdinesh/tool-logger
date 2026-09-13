import type { ToolCallFacets } from "../../shared/api.ts";

export type FilterValues = {
  search: string;
  status: string;
  tool: string;
  session: string;
  range: string;
  directory: string;
  repository: string;
  agent: string;
};

export type FilterOptions = {
  tool: string[];
  session: string[];
  directory: string[];
  repository: string[];
  agent: string[];
  lifecycle: string[];
  outcome: string[];
};

export const emptyFilters: FilterValues = {
  search: "", status: "all", tool: "all", session: "all",
  range: "all", directory: "all", repository: "all", agent: "all",
};

export const emptyOptions: FilterOptions = {
  tool: [], session: [], directory: [], repository: [], agent: [], lifecycle: [], outcome: [],
};

export function filterOptions(facets: ToolCallFacets | undefined): FilterOptions {
  const values = (buckets: { value: string }[] | undefined) => buckets?.map((bucket) => bucket.value) ?? [];
  return {
    tool: values(facets?.data.tools), session: values(facets?.data.sessions),
    directory: values(facets?.data.directories), repository: values(facets?.data.repositories),
    agent: values(facets?.data.agents), lifecycle: values(facets?.data.lifecycles),
    outcome: values(facets?.data.outcomes),
  };
}

export function normalizeFilters(filters: FilterValues, options: FilterOptions): FilterValues {
  const validStatus = filters.status === "all"
    || (filters.status.startsWith("lifecycle:") && options.lifecycle.includes(filters.status.slice(10)))
    || (filters.status.startsWith("outcome:") && options.outcome.includes(filters.status.slice(8)));
  return {
    ...filters,
    status: validStatus ? filters.status : "all",
    tool: filters.tool === "all" || options.tool.includes(filters.tool) ? filters.tool : "all",
    session: filters.session === "all" || options.session.includes(filters.session) ? filters.session : "all",
    directory: filters.directory === "all" || options.directory.includes(filters.directory) ? filters.directory : "all",
    repository: filters.repository === "all" || options.repository.includes(filters.repository) ? filters.repository : "all",
    agent: filters.agent === "all" || options.agent.includes(filters.agent) ? filters.agent : "all",
  };
}

export function queryParameters(filters: FilterValues, now = Date.now()): URLSearchParams {
  const parameters = new URLSearchParams();
  const selected = (key: string, value: string) => {
    if (value !== "all") parameters.set(key, value);
  };
  if (filters.search.trim()) parameters.set("q", filters.search.trim());
  if (filters.status.startsWith("lifecycle:")) parameters.set("lifecycle", filters.status.slice(10));
  if (filters.status.startsWith("outcome:")) parameters.set("outcome", filters.status.slice(8));
  selected("tool", filters.tool);
  selected("session", filters.session);
  selected("agent", filters.agent);
  selected("repository", filters.repository);
  selected("directory", filters.directory);
  if (filters.range !== "all") parameters.set("since", new Date(now - Number(filters.range) * 3_600_000).toISOString());
  return parameters;
}

export function filtersFromUrl(parameters: URLSearchParams): FilterValues {
  const lifecycleValue = parameters.get("lifecycle");
  const outcomeValue = parameters.get("outcome");
  const lifecycle = lifecycleValue === "awaiting" || lifecycleValue === "finished" || lifecycleValue === "result-only"
    ? lifecycleValue : null;
  const outcome = outcomeValue === "success" || outcomeValue === "failure" || outcomeValue === "unknown"
    ? outcomeValue : null;
  const range = parameters.get("range");
  return {
    search: parameters.get("q") ?? "",
    status: lifecycle ? `lifecycle:${lifecycle}` : outcome ? `outcome:${outcome}` : "all",
    tool: parameters.get("tool") ?? "all", session: parameters.get("session") ?? "all",
    range: range === "1" || range === "24" ? range : "all",
    directory: parameters.get("directory") ?? "all", repository: parameters.get("repository") ?? "all",
    agent: parameters.get("agent") ?? "all",
  };
}
