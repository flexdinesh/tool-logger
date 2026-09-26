import { useEffect } from "react";
import { CallEmptyState, CallTable, CallTableFooter } from "../components/call-table.tsx";
import { Filters } from "../components/filters.tsx";
import { number } from "../format.ts";
import { Badge } from "../components/ui/badge.tsx";
import { useViewerActions, useViewerFocus, useViewerState } from "../state/viewer-context.ts";

export function CallExplorer() {
  const {
    calls, harnessList, descriptor, filters, options, selectedCallId, updated, metrics,
    sourceHealth, hasMore, loading, loadingMore,
  } = useViewerState();
  const { changeFilter, resetFilters, openCall, showMore } = useViewerActions();
  const { searchRef } = useViewerFocus();

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
      if (event.key === "/" && !selectedCallId && !editing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [selectedCallId, searchRef]);

  return (
    <section className="calls-panel" aria-labelledby="calls-heading">
      <div className="calls-heading">
        <div>
          <h2 id="calls-heading" className="flex items-center gap-2 text-lg font-semibold">Recent calls <Badge id="shown-count">{number(calls.length)}</Badge></h2>
        </div>
        <span id="updated" className="updated hidden text-xs text-muted sm:block" aria-live="polite">{updated}</span>
      </div>
      <Filters filters={filters} options={options} descriptor={descriptor}
        searchRef={searchRef} onChange={changeFilter} onClear={resetFilters} />
      <CallTable calls={calls} descriptor={descriptor} selected={selectedCallId} onOpen={openCall} loading={loading} />
      <CallEmptyState loaded={Boolean(harnessList) && !loading} descriptor={descriptor} count={calls.length} total={metrics?.data.totalCalls ?? 0} hasFilters={Object.entries(filters).some(([key, value]) => key === "search" ? Boolean(value.trim()) : value !== "all")} />
      <CallTableFooter health={sourceHealth} total={metrics?.data.totalCalls ?? 0}
        hasMore={hasMore} loadingMore={loadingMore} onMore={showMore} />
    </section>
  );
}
