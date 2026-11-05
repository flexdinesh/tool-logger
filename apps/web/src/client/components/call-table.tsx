import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, PointerEvent } from "react";
import type { HarnessDescriptor, ToolCallSummary } from "../../shared/api.ts";
import { calendarDate, clock, duration, number } from "../format.ts";
import { callKey } from "../api.ts";
import { usePreferences } from "../preferences.tsx";
import { useViewerState } from "../state/viewer-context.ts";
import { CallStatus } from "./call-status.tsx";
import { Button } from "./ui/button.tsx";
const phoneQuery = "(max-width: 40rem)";
const subscribe = (change: () => void) => { const q = matchMedia(phoneQuery); q.addEventListener("change", change); return () => q.removeEventListener("change", change); };
const isPhone = () => matchMedia(phoneQuery).matches;
const labels: Record<string, string> = { tool: "Tool / input", source: "Source", harness: "Harness", state: "State", duration: "Duration", time: "Time" };
export function CallTable({ calls, descriptor, selected, onOpen, loading }: {
  calls: ToolCallSummary[]; descriptor: HarnessDescriptor | undefined; selected: string | null;
  onOpen: (id: string, trigger: HTMLElement, sourceId?: string) => void; loading: boolean;
}) {
  const { sources, selectedCallSource } = useViewerState();
  const { preferences, updatePreferences } = usePreferences();
  const phone = useSyncExternalStore(subscribe, isPhone, () => false);
  const height = phone ? 126 : 64;
  const scroll = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0), [viewport, setViewport] = useState(480);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element); return () => observer.disconnect();
  }, [loading, phone]);
  const start = Math.max(0, Math.min(Math.max(0, calls.length - 1), Math.floor(offset / height)) - 5);
  const end = Math.min(calls.length, Math.ceil((offset + viewport) / height) + 6);
  const rows = calls.slice(start, end);
  function columnWidth(key: string) { return preferences.columns.widths[key] ?? (key === "tool" ? 300 : key === "time" ? 150 : key === "state" ? 160 : key === "source" ? 160 : 110); }
  const template = preferences.columns.order.map((key) => key === "tool" ? "minmax(" + columnWidth(key) + "px, 1fr)" : columnWidth(key) + "px").join(" ");
  const width = preferences.columns.order.reduce((sum, key) => sum + columnWidth(key), 0);
  function resize(event: PointerEvent<HTMLDivElement>, key: string) {
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget, start = event.clientX, original = columnWidth(key);
    target.setPointerCapture(event.pointerId);
    const move = (e: globalThis.PointerEvent) => updatePreferences({ columns: { ...preferences.columns, widths: { ...preferences.columns.widths, [key]: Math.max(80, Math.min(800, original + e.clientX - start)) } } });
    const done = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", done); target.removeEventListener("pointercancel", done); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", done); target.addEventListener("pointercancel", done);
  }
  function moveColumn(key: string, delta: number) {
    const order = [...preferences.columns.order], at = order.indexOf(key), next = Math.max(0, Math.min(order.length - 1, at + delta));
    order.splice(at, 1); order.splice(next, 0, key); updatePreferences({ columns: { ...preferences.columns, order } });
  }
  function cell(call: ToolCallSummary, key: string) {
    switch (key) {
      case "tool": return <span className="tool-cell"><strong>{call.tool}</strong><code title={call.inputSummary}>{call.inputSummary}</code></span>;
      case "source": return <span title={call.sourceId}>{sources.find((s) => s.id === call.sourceId)?.name ?? call.sourceId}</span>;
      case "harness": return <span className={"harness-label " + call.harness}>{call.harness === "codex" ? "Codex" : call.harness === "opencode" ? "OpenCode" : call.harness}</span>;
      case "state": return <CallStatus call={call} descriptor={descriptor} />;
      case "duration": return duration(call.durationMs);
      case "time": return <time dateTime={call.observedAt} title={new Date(call.observedAt).toLocaleString()}>{clock(call.observedAt)}<span className="call-date">{calendarDate(call.observedAt)}</span></time>;
      default: return null;
    }
  }
  if (loading && !calls.length) return <div className="calls-loading" role="status" aria-label="Loading tool calls"><div /><div /><div /></div>;
  return <div ref={scroll} className={phone ? "virtual-scroll phone-calls" : "virtual-scroll desktop-calls"} onScroll={(e) => setOffset(e.currentTarget.scrollTop)} role={phone ? "list" : "table"} aria-label="Tool calls" aria-rowcount={phone ? undefined : calls.length + 1} aria-colcount={phone ? undefined : preferences.columns.order.length}>
    {!phone && <div className="virtual-header" role="row" style={{ gridTemplateColumns: template, width }}>{preferences.columns.order.map((key) => <div role="columnheader" key={key} title="Alt + Left/Right changes column order">{labels[key]}<div className="column-resize" role="separator" aria-label={"Resize " + labels[key] + " column"} aria-orientation="vertical" aria-valuenow={columnWidth(key)} aria-valuemin={80} aria-valuemax={800} tabIndex={0} onPointerDown={(e) => resize(e, key)} onKeyDown={(e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault(); const delta = e.key === "ArrowLeft" ? -1 : 1;
      if (e.altKey) moveColumn(key, delta); else updatePreferences({ columns: { ...preferences.columns, widths: { ...preferences.columns.widths, [key]: Math.max(80, Math.min(800, columnWidth(key) + delta * 16)) } } });
    }} /></div>)}</div>}
    <div id={phone ? "mobile-calls" : "rows"} className="virtual-rows" style={{ height: calls.length * height, minWidth: phone ? 0 : width }}>
      {rows.map((call, index) => {
        const at = start + index;
        const style: CSSProperties = { position: "absolute", top: at * height, height, ...(phone ? {} : { gridTemplateColumns: template, width, minWidth: "100%" }) };
        return <div key={callKey(call)} role={phone ? "listitem" : "row"} aria-rowindex={phone ? undefined : at + 2} style={style} className={"call-row virtual-row" + (selected === call.id && (!selectedCallSource || selectedCallSource === call.sourceId) ? " selected" : "")} data-call-id={call.id} tabIndex={0} aria-label={"Inspect " + call.tool + " at " + clock(call.observedAt)} onClick={(e) => onOpen(call.id, e.currentTarget, call.sourceId)} onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(call.id, e.currentTarget, call.sourceId); }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault(); const next = e.key === "Home" ? 0 : e.key === "End" ? calls.length - 1 : Math.max(0, Math.min(calls.length - 1, at + (e.key === "ArrowUp" ? -1 : 1)));
            const row = calls[next], container = scroll.current;
            if (!row || !container) return;
            if (next * height < container.scrollTop || (next + 1) * height > container.scrollTop + container.clientHeight - 36) container.scrollTop = next * height;
            requestAnimationFrame(() => { const element = [...container.querySelectorAll<HTMLElement>("[data-call-id]")].find((el) => el.dataset.callId === row.id); if (element) { element.focus(); onOpen(row.id, element, row.sourceId); } });
          }
        }}>{phone ? <><span className="mobile-call-heading"><strong>{call.tool}</strong>{cell(call, "harness")}</span><code>{call.inputSummary}</code><span className="mobile-call-meta">{cell(call, "state")}{cell(call, "time")}{cell(call, "duration")}</span><small>{cell(call, "source")}</small></> : preferences.columns.order.map((key) => <div role="cell" key={key}>{cell(call, key)}</div>)}</div>;
      })}
    </div>
  </div>;
}
export function CallEmptyState({ loaded, count, hasFilters }: {
  loaded: boolean; descriptor: HarnessDescriptor | undefined; count: number; total: number; hasFilters: boolean;
}) {
  return <div id="empty" className="empty" hidden={!loaded || count > 0}><h3>{hasFilters ? "No matching calls" : "Waiting for your first tool call"}</h3><p>{hasFilters ? "Change your search or reset filters to see more calls." : "Add a source and install a logger. New calls appear automatically; check source health if activity is missing."}</p></div>;
}
export function CallTableFooter({ total, hasMore, loadingMore, onMore }: {
  total: number; hasMore: boolean; loadingMore: boolean; onMore: () => void;
}) {
  return <footer className="table-footer"><span id="window-note">Newest first · updates every second</span><Button id="more" variant="ghost" size="compact" disabled={loadingMore} hidden={!hasMore} onClick={onMore}>{loadingMore ? "Loading…" : "Show more"}<ChevronDown aria-hidden="true" /></Button><span id="event-count">{number(total)} calls</span></footer>;
}
