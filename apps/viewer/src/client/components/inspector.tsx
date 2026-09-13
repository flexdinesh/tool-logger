import { X } from "lucide-react";
import { useRef } from "react";
import type { RefObject } from "react";
import { isObject } from "../../shared/api.ts";
import type { DetailFieldCapability, HarnessDescriptor, ToolCallDetail } from "../../shared/api.ts";
import { duration, repositoryName } from "../format.ts";
import type { PayloadTab } from "../state/viewer-reducer.ts";
import { CallStatus } from "./call-status.tsx";
import { GitSnapshots } from "./git-snapshots.tsx";
import { MetadataFields } from "./metadata-fields.tsx";
import { PayloadPanel } from "./payload-panel.tsx";
import { Button } from "./ui/button.tsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./ui/sheet.tsx";

function attribute(call: ToolCallDetail, key: string): string {
  const value = call.summary.attributes[key];
  return typeof value === "string" ? value : "";
}

function pathValue(call: ToolCallDetail, path: string): unknown {
  let value: unknown = call;
  for (const segment of path.split(".")) {
    if (!isObject(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function formatField(call: ToolCallDetail, field: DetailFieldCapability): string {
  const value = pathValue(call, field.path);
  if (field.format === "duration" && typeof value === "number") return duration(value);
  if (field.format === "timestamp" && typeof value === "string") return new Date(value).toLocaleString();
  if (field.format === "json") return JSON.stringify(value) ?? "Not recorded";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value) : "Not recorded";
}

export function Inspector({ call, descriptor, tab, onTabChange, returnFocusRef, searchRef, onClose }: {
  call: ToolCallDetail;
  descriptor: HarnessDescriptor | undefined;
  tab: PayloadTab;
  onTabChange: (tab: PayloadTab) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const summary = call.summary;
  const identifiers: [string, string][] = [
    ["Harness API", summary.harnessApiVersion === null ? "Not recorded" : String(summary.harnessApiVersion)],
    ["Call ID", attribute(call, "callId") || "Not recorded"],
    ["Turn", attribute(call, "turnId") || "Not recorded"],
    ["Message", attribute(call, "messageId") || "Not recorded"],
    ["Agent", summary.agentId || "Not recorded"],
    ...descriptor?.capabilities.detailFields.map((field): [string, string] => [field.label, formatField(call, field)]) ?? [],
  ];
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        id="inspector"
        aria-label="Tool call details"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const trigger = returnFocusRef.current;
          if (trigger?.isConnected) trigger.focus();
          else searchRef.current?.focus();
        }}
      >
        <SheetHeader className="inspector-heading mb-4">
          <span className="eyebrow text-xs font-semibold tracking-widest text-secondary">CALL DETAILS</span>
          <Button ref={closeRef} id="close" variant="ghost" size="icon" className="size-10" aria-label="Close call details" onClick={onClose}><X aria-hidden="true" /></Button>
        </SheetHeader>
        <SheetTitle id="detail-tool" className="mb-3 text-xl font-semibold tracking-tight wrap-break-word">{summary.tool}</SheetTitle>
        <div id="detail-status"><CallStatus call={summary} descriptor={descriptor} /></div>
        <dl id="metadata" className="my-6 grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-y border-border py-5 text-sm">
          <MetadataFields values={[
            ["Time", new Date(summary.observedAt).toLocaleString()],
            ["Duration", duration(summary.durationMs)],
            ["Session", summary.sessionId || "Not recorded"],
            ...identifiers,
            ["Directory", summary.directory || "Not recorded"],
            ["Repository", repositoryName(summary.repository) || "Not recorded"],
            ["Branch", attribute(call, "branch") || "Not recorded"],
          ]} />
        </dl>
        <GitSnapshots call={call} />
        <PayloadPanel call={call} tab={tab} onTabChange={onTabChange} />
        <p className="detail-note text-xs leading-5 text-muted">{descriptor?.capabilities.outcomeSemantics[summary.outcome]
          ?? "Inspect native events for harness-specific result details."}</p>
      </SheetContent>
    </Sheet>
  );
}
