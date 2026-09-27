import { X } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";
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
import { Alert } from "./ui/alert.tsx";
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

const desktopQuery = "(min-width: 70rem)";

function subscribeToViewport(onChange: () => void) {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isDesktop() {
  return window.matchMedia(desktopQuery).matches;
}

export function Inspector({ call, loading, error, descriptor, tab, onTabChange, returnFocusRef, searchRef, onClose, onRetry }: {
  call: ToolCallDetail | undefined;
  loading: boolean;
  error: string;
  descriptor: HarnessDescriptor | undefined;
  tab: PayloadTab;
  onTabChange: (tab: PayloadTab) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onRetry: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const docked = useSyncExternalStore(subscribeToViewport, isDesktop, () => false);
  const summary = call?.summary;
  const identifiers: [string, string][] = call && summary ? [
    ["Harness API", summary.harnessApiVersion === null ? "Not recorded" : String(summary.harnessApiVersion)],
    ["Call ID", attribute(call, "callId") || "Not recorded"],
    ["Turn", attribute(call, "turnId") || "Not recorded"],
    ["Message", attribute(call, "messageId") || "Not recorded"],
    ["Agent", summary.agentId || "Not recorded"],
    ...descriptor?.capabilities.detailFields.map((field): [string, string] => [field.label, formatField(call, field)]) ?? [],
  ] : [];
  return (
    <Sheet open modal={!docked} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        id="inspector"
        docked={docked}
        aria-label="Tool call details"
        aria-describedby={undefined}
        onInteractOutside={(event) => { if (docked) event.preventDefault(); }}
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
          <SheetTitle id="detail-tool" className="text-xl font-semibold tracking-tight wrap-break-word">{summary?.tool ?? "Call details"}</SheetTitle>
          <Button ref={closeRef} id="close" variant="ghost" size="icon" aria-label="Close call details" onClick={onClose}><X aria-hidden="true" /></Button>
        </SheetHeader>
        {error && <Alert>{error} <Button variant="ghost" size="compact" disabled={loading} onClick={onRetry}>Retry details</Button></Alert>}
        {call && summary ? <>
        <div id="detail-status"><CallStatus call={summary} descriptor={descriptor} /></div>
        <dl id="metadata" className="my-4 grid grid-cols-[72px_minmax(0,1fr)] gap-2 border-y border-border py-3 text-xs">
          <MetadataFields values={[
            ["Harness", descriptor?.label ?? summary.harness],
            ["Time", new Date(summary.observedAt).toLocaleString()],
            ["Duration", duration(summary.durationMs)],
          ]} />
        </dl>
        <PayloadPanel call={call} tab={tab} onTabChange={onTabChange} />
        <details className="detail-context"><summary>Context and identifiers</summary>
          <dl className="my-3 grid grid-cols-[88px_minmax(0,1fr)] gap-2 text-xs"><MetadataFields values={[
            ["Session", summary.sessionId || "Not recorded"],
            ...identifiers,
            ["Directory", summary.directory || "Not recorded"],
            ["Repository", repositoryName(summary.repository) || "Not recorded"],
            ["Branch", attribute(call, "branch") || "Not recorded"],
          ]} /></dl>
        </details>
        <GitSnapshots call={call} />
        <p className="detail-note text-xs leading-5 text-muted">{descriptor?.capabilities.outcomeSemantics[summary.outcome]
          ?? "Inspect native events for harness-specific result details."}</p>
        </> : loading ? <div className="calls-loading" role="status" aria-label="Loading call details"><div /><div /><div /></div> : !error && <p role="alert" className="text-sm text-destructive">Call details unavailable.</p>}
      </SheetContent>
    </Sheet>
  );
}
