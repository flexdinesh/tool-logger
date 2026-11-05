import { createContext, useContext } from "react";
import type { RefObject } from "react";
import type { HarnessDescriptor } from "../../shared/api.ts";
import type { FilterOptions, FilterValues } from "./filters.ts";
import type { PayloadTab, ViewerState } from "./viewer-reducer.ts";
export type ViewerView = ViewerState & { options: FilterOptions; descriptor: HarnessDescriptor | undefined };
export type ViewerActions = {
  toggleLive: () => void; changeFilter: (key: keyof FilterValues, value: string) => void;
  resetFilters: () => void; showMore: () => void; openCall: (id: string, trigger: HTMLElement, sourceId?: string) => void;
  closeInspector: () => void; selectPayloadTab: (tab: PayloadTab) => void;
  selectHarness: (harness: string) => void; toggleHarness: (harness: string) => void;
  selectSource: (source: string) => void; toggleSource: (source: string) => void;
  retry: () => void; retryDetail: () => void; refreshSources: () => void;
  setDiagnostics: (open: boolean) => void; copyLink: () => void; back: () => void; forward: () => void;
};
export type ViewerFocus = { searchRef: RefObject<HTMLInputElement | null>; returnFocusRef: RefObject<HTMLElement | null> };
export const ViewerStateContext = createContext<ViewerView | undefined>(undefined);
export const ViewerActionsContext = createContext<ViewerActions | undefined>(undefined);
export const ViewerFocusContext = createContext<ViewerFocus | undefined>(undefined);
export function useViewerState() { const v = useContext(ViewerStateContext); if (!v) throw new Error("ViewerProvider missing"); return v; }
export function useViewerActions() { const v = useContext(ViewerActionsContext); if (!v) throw new Error("ViewerProvider missing"); return v; }
export function useViewerFocus() { const v = useContext(ViewerFocusContext); if (!v) throw new Error("ViewerProvider missing"); return v; }
