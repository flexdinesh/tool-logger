import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api.ts";
import { filterOptions, filtersFromUrl, queryParameters } from "./filters.ts";
import { ViewerActionsContext, ViewerFocusContext, ViewerStateContext } from "./viewer-context.ts";
import type { ViewerActions } from "./viewer-context.ts";
import { initialViewerState, viewerReducer } from "./viewer-reducer.ts";

const POLL_MS = 2_000;
const PAGE_SIZE = "100";

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Unable to connect to the viewer.";
}

function apiQuery(filters: ReturnType<typeof filtersFromUrl>): URLSearchParams {
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  return queryParameters(filters, minute);
}

export function ViewerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(viewerReducer, {
    ...initialViewerState,
    filters: filtersFromUrl(new URLSearchParams(window.location.search)),
  });
  const [queryFilters, setQueryFilters] = useState(state.filters);
  const searchRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement>(null);
  const resourceKeyRef = useRef("");

  useEffect(() => {
    const timer = setTimeout(() => setQueryFilters(state.filters), state.filters.search === queryFilters.search ? 0 : 250);
    return () => clearTimeout(timer);
  }, [state.filters, queryFilters.search]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const refresh = async () => {
      request = new AbortController();
      try {
        const result = await api.harnesses(request.signal);
        if (!active) return;
        const requested = new URLSearchParams(window.location.search).get("harness");
        dispatch({ type: "harnessesReceived", value: result.value, requestedHarness: requested });
      } catch (reason) {
        if (active) dispatch({ type: "connectionFailed", message: message(reason) });
      } finally {
        if (active && state.live) timer = setTimeout(() => { void refresh(); }, POLL_MS);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      request?.abort();
    };
  }, [state.live]);

  useEffect(() => {
    if (!state.selectedHarness) return;
    const harness = state.selectedHarness;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const resourceKey = `${harness}\0${JSON.stringify(queryFilters)}`;
    if (resourceKeyRef.current !== resourceKey) {
      resourceKeyRef.current = resourceKey;
      dispatch({ type: "resourcesRequested" });
    }
    const refresh = async () => {
      request = new AbortController();
      const query = apiQuery(queryFilters);
      const pageQuery = new URLSearchParams(query);
      pageQuery.set("limit", PAGE_SIZE);
      try {
        const [calls, facets, metrics] = await Promise.all([
          api.calls(harness, pageQuery, request.signal),
          api.facets(harness, query, request.signal),
          api.metrics(harness, query, request.signal),
        ]);
        if (!active) return;
        dispatch({
          type: "resourcesReceived", calls: calls.value.data, facets: facets.value, metrics: metrics.value,
          health: calls.value.sourceHealth, nextCursor: calls.value.page.nextCursor,
          hasMore: calls.value.page.hasMore, updated: `Updated ${new Date().toLocaleTimeString()}`,
        });
      } catch (reason) {
        if (active) dispatch({ type: "connectionFailed", message: message(reason) });
      } finally {
        if (active && state.live) timer = setTimeout(() => { void refresh(); }, POLL_MS);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      request?.abort();
    };
  }, [state.selectedHarness, queryFilters, state.live]);

  useEffect(() => {
    if (!state.loadingMore || !state.selectedHarness || !state.nextCursor) return;
    let active = true;
    const request = new AbortController();
    const query = apiQuery(queryFilters);
    query.set("limit", PAGE_SIZE);
    query.set("cursor", state.nextCursor);
    void api.calls(state.selectedHarness, query, request.signal).then((result) => {
      if (!active) return;
      dispatch({
        type: "moreReceived", calls: result.value.data, health: result.value.sourceHealth,
        nextCursor: result.value.page.nextCursor, hasMore: result.value.page.hasMore,
      });
    }).catch((reason: unknown) => {
      if (active) dispatch({ type: "connectionFailed", message: message(reason) });
    });
    return () => {
      active = false;
      request.abort();
    };
  }, [state.loadingMore, state.nextCursor, state.selectedHarness, queryFilters]);

  useEffect(() => {
    if (!state.selectedCallId || !state.selectedHarness) return;
    let active = true;
    const request = new AbortController();
    void api.detail(state.selectedHarness, state.selectedCallId, request.signal)
      .then((result) => {
        if (active) dispatch({ type: "detailReceived", detail: result.value });
      })
      .catch((reason: unknown) => {
        if (active) dispatch({ type: "connectionFailed", message: message(reason) });
      });
    return () => {
      active = false;
      request.abort();
    };
  }, [state.selectedCallId, state.selectedHarness]);

  const descriptor = state.harnessList?.data.find((harness) => harness.id === state.selectedHarness);
  const options = useMemo(() => filterOptions(state.facets), [state.facets]);
  const value = useMemo(() => ({ ...state, options, descriptor }), [state, options, descriptor]);
  const focus = useMemo(() => ({ searchRef, returnFocusRef }), []);
  const actions = useMemo<ViewerActions>(() => ({
    toggleLive: () => dispatch({ type: "liveToggled" }),
    changeFilter: (key, value) => dispatch({ type: "filterChanged", key, value }),
    resetFilters: () => dispatch({ type: "filtersReset" }),
    showMore: () => dispatch({ type: "moreRequested" }),
    openCall: (id, trigger) => {
      returnFocusRef.current = trigger;
      dispatch({ type: "callSelected", id });
    },
    closeInspector: () => dispatch({ type: "inspectorClosed" }),
    selectPayloadTab: (tab) => dispatch({ type: "payloadTabChanged", tab }),
    selectHarness: (harness) => dispatch({ type: "harnessSelected", harness }),
  }), []);

  useEffect(() => {
    if (!state.harnessList || !state.selectedHarness) return;
    const url = new URL(window.location.href);
    const preserved = new Set(["harness", "q", "lifecycle", "outcome", "tool", "session", "agent", "repository", "directory", "range"]);
    for (const key of [...url.searchParams.keys()]) if (preserved.has(key)) url.searchParams.delete(key);
    url.searchParams.set("harness", state.selectedHarness);
    const query = queryParameters(state.filters);
    query.delete("since");
    if (state.filters.range !== "all") query.set("range", state.filters.range);
    for (const [key, item] of query) url.searchParams.set(key, item);
    window.history.replaceState(null, "", url);
  }, [state.selectedHarness, state.filters]);

  useEffect(() => {
    const restore = () => {
      const parameters = new URLSearchParams(window.location.search);
      const harness = parameters.get("harness");
      if (harness) dispatch({ type: "harnessSelected", harness });
      dispatch({ type: "filtersRestored", filters: filtersFromUrl(parameters) });
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  return (
    <ViewerStateContext value={value}>
      <ViewerActionsContext value={actions}>
        <ViewerFocusContext value={focus}>{children}</ViewerFocusContext>
      </ViewerActionsContext>
    </ViewerStateContext>
  );
}
