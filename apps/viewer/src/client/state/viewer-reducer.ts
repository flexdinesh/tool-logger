import type {
  HarnessList,
  SourceHealth,
  ToolCallDetail,
  ToolCallFacets,
  ToolCallMetrics,
  ToolCallSummary,
} from "../../shared/api.ts";
import { emptyFilters } from "./filters.ts";
import type { FilterValues } from "./filters.ts";

export type PayloadTab = "input" | "output" | "raw";

export type ViewerState = {
  harnessList: HarnessList | undefined;
  calls: ToolCallSummary[];
  facets: ToolCallFacets | undefined;
  metrics: ToolCallMetrics | undefined;
  sourceHealth: SourceHealth | undefined;
  nextCursor: string | null;
  hasMore: boolean;
  live: boolean;
  loading: boolean;
  loadingMore: boolean;
  detailLoading: boolean;
  error: string;
  updated: string;
  filters: FilterValues;
  selectedCallId: string | null;
  selectedCall: ToolCallDetail | undefined;
  payloadTab: PayloadTab;
  selectedHarness: string | null;
};

export type ViewerAction =
  | { type: "harnessesReceived"; value: HarnessList; requestedHarness: string | null }
  | { type: "resourcesRequested" }
  | { type: "resourcesReceived"; calls: ToolCallSummary[]; facets: ToolCallFacets; metrics: ToolCallMetrics;
    health: SourceHealth; nextCursor: string | null; hasMore: boolean; updated: string }
  | { type: "moreRequested" }
  | { type: "moreReceived"; calls: ToolCallSummary[]; health: SourceHealth; nextCursor: string | null; hasMore: boolean }
  | { type: "connectionFailed"; message: string }
  | { type: "liveToggled" }
  | { type: "filterChanged"; key: keyof FilterValues; value: string }
  | { type: "filtersRestored"; filters: FilterValues }
  | { type: "filtersReset" }
  | { type: "callSelected"; id: string }
  | { type: "detailReceived"; detail: ToolCallDetail }
  | { type: "inspectorClosed" }
  | { type: "payloadTabChanged"; tab: PayloadTab }
  | { type: "harnessSelected"; harness: string };

export const initialViewerState: ViewerState = {
  harnessList: undefined, calls: [], facets: undefined, metrics: undefined, sourceHealth: undefined,
  nextCursor: null, hasMore: false, live: true, loading: true, loadingMore: false, detailLoading: false,
  error: "", updated: "Connecting…", filters: emptyFilters, selectedCallId: null,
  selectedCall: undefined, payloadTab: "input", selectedHarness: null,
};

function unique(first: ToolCallSummary[], second: ToolCallSummary[]): ToolCallSummary[] {
  const ids = new Set(first.map((call) => call.id));
  return [...first, ...second.filter((call) => !ids.has(call.id))];
}

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case "harnessesReceived": {
      const ids = action.value.data.map((harness) => harness.id);
      const selectedHarness = state.selectedHarness && ids.includes(state.selectedHarness)
        ? state.selectedHarness
        : action.requestedHarness && ids.includes(action.requestedHarness) ? action.requestedHarness : ids[0] ?? null;
      return selectedHarness
        ? { ...state, harnessList: action.value, selectedHarness, error: state.selectedHarness ? state.error : "" }
        : { ...state, harnessList: action.value, selectedHarness, calls: [], facets: undefined, metrics: undefined,
          sourceHealth: undefined, nextCursor: null, hasMore: false, loading: false,
          selectedCallId: null, selectedCall: undefined, error: "" };
    }
    case "resourcesRequested":
      return { ...state, loading: true, calls: [], facets: undefined, metrics: undefined,
        sourceHealth: undefined, nextCursor: null, hasMore: false };
    case "resourcesReceived":
      return { ...state, calls: state.loading ? action.calls : unique(action.calls, state.calls),
        facets: action.facets, metrics: action.metrics, sourceHealth: action.health,
        nextCursor: state.loading ? action.nextCursor : state.nextCursor ?? action.nextCursor,
        hasMore: state.loading ? action.hasMore : state.hasMore || action.hasMore,
        loading: false, error: "", updated: action.updated };
    case "moreRequested":
      return { ...state, loadingMore: true };
    case "moreReceived":
      return { ...state, calls: unique(state.calls, action.calls), sourceHealth: action.health,
        nextCursor: action.nextCursor, hasMore: action.hasMore, loadingMore: false, error: "" };
    case "connectionFailed":
      return { ...state, error: action.message, loading: false, loadingMore: false,
        detailLoading: false, updated: "Connection interrupted" };
    case "liveToggled":
      return { ...state, live: !state.live };
    case "filterChanged":
      return { ...state, filters: { ...state.filters, [action.key]: action.value } };
    case "filtersRestored":
      return { ...state, filters: action.filters };
    case "filtersReset":
      return { ...state, filters: emptyFilters };
    case "callSelected":
      return state.calls.some((call) => call.id === action.id)
        ? { ...state, selectedCallId: action.id, selectedCall: undefined, detailLoading: true, payloadTab: "input" } : state;
    case "detailReceived":
      return action.detail.summary.id === state.selectedCallId
        ? { ...state, selectedCall: action.detail, detailLoading: false, error: "" } : state;
    case "inspectorClosed":
      return { ...state, selectedCallId: null, selectedCall: undefined, detailLoading: false, payloadTab: "input" };
    case "payloadTabChanged":
      return state.selectedCallId ? { ...state, payloadTab: action.tab } : state;
    case "harnessSelected":
      return state.harnessList?.data.some((harness) => harness.id === action.harness)
        ? { ...state, selectedHarness: action.harness, filters: emptyFilters, calls: [],
          selectedCallId: null, selectedCall: undefined, payloadTab: "input" } : state;
  }
}
