import { Search, SlidersHorizontal, X } from "lucide-react";
import type { Ref } from "react";
import type { HarnessDescriptor } from "../../shared/api.ts";
import { repositoryLabel } from "../format.ts";
import type { FilterOptions, FilterValues } from "../state/filters.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Select } from "./ui/select.tsx";

function statusLabel(value: string): string {
  if (value === "awaiting") return "Awaiting result";
  if (value === "finished") return "Result received";
  if (value === "result-only") return "Result only";
  if (value === "success") return "Succeeded";
  if (value === "failure") return "Failed";
  return value;
}

const filterKeys: (keyof FilterValues)[] = ["search", "range", "status", "tool", "session", "agent", "repository", "directory"];

export function Filters({ filters, options, descriptor, searchRef, onChange, onClear }: {
  filters: FilterValues;
  options: FilterOptions;
  descriptor: HarnessDescriptor | undefined;
  searchRef: Ref<HTMLInputElement>;
  onChange: (key: keyof FilterValues, value: string) => void;
  onClear: () => void;
}) {
  const active = filterKeys.filter((key) => key === "search" ? Boolean(filters[key].trim()) : filters[key] !== "all");
  const supportsAgent = descriptor?.capabilities.filters.some((filter) => filter.id === "agent") ?? false;
  return <div className="filters">
    <div className="filter-toolbar">
      <label className="search"><Search aria-hidden="true" /><Input ref={searchRef} id="search" type="search" placeholder="Search tools, commands, or content…" aria-label="Search tool calls" value={filters.search} onChange={(event) => onChange("search", event.currentTarget.value)} /><kbd>/</kbd></label>
      <Select id="range" aria-label="Filter by time" value={filters.range} onChange={(event) => onChange("range", event.currentTarget.value)}><option value="all">All time</option><option value="1">Last hour</option><option value="24">Last 24 hours</option></Select>
    </div>
    <details className="filter-disclosure"><summary><SlidersHorizontal aria-hidden="true" />Filters{active.length > 0 && <span>{active.length}</span>}</summary>
      <div className="filter-grid">
        <label>Status<Select id="status" aria-label="Filter by status" value={filters.status} onChange={(event) => onChange("status", event.currentTarget.value)}>
          <option value="all">All statuses</option>
          {options.lifecycle.map((value) => <option key={"lifecycle:" + value} value={"lifecycle:" + value}>{statusLabel(value)}</option>)}
          {options.outcome.filter((value) => value !== "unknown").map((value) => <option key={"outcome:" + value} value={"outcome:" + value}>{statusLabel(value)}</option>)}
        </Select></label>
        <label>Tool<Select id="tool" aria-label="Filter by tool" value={filters.tool} onChange={(event) => onChange("tool", event.currentTarget.value)}><option value="all">All tools</option>{options.tool.map((tool) => <option key={tool} value={tool}>{tool === "unknown" ? "Not recorded" : tool}</option>)}</Select></label>
        <label>Session<Select id="session" aria-label="Filter by session" value={filters.session} onChange={(event) => onChange("session", event.currentTarget.value)}><option value="all">All sessions</option>{options.session.map((session) => <option key={session} value={session}>{session === "unknown" ? "Not recorded" : session}</option>)}</Select></label>
        {supportsAgent && <label>Agent<Select id="agent" aria-label="Filter by agent" value={filters.agent} onChange={(event) => onChange("agent", event.currentTarget.value)}><option value="all">All agents</option>{options.agent.map((agent) => <option key={agent} value={agent}>{agent === "unknown" ? "Not recorded" : agent}</option>)}</Select></label>}
        <label>Repository<Select id="repository" aria-label="Filter by repository" value={filters.repository} onChange={(event) => onChange("repository", event.currentTarget.value)}><option value="all">All repositories</option>{options.repository.map((root) => <option key={root} value={root}>{root === "unknown" ? "No repository recorded" : repositoryLabel(root, options.repository)}</option>)}</Select></label>
        <label>Directory<Select id="directory" aria-label="Filter by directory" value={filters.directory} onChange={(event) => onChange("directory", event.currentTarget.value)}><option value="all">All directories</option>{options.directory.map((directory) => <option key={directory} value={directory}>{directory === "unknown" ? "No directory recorded" : directory}</option>)}</Select></label>
      </div>
    </details>
    {active.length > 0 && <div className="active-filters">{active.map((key) => <Button key={key} variant="outline" size="compact" className="filter-chip" onClick={() => onChange(key, key === "search" ? "" : "all")} aria-label={"Remove " + key + " filter"}>{key}: {filters[key]}<X aria-hidden="true" /></Button>)}<Button id="clear" variant="ghost" size="compact" onClick={onClear}>Reset</Button></div>}
  </div>;
}
