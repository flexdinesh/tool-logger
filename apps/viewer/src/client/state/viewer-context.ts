import { createContext, useContext } from "react";
import type { RefObject } from "react";
import type { HarnessDescriptor } from "../../shared/api.ts";
import type { FilterOptions, FilterValues } from "./filters.ts";
import type { PayloadTab, ViewerState } from "./viewer-reducer.ts";

export type ViewerView = ViewerState & {
  options: FilterOptions;
  descriptor: HarnessDescriptor | undefined;
};

export type ViewerActions = {
  toggleLive: () => void;
  changeFilter: (key: keyof FilterValues, value: string) => void;
  resetFilters: () => void;
  showMore: () => void;
  openCall: (id: string, trigger: HTMLElement) => void;
  closeInspector: () => void;
  selectPayloadTab: (tab: PayloadTab) => void;
  selectHarness: (harness: string) => void;
  retry: () => void;
  retryDetail: () => void;
};

export type ViewerFocus = {
  searchRef: RefObject<HTMLInputElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
};

export const ViewerStateContext = createContext<ViewerView | undefined>(undefined);
export const ViewerActionsContext = createContext<ViewerActions | undefined>(undefined);
export const ViewerFocusContext = createContext<ViewerFocus | undefined>(undefined);

export function useViewerState() {
  const value = useContext(ViewerStateContext);
  if (!value) throw new Error("useViewerState requires ViewerProvider");
  return value;
}

export function useViewerActions() {
  const value = useContext(ViewerActionsContext);
  if (!value) throw new Error("useViewerActions requires ViewerProvider");
  return value;
}

export function useViewerFocus() {
  const value = useContext(ViewerFocusContext);
  if (!value) throw new Error("useViewerFocus requires ViewerProvider");
  return value;
}
