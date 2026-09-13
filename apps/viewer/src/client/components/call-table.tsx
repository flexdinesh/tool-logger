import { ChevronDown, ExternalLink, FilePenLine, Radar, Search, Terminal } from "lucide-react";
import type { HarnessDescriptor, SourceHealth, ToolCallSummary } from "../../shared/api.ts";
import { clock, duration, number, repositoryName } from "../format.ts";
import { CallStatus } from "./call-status.tsx";
import { Button } from "./ui/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableWrap } from "./ui/table.tsx";

type CallRowProps = {
  call: ToolCallSummary;
  descriptor: HarnessDescriptor | undefined;
  showAgent: boolean;
  selected: boolean;
  onOpen: (id: string, row: HTMLTableRowElement) => void;
};

function attribute(call: ToolCallSummary, key: string): string {
  const value = call.attributes[key];
  return typeof value === "string" ? value : "";
}

function CallRow({ call, descriptor, showAgent, selected, onOpen }: CallRowProps) {
  const branch = attribute(call, "branch");
  const repository = call.repository
    ? repositoryName(call.repository) + (branch ? ` · ${branch}` : "")
    : "No repository recorded";
  const ToolIcon = call.tool.toLowerCase() === "bash" ? Terminal : call.tool === "apply_patch" ? FilePenLine : Search;
  const identifier = attribute(call, "callId") || call.sessionId || "";
  const message = attribute(call, "messageId");
  return (
    <TableRow
      className={`call-row cursor-pointer hover:bg-surface-secondary ${selected ? "selected bg-accent-soft" : ""}`} tabIndex={0}
      aria-label={`Inspect ${call.tool} at ${clock(call.observedAt)}`}
      onClick={(event) => onOpen(call.id, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(call.id, event.currentTarget);
        }
      }}
    >
      <TableCell className="max-w-sm min-w-56 pl-6">
        <div className="tool-cell flex items-center gap-3">
          <span className="tool-icon flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-secondary text-accent"><ToolIcon aria-hidden="true" className="size-4" /></span>
          <div className="tool-text min-w-0"><div className="tool-title text-sm font-medium text-foreground">{call.tool}</div><div className="tool-summary mt-1 max-w-sm truncate font-mono text-xs text-muted">{call.inputSummary}</div></div>
        </div>
      </TableCell>
      <TableCell className="repository-cell max-w-64" title={[call.repository, branch, call.directory].filter(Boolean).join("\n")}>
        <div className="repository-name max-w-60 truncate text-sm text-secondary">{repository}</div>
        <div className="directory-path mt-1 max-w-60 truncate font-mono text-xs text-muted">{call.directory || "No directory recorded"}</div>
      </TableCell>
      <TableCell><CallStatus call={call} descriptor={descriptor} /></TableCell>
      <TableCell>{duration(call.durationMs)}</TableCell>
      {showAgent && <TableCell><div className="text-sm text-secondary">{call.agentId || "Not recorded"}</div><div className="mt-1 font-mono text-xs text-muted" title={message}>{message ? message.slice(0, 14) : "No message ID"}</div></TableCell>}
      <TableCell title={identifier}><span className="session-tag rounded-sm border border-border px-2 py-1 font-mono text-xs text-muted">{identifier.slice(0, 14) || "—"}</span></TableCell>
      <TableCell className="cell-time tabular-nums">{clock(call.observedAt)}</TableCell><TableCell className="arrow-cell pr-6 pl-0 text-border-strong"><ExternalLink aria-hidden="true" className="size-4" /></TableCell>
    </TableRow>
  );
}

export function CallTable({ calls, descriptor, selected, onOpen }: {
  calls: ToolCallSummary[];
  descriptor: HarnessDescriptor | undefined;
  selected: string | null;
  onOpen: CallRowProps["onOpen"];
}) {
  const showAgent = descriptor?.capabilities.filters.some((filter) => filter.id === "agent") ?? false;
  return (
    <TableWrap>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-6">TOOL / INPUT</TableHead><TableHead>REPOSITORY / DIRECTORY</TableHead><TableHead>STATUS</TableHead>
            <TableHead>DURATION</TableHead>{showAgent && <TableHead>AGENT / MESSAGE</TableHead>}<TableHead>SESSION / CALL</TableHead><TableHead>TIME</TableHead><TableHead><span className="sr-only">Inspect</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody id="rows">
          {calls.map((call) => <CallRow key={call.id} call={call} descriptor={descriptor} showAgent={showAgent} selected={selected === call.id} onOpen={onOpen} />)}
        </TableBody>
      </Table>
    </TableWrap>
  );
}

export function CallEmptyState({ loaded, descriptor, count, total }: {
  loaded: boolean;
  descriptor: HarnessDescriptor | undefined;
  count: number;
  total: number;
}) {
  const hasCalls = total > 0;
  const message = hasCalls
    ? "Try a different search or reset the filters to see all calls."
    : !descriptor
      ? "Install a supported logger and make a tool call. Available harnesses appear in the navigation."
      : `New ${descriptor.label} tool calls will appear automatically. Only complete, valid events are shown.`;
  return (
    <div id="empty" className="empty px-6 py-12 text-center" hidden={!loaded || count > 0}>
      <div className="empty-icon mx-auto mb-4 flex size-12 items-center justify-center rounded-lg border border-border bg-accent-soft text-accent"><Radar aria-hidden="true" className="size-5" /></div>
      <h3 id="empty-title" className="text-lg font-semibold text-foreground">{hasCalls ? "No matching calls" : "Waiting for your first tool call"}</h3>
      <p id="empty-message" className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{message}</p>
    </div>
  );
}

export function CallTableFooter({ health, total, hasMore, loadingMore, onMore }: {
  health: SourceHealth | undefined;
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
}) {
  const note = health?.message ?? "Newest calls first · refreshes every 2 seconds";
  return (
    <footer className="table-footer flex items-center justify-between gap-3 px-4 py-4 text-xs text-muted sm:px-6">
      <span id="window-note">{note}</span>
      <Button id="more" variant="ghost" size="compact" disabled={loadingMore} hidden={!hasMore} onClick={onMore}>{loadingMore ? "Loading…" : "Show more"} <ChevronDown aria-hidden="true" /></Button>
      <span id="event-count">{number(total)} calls</span>
    </footer>
  );
}
