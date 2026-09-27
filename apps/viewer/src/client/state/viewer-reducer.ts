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
  pageCount: number;
  live: boolean;
  loading: boolean;
  loadingMore: boolean;
  detailLoading: boolean;
  error: string;
  harnessError: string;
  detailError: string;
  retryVersion: number;
  detailRetryVersion: number;
  updated: string;
  filters: FilterValues;
  selectedCallId: string | null;
  selectedCallHarness: string | null;
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
  | { type: "harnessesFailed"; message: string }
  | { type: "resourcesFailed"; message: string }
  | { type: "detailRequested" }
  | { type: "detailFailed"; message: string }
  | { type: "retryRequested" }
  | { type: "detailRetryRequested" }
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
  nextCursor: null, hasMore: false, pageCount: 1, live: true, loading: true, loadingMore: false, detailLoading: false,
  error: "", harnessError: "", detailError: "", retryVersion: 0, detailRetryVersion: 0,
  updated: "Connecting…", filters: emptyFilters, selectedCallId: null, selectedCallHarness: null,
  selectedCall: undefined, payloadTab: "input", selectedHarness: null,
};

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case "harnessesReceived": {
      const ids = action.value.data.length ? ["all", ...action.value.data.map((harness) => harness.id)] : [];
      const selectedHarness = state.selectedHarness && ids.includes(state.selectedHarness)
        ? state.selectedHarness
        : action.requestedHarness && ids.includes(action.requestedHarness) ? action.requestedHarness : ids[0] ?? null;
      return selectedHarness
        ? { ...state, harnessList: action.value, selectedHarness, harnessError: "",
          ...(selectedHarness === state.selectedHarness ? {} : {
            pageCount: 1, loadingMore: false, selectedCallId: null, selectedCallHarness: null,
            selectedCall: undefined, detailLoading: false, detailError: "",
          }) }
        : { ...state, harnessList: action.value, selectedHarness, calls: [], facets: undefined, metrics: undefined,
          sourceHealth: undefined, nextCursor: null, hasMore: false, pageCount: 1, loading: false, loadingMore: false,
          selectedCallId: null, selectedCallHarness: null, selectedCall: undefined, detailLoading: false,
          error: "", harnessError: "", detailError: "" };
    }
    case "resourcesRequested":
      return { ...state, loading: true, loadingMore: false, calls: [], facets: undefined, metrics: undefined,
        sourceHealth: undefined, nextCursor: null, hasMore: false };
    case "resourcesReceived":
      return { ...state, calls: action.calls,
        facets: action.facets, metrics: action.metrics, sourceHealth: action.health,
        nextCursor: action.nextCursor, hasMore: action.hasMore,
        loading: false, loadingMore: false, error: "", updated: action.updated };
    case "moreRequested":
      return state.hasMore && !state.loading && !state.loadingMore
        ? { ...state, loadingMore: true, pageCount: state.pageCount + 1 } : state;
    case "harnessesFailed":
      return { ...state, harnessError: action.message, loading: state.selectedHarness ? state.loading : false };
    case "resourcesFailed":
      return { ...state, error: action.message, loading: false, loadingMore: false,
        updated: "Connection interrupted" };
    case "detailRequested":
      return { ...state, detailLoading: true };
    case "detailFailed":
      return { ...state, detailError: action.message, detailLoading: false };
    case "retryRequested":
      return { ...state, retryVersion: state.retryVersion + 1 };
    case "detailRetryRequested":
      return { ...state, detailRetryVersion: state.detailRetryVersion + 1 };
    case "liveToggled":
      return { ...state, live: !state.live };
    case "filterChanged":
      return { ...state, filters: { ...state.filters, [action.key]: action.value }, pageCount: 1, loadingMore: false };
    case "filtersRestored":
      return { ...state, filters: action.filters, pageCount: 1, loadingMore: false };
    case "filtersReset":
      return { ...state, filters: emptyFilters, pageCount: 1, loadingMore: false };
    case "callSelected": {
      if (action.id === state.selectedCallId) return state;
      const call = state.calls.find((call) => call.id === action.id);
      return call ? { ...state, selectedCallId: action.id, selectedCallHarness: call.harness,
        selectedCall: undefined, detailLoading: true, detailError: "", payloadTab: "input" } : state;
    }
    case "detailReceived":
      return action.detail.summary.id === state.selectedCallId && action.detail.summary.harness === state.selectedCallHarness
        ? { ...state, selectedCall: action.detail, detailLoading: false, detailError: "" } : state;
    case "inspectorClosed":
      return { ...state, selectedCallId: null, selectedCallHarness: null, selectedCall: undefined,
        detailLoading: false, detailError: "", payloadTab: "input" };
    case "payloadTabChanged":
      return state.selectedCallId ? { ...state, payloadTab: action.tab } : state;
    case "harnessSelected":
      if (action.harness === state.selectedHarness) return state;
      return state.harnessList && (action.harness === "all" || state.harnessList.data.some((harness) => harness.id === action.harness))
        ? { ...state, selectedHarness: action.harness, filters: emptyFilters, calls: [],
          facets: undefined, metrics: undefined, sourceHealth: undefined, nextCursor: null, hasMore: false,
          pageCount: 1, loading: true, loadingMore: false, error: "", selectedCallId: null,
          selectedCallHarness: null, selectedCall: undefined, detailLoading: false, detailError: "", payloadTab: "input" } : state;
  }
}
