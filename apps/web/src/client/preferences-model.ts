import { isObject } from "../shared/api.ts";
export type Theme = "system" | "light" | "dark";
export type PayloadTab = "input" | "output" | "native" | "raw" | "metadata" | "git";
export type Preferences = {
  version: 1; query: string; theme: Theme; sidebar: number; collection: number; tab: PayloadTab;
  selected: string; selectedSource: string; paused: boolean; columns: { order: string[]; widths: Record<string, number> };
  filters: boolean; chartsHidden: boolean;
};
export const defaultColumns = ["tool", "source", "harness", "state", "duration", "time"];
export const defaults: Preferences = {
  version: 1, query: "", theme: "system", sidebar: 208, collection: 64, tab: "input", selected: "", selectedSource: "",
  paused: false, columns: { order: [...defaultColumns], widths: {} }, filters: false, chartsHidden: false,
};
export function isPayloadTab(value: unknown): value is PayloadTab {
  return value === "input" || value === "output" || value === "native" || value === "raw" || value === "metadata" || value === "git";
}
function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
export function normalizePreferences(value: unknown): Preferences {
  if (!isObject(value)) return structuredClone(defaults);
  const theme = typeof value.theme === "string" ? value.theme.toLowerCase() : "";
  const rawTab = typeof value.tab === "string" ? value.tab.toLowerCase() : "";
  const tab = rawTab === "result" ? "output" : rawTab === "raw events" ? "raw" : rawTab;
  const q = new URLSearchParams();
  if (typeof value.query === "string") {
    const allowed = new Set(["q", "source", "harness", "tool", "session", "agent", "repository", "directory", "lifecycle", "outcome", "range", "since", "until"]);
    for (const [key, item] of new URLSearchParams(value.query)) if (allowed.has(key)) q.append(key, item);
  } else if (isObject(value.query)) {
    const allowed = ["q", "source", "harness", "tool", "session", "agent", "repository", "directory", "lifecycle", "outcome", "since", "until"];
    for (const key of allowed) {
      const items = value.query[key];
      if (Array.isArray(items)) for (const item of items) if (typeof item === "string") q.append(key, item);
    }
  }
  const ranges: Record<string, string> = { "All time": "all", "15 minutes": "0.25", "1 hour": "1", "24 hours": "24", "7 days": "168", "Custom": "custom" };
  if (typeof value.timeRange === "string" && ranges[value.timeRange]) q.set("range", ranges[value.timeRange] ?? "all");
  const columns = isObject(value.columns) ? value.columns : {};
  const rawOrder: unknown = columns.order ?? columns.Order;
  const rawWidths: unknown = columns.widths ?? columns.Widths;
  const compatible: Record<string, string> = { Tool: "tool", Input: "tool", Harness: "harness", State: "state", Recorded: "time", Duration: "duration" };
  const columnKey = (key: string) => compatible[key] ?? key;
  const order = Array.isArray(rawOrder) ? rawOrder.filter((v: unknown): v is string => typeof v === "string").map(columnKey).filter((v) => defaultColumns.includes(v)) : [];
  const widths: Record<string, number> = {};
  if (isObject(rawWidths)) for (const [key, width] of Object.entries(rawWidths)) {
    const mapped = columnKey(key);
    if (!defaultColumns.includes(mapped)) continue;
    const size = bounded(width, 140, 80, 800);
    widths[mapped] = key === "Input" || key === "Tool" ? Math.min(800, (widths[mapped] ?? 0) + size) : size;
  }
  return { version: 1, query: q.toString(), theme: theme === "light" || theme === "dark" ? theme : "system",
    sidebar: bounded(value.sidebar, 208, 160, 360), collection: bounded(value.collection, 64, 30, 85),
    tab: isPayloadTab(tab) ? tab : "input", selected: typeof value.selected === "string" ? value.selected : "",
    selectedSource: typeof value.selectedSource === "string" ? value.selectedSource : "",
    paused: value.paused === true, columns: { order: [...new Set([...order, ...defaultColumns])], widths },
    filters: value.filters === true, chartsHidden: value.chartsHidden === true };
}
