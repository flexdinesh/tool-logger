import { Search } from "lucide-react";
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

export function Filters({ filters, options, descriptor, searchRef, onChange, onClear }: {
  filters: FilterValues;
  options: FilterOptions;
  descriptor: HarnessDescriptor | undefined;
  searchRef: Ref<HTMLInputElement>;
  onChange: (key: keyof FilterValues, value: string) => void;
  onClear: () => void;
}) {
  const active = Boolean(filters.search.trim()) || Object.entries(filters).some(([key, value]) => key !== "search" && value !== "all");
  const selectClass = "w-full sm:w-auto sm:max-w-40";
  const supportsAgent = descriptor?.capabilities.filters.some((filter) => filter.id === "agent") ?? false;
  return <>
    <div className="filters flex flex-wrap items-center gap-2 px-4 pt-5 pb-4 sm:px-6">
      <label className="search relative flex h-10 min-w-48 flex-1 items-center"><Search aria-hidden="true" className="pointer-events-none absolute left-3 size-4 text-muted" /><Input ref={searchRef} id="search" className="w-full pr-9 pl-9" type="search" placeholder="Search tools, commands, or content…" aria-label="Search tool calls" value={filters.search} onChange={(event) => onChange("search", event.currentTarget.value)} /><kbd className="pointer-events-none absolute right-3 rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted">/</kbd></label>
      <Select className={selectClass} id="status" aria-label="Filter by status" value={filters.status} onChange={(event) => onChange("status", event.currentTarget.value)}>
        <option value="all">All statuses</option>
        {options.lifecycle.map((value) => <option key={`lifecycle:${value}`} value={`lifecycle:${value}`}>{statusLabel(value)}</option>)}
        {options.outcome.filter((value) => value !== "unknown").map((value) => <option key={`outcome:${value}`} value={`outcome:${value}`}>{statusLabel(value)}</option>)}
      </Select>
      <Select className={selectClass} id="tool" aria-label="Filter by tool" value={filters.tool} onChange={(event) => onChange("tool", event.currentTarget.value)}><option value="all">All tools</option>{options.tool.map((tool) => <option key={tool} value={tool}>{tool === "unknown" ? "Not recorded" : tool}</option>)}</Select>
      <Select className={selectClass} id="session" aria-label="Filter by session" value={filters.session} onChange={(event) => onChange("session", event.currentTarget.value)}><option value="all">All sessions</option>{options.session.map((session) => <option key={session} value={session}>{session === "unknown" ? "Not recorded" : session}</option>)}</Select>
      {supportsAgent && <Select className={selectClass} id="agent" aria-label="Filter by agent" value={filters.agent} onChange={(event) => onChange("agent", event.currentTarget.value)}><option value="all">All agents</option>{options.agent.map((agent) => <option key={agent} value={agent}>{agent === "unknown" ? "Not recorded" : agent}</option>)}</Select>}
      <Select className={selectClass} id="range" aria-label="Filter by time" value={filters.range} onChange={(event) => onChange("range", event.currentTarget.value)}><option value="all">All time</option><option value="1">Last hour</option><option value="24">Last 24 hours</option></Select>
      <Button id="clear" variant="ghost" size="compact" hidden={!active} onClick={onClear}>Reset</Button>
    </div>
    <div className="context-filters flex flex-wrap gap-3 px-4 pb-5 sm:px-6">
      <label className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-sm text-secondary">Repository<Select className="min-w-0 flex-1" id="repository" aria-label="Filter by repository" value={filters.repository} onChange={(event) => onChange("repository", event.currentTarget.value)}><option value="all">All repositories</option>{options.repository.map((root) => <option key={root} value={root}>{root === "unknown" ? "No repository recorded" : repositoryLabel(root, options.repository)}</option>)}</Select></label>
      <label className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-sm text-secondary">Directory<Select className="min-w-0 flex-1" id="directory" aria-label="Filter by directory" value={filters.directory} onChange={(event) => onChange("directory", event.currentTarget.value)}><option value="all">All directories</option>{options.directory.map((directory) => <option key={directory} value={directory}>{directory === "unknown" ? "No directory recorded" : directory}</option>)}</Select></label>
    </div>
  </>;
}
