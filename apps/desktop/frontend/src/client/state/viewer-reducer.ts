import type { HarnessList, Source, ToolCallDetail, ToolCallFacets, ToolCallMetrics, ToolCallSummary } from "../../shared/api.ts";
import type { FilterValues } from "./filters.ts";
export type { PayloadTab } from "../preferences-model.ts";
export type Selection = { id: string; sourceId: string };
export type ViewerState = {
  harnessList: HarnessList | undefined; sources: Source[]; calls: ToolCallSummary[];
  facets: ToolCallFacets | undefined; metrics: ToolCallMetrics | undefined; nextCursor: string | null;
  hasMore: boolean; pageCount: number; live: boolean; loading: boolean; loadingMore: boolean;
  detailLoading: boolean; error: string; harnessError: string; detailError: string; updated: string;
  filters: FilterValues; selectedCallId: string | null; selectedCallSource: string | null;
  selectedCallHarness: string | null; selectedCall: ToolCallDetail | undefined;
  payloadTab: import("../preferences.tsx").PayloadTab; selectedHarnesses: string[]; selectedSources: string[];
  diagnostics: boolean; notice: string;
};
export function sameSelection(selection: Selection, detail: ToolCallDetail): boolean {
  return selection.id === detail.summary.id && (!selection.sourceId || selection.sourceId === detail.summary.sourceId);
}
