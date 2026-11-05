import { Search, SlidersHorizontal, X } from "lucide-react";
import type { Ref } from "react";
import type { HarnessDescriptor } from "../../shared/api.ts";
import { repositoryLabel } from "../format.ts";
import type { FilterOptions, FilterValues } from "../state/filters.ts";
import { usePreferences } from "../preferences.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Select } from "./ui/select.tsx";
const keys: (keyof FilterValues)[] = ["search", "range", "lifecycle", "outcome", "tool", "session", "agent", "repository", "directory", "since", "until"];
export function Filters({ filters, options, searchRef, onChange, onClear }: {
  filters: FilterValues; options: FilterOptions; descriptor: HarnessDescriptor | undefined; searchRef: Ref<HTMLInputElement>;
  onChange: (key: keyof FilterValues, value: string) => void; onClear: () => void;
}) {
  const { preferences, updatePreferences } = usePreferences();
  const active = keys.filter((key) => ["search", "since", "until"].includes(key) ? Boolean(filters[key].trim()) : filters[key] !== "all");
  const dimensions: { key: keyof FilterOptions; label: string; empty: string }[] = [
    { key: "lifecycle", label: "Lifecycle", empty: "All lifecycles" }, { key: "outcome", label: "Outcome", empty: "All outcomes" },
    { key: "tool", label: "Tool", empty: "All tools" }, { key: "session", label: "Session", empty: "All sessions" },
    { key: "agent", label: "Agent", empty: "All agents" }, { key: "repository", label: "Repository", empty: "All repositories" },
    { key: "directory", label: "Directory", empty: "All directories" },
  ];
  function label(key: string, value: string): string {
    if (key === "repository" && value !== "unknown") return repositoryLabel(value, options.repository);
    if (value === "awaiting") return "Awaiting result";
    if (value === "finished") return "Result received";
    if (value === "result-only") return "Result only";
    if (value === "unknown") return key === "outcome" ? "Unknown outcome" : "Not recorded";
    return value;
  }
  return <div className="filters"><div className="filter-toolbar">
    <label className="search"><Search aria-hidden="true" /><Input ref={searchRef} id="search" type="search" placeholder="Search tools, commands, or content…" aria-label="Search tool calls" value={filters.search} maxLength={1024} onChange={(e) => onChange("search", e.currentTarget.value)} /><kbd>/</kbd></label>
    <Select id="range" aria-label="Filter by time" value={filters.range} onChange={(e) => onChange("range", e.currentTarget.value)}><option value="all">All time</option><option value="0.25">15 minutes</option><option value="1">Last hour</option><option value="24">Last 24 hours</option><option value="168">7 days</option><option value="custom">Custom time</option></Select>
  </div>
    <details className="filter-disclosure" open={preferences.filters} onToggle={(e) => { if (e.currentTarget.open !== preferences.filters) updatePreferences({ filters: e.currentTarget.open }); }}>
      <summary><SlidersHorizontal aria-hidden="true" />Filters{active.length > 0 && <span>{active.length}</span>}</summary>
      <div className="filter-grid">{dimensions.map(({ key, label: title, empty }) => {
        const values = [...new Set([...options[key], ...filters[key].split(";").map((s) => s.trim()).filter((s) => s && s !== "all")])];
        return <label key={key}>{title}<Select id={key} aria-label={"Filter by " + key} multiple value={filters[key] === "all" ? [] : filters[key].split(";").map((s) => s.trim())} onChange={(e) => onChange(key, [...e.currentTarget.selectedOptions].map((o) => o.value).join("; ") || "all")}>
          <option value="" disabled>{empty}</option>{values.map((value) => <option key={value} value={value}>{label(key, value)}</option>)}</Select></label>;
      })}
        <label>Since (UTC)<Input aria-label="Filter since" type="datetime-local" value={filters.since ? filters.since.replace(/Z$/, "").slice(0, 19) : ""} onChange={(e) => onChange("since", e.currentTarget.value ? e.currentTarget.value + "Z" : "")} /></label>
        <label>Until (UTC)<Input aria-label="Filter until" type="datetime-local" value={filters.until ? filters.until.replace(/Z$/, "").slice(0, 19) : ""} onChange={(e) => onChange("until", e.currentTarget.value ? e.currentTarget.value + "Z" : "")} /></label>
      </div>
    </details>
    {active.length > 0 && <div className="active-filters">{active.map((key) => <Button key={key} variant="outline" size="compact" className="filter-chip" onClick={() => onChange(key, ["search", "since", "until"].includes(key) ? "" : "all")} aria-label={"Remove " + key + " filter"}>{key}: {filters[key]}<X aria-hidden="true" /></Button>)}<Button id="clear" variant="ghost" size="compact" onClick={onClear}>Reset</Button></div>}
  </div>;
}
