import { ChevronDown, ChevronRight } from "lucide-react";
import type { HarnessDescriptor, SourceHealth, ToolCallSummary } from "../../shared/api.ts";
import { calendarDate, clock, duration, number } from "../format.ts";
import { CallStatus } from "./call-status.tsx";
import { Button } from "./ui/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableWrap } from "./ui/table.tsx";

function harnessLabel(id: string) { return id === "codex" ? "Codex" : id === "opencode" ? "OpenCode" : id; }

export function CallTable({ calls, descriptor, selected, onOpen, loading }: {
  calls: ToolCallSummary[];
  descriptor: HarnessDescriptor | undefined;
  selected: string | null;
  onOpen: (id: string, trigger: HTMLElement) => void;
  loading: boolean;
}) {
  if (loading && !calls.length) return <div className="calls-loading" role="status" aria-label="Loading tool calls"><div /><div /><div /></div>;
  return <>
    <TableWrap className="desktop-calls"><Table>
      <TableHeader><TableRow><TableHead>Tool / input</TableHead><TableHead>Harness</TableHead><TableHead>State</TableHead><TableHead>Duration</TableHead><TableHead>Time</TableHead><TableHead><span className="sr-only">Inspect</span></TableHead></TableRow></TableHeader>
      <TableBody id="rows">{calls.map((call) => <TableRow key={call.id} className={selected === call.id ? "call-row selected" : "call-row"} tabIndex={0} aria-label={"Inspect " + call.tool + " at " + clock(call.observedAt)} onClick={(event) => onOpen(call.id, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(call.id, event.currentTarget); } }}>
        <TableCell className="tool-cell"><strong>{call.tool}</strong><code title={call.inputSummary}>{call.inputSummary}</code></TableCell>
        <TableCell><span className={"harness-label " + call.harness}>{harnessLabel(call.harness)}</span></TableCell>
        <TableCell><CallStatus call={call} descriptor={descriptor} /></TableCell>
        <TableCell className="tabular-nums">{duration(call.durationMs)}</TableCell>
        <TableCell className="tabular-nums"><time dateTime={call.observedAt} title={new Date(call.observedAt).toLocaleString()}>{clock(call.observedAt)}</time><span className="call-date">{calendarDate(call.observedAt)}</span></TableCell>
        <TableCell><ChevronRight aria-hidden="true" className="size-4 text-muted" /></TableCell>
      </TableRow>)}</TableBody>
    </Table></TableWrap>
    <ul id="mobile-calls" className="mobile-calls">{calls.map((call) => <li key={call.id}><button className={selected === call.id ? "mobile-call selected" : "mobile-call"} type="button" onClick={(event) => onOpen(call.id, event.currentTarget)} aria-label={"Inspect " + call.tool + " at " + clock(call.observedAt)}>
      <span className="mobile-call-heading"><strong>{call.tool}</strong><span className={"harness-label " + call.harness}>{harnessLabel(call.harness)}</span><ChevronRight aria-hidden="true" /></span>
      <code title={call.inputSummary}>{call.inputSummary}</code>
      <span className="mobile-call-meta"><CallStatus call={call} descriptor={descriptor} /><time dateTime={call.observedAt}>{calendarDate(call.observedAt)} · {clock(call.observedAt)}</time><span>{duration(call.durationMs)}</span></span>
    </button></li>)}</ul>
  </>;
}

export function CallEmptyState({ loaded, descriptor, count, total, hasFilters }: {
  loaded: boolean;
  descriptor: HarnessDescriptor | undefined;
  count: number;
  total: number;
  hasFilters: boolean;
}) {
  const hasCalls = total > 0 || hasFilters;
  return <div id="empty" className="empty" hidden={!loaded || count > 0}>
    <h3 id="empty-title">{hasCalls ? "No matching calls" : "Waiting for your first tool call"}</h3>
    <p id="empty-message">{hasCalls ? "Change your search or reset filters to see more calls." : descriptor ? "New tool calls appear automatically. Check source health if activity is missing." : "Install a supported logger and make a tool call. Your local logs will appear here."}</p>
  </div>;
}

export function CallTableFooter({ health, total, hasMore, loadingMore, onMore }: {
  health: SourceHealth | undefined; total: number; hasMore: boolean; loadingMore: boolean; onMore: () => void;
}) {
  return <footer className="table-footer"><span id="window-note">{health?.message ?? "Newest first · updates every 2 seconds"}</span>
    <Button id="more" variant="ghost" size="compact" disabled={loadingMore} hidden={!hasMore} onClick={onMore}>{loadingMore ? "Loading…" : "Show more"}<ChevronDown aria-hidden="true" /></Button>
    <span id="event-count">{number(total)} calls</span>
  </footer>;
}
