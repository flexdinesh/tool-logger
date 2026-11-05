import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, callKey, loadCallPages } from "../api.ts";
import { filterOptions, filtersFromUrl, queryParameters } from "./filters.ts";
import type { FilterValues } from "./filters.ts";
import { ViewerActionsContext, ViewerFocusContext, ViewerStateContext } from "./viewer-context.ts";
import type { ViewerActions } from "./viewer-context.ts";
import type { HarnessList, Source, ToolCallDetail, ToolCallFacets, ToolCallMetrics, ToolCallSummary } from "../../shared/api.ts";
import { usePreferences } from "../preferences.tsx";
import type { Selection } from "./viewer-reducer.ts";
import { sameSelection } from "./viewer-reducer.ts";

const POLL_MS = 1000;
function message(reason: unknown) { return reason instanceof Error ? reason.message : "Unable to connect to Tool Logger."; }
type Scope = { filters: FilterValues; harnesses: string[]; sources: string[] };
function scopeFromQuery(query: URLSearchParams): Scope {
  const requested = query.getAll("harness");
  const harnesses = requested.every((id) => id === "codex" || id === "opencode") ? requested : [];
  return { filters: filtersFromUrl(query), harnesses, sources: query.getAll("source").filter((s) => s !== "all") };
}
function scopeQuery(scope: Scope, now?: number, bounded = false): URLSearchParams {
  const q = queryParameters(scope.filters, now, bounded);
  for (const h of scope.harnesses) q.append("harness", h);
  for (const s of scope.sources) q.append("source", s);
  if (!bounded && scope.filters.range !== "all") {
    if (scope.filters.range !== "custom") { q.delete("since"); q.delete("until"); }
    q.set("range", scope.filters.range);
  }
  return q;
}
export function ViewerProvider({ children }: { children: ReactNode }) {
  const { preferences, updatePreferences } = usePreferences();
  const initial = useRef(new URLSearchParams(window.location.search || preferences.query));
  const [scope, setScope] = useState(() => scopeFromQuery(initial.current));
  const [live, setLive] = useState(!preferences.paused);
  const liveRef = useRef(live); liveRef.current = live;
  const [selection, setSelection] = useState<Selection | null>(() => {
    const id = initial.current.get("call") ?? preferences.selected;
    return id ? { id, sourceId: initial.current.get("callSource") ?? preferences.selectedSource } : null;
  });
  const [harnessList, setHarnessList] = useState<HarnessList>();
  const [sources, setSources] = useState<Source[]>([]);
  const [calls, setCalls] = useState<ToolCallSummary[]>([]);
  const [facets, setFacets] = useState<ToolCallFacets>();
  const [metrics, setMetrics] = useState<ToolCallMetrics>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [harnessError, setHarnessError] = useState("");
  const [updated, setUpdated] = useState("Connecting…");
  const [selectedCall, setSelectedCall] = useState<ToolCallDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const [detailRetryVersion, setDetailRetryVersion] = useState(0);
  const [diagnostics, setDiagnostics] = useState(false);
  const [notice, setNotice] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement>(null);
  const frozenQuery = useRef<URLSearchParams | undefined>(undefined);
  const previousResource = useRef("");
  const previousPages = useRef(1);
  const pendingAppend = useRef<string | null>(null);
  const lastScope = useRef("");
  const [queryScope, setQueryScope] = useState(scope);
  const actionsRef = useRef<ViewerActions | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQueryScope(scope), scope.filters.search === queryScope.filters.search ? 0 : 180);
    return () => clearTimeout(timer);
  }, [scope, queryScope.filters.search]);

  useEffect(() => {
    let active = true;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh(force = false) {
      if (!liveRef.current && !force) { timer = setTimeout(() => { void refresh(); }, POLL_MS); return; }
      request = new AbortController();
      try {
        const [h, s] = await Promise.all([api.harnesses(request.signal), api.sources(request.signal)]);
        if (active) { setHarnessList(h.value); setSources(s.value); setHarnessError(""); }
      } catch (reason) { if (active) setHarnessError(message(reason)); }
      finally { if (active) timer = setTimeout(() => { void refresh(); }, POLL_MS); }
    }
    void refresh(true);
    return () => { active = false; request?.abort(); clearTimeout(timer); };
  }, [retryVersion, discoveryVersion]);

  useEffect(() => {
    const resource = JSON.stringify(queryScope);
    const requestKey = JSON.stringify([resource, pageCount, retryVersion]);
    const changedScope = lastScope.current !== resource;
    const appended = !changedScope && pageCount > previousPages.current;
    const appendKey = JSON.stringify([resource, pageCount]);
    if (changedScope) pendingAppend.current = null;
    if (appended && nextCursor && frozenQuery.current) pendingAppend.current = appendKey;
    const appendRequest = pendingAppend.current === appendKey && nextCursor !== null;
    previousPages.current = pageCount;
    if (!live && previousResource.current === requestKey) { setLoading(false); setLoadingMore(false); return; }
    previousResource.current = requestKey;
    lastScope.current = resource;
    if (changedScope) {
      setCalls([]); setMetrics(undefined); setFacets(undefined);
      setNextCursor(null); setHasMore(false); setLoading(true);
      frozenQuery.current = undefined;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    async function refresh(useFrozen = false) {
      request = new AbortController();
      const query = useFrozen && frozenQuery.current ? new URLSearchParams(frozenQuery.current) : scopeQuery(queryScope, Date.now(), true);
      const pageQuery = new URLSearchParams(query); pageQuery.set("limit", "100");
      try {
        if (useFrozen && nextCursor) {
          pageQuery.set("cursor", nextCursor);
          const result = await api.calls(pageQuery, request.signal);
          if (!active) return;
          setCalls((existing) => {
            const merged = new Map(existing.map((call) => [callKey(call), call]));
            for (const call of result.value.data) merged.set(callKey(call), call);
            return [...merged.values()];
          });
          setNextCursor(result.value.page.nextCursor); setHasMore(result.value.page.hasMore);
          pendingAppend.current = null;
          setLoading(false); setLoadingMore(false); setError("");
          return;
        }
        const [c, f, m] = await Promise.all([loadCallPages(pageQuery, pageCount, request.signal), api.facets(query, request.signal), api.metrics(query, request.signal)]);
        if (!active) return;
        frozenQuery.current = query;
        pendingAppend.current = null;
        setCalls(c.data); setFacets(f.value); setMetrics(m.value);
        setNextCursor(c.page.nextCursor); setHasMore(c.page.hasMore);
        setLoading(false); setLoadingMore(false); setError(""); setUpdated("Updated " + new Date().toLocaleTimeString());
      } catch (reason) {
        if (active) { setError(message(reason)); setLoading(false); setLoadingMore(false); setUpdated("Connection interrupted"); }
      } finally {
        if (active && liveRef.current) timer = setTimeout(() => { void refresh(); }, POLL_MS);
      }
    }
    void refresh(appendRequest);
    return () => { active = false; request?.abort(); clearTimeout(timer); };
  }, [queryScope, live, pageCount, retryVersion]);

  useEffect(() => {
    if (!selection) { setSelectedCall(undefined); setDetailError(""); setDetailLoading(false); return; }
    const current = selection;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    setSelectedCall((old) => old && sameSelection(current, old) ? old : undefined);
    setDetailError("");
    async function refresh(force = false) {
      if (!force && !liveRef.current) { timer = setTimeout(() => { void refresh(); }, POLL_MS); return; }
      request = new AbortController();
      setDetailLoading(true);
      try {
        const result = await api.detail(current.id, request.signal);
        if (!sameSelection(current, result.value)) throw new Error("Call source does not match this selection.");
        if (!active) return;
        setSelectedCall(result.value); setDetailError(""); setDetailLoading(false);
        timer = setTimeout(() => { void refresh(); }, POLL_MS);
      } catch (reason) {
        if (active) { setDetailError(message(reason)); setDetailLoading(false); }
      }
    }
    void refresh(true);
    return () => { active = false; request?.abort(); clearTimeout(timer); };
  }, [selection, detailRetryVersion]);

  useEffect(() => {
    const q = scopeQuery(scope);
    if (selection) { q.set("call", selection.id); if (selection.sourceId) q.set("callSource", selection.sourceId); }
    const url = new URL(location.href); url.search = q.toString();
    history.replaceState(null, "", url);
    updatePreferences({ query: scopeQuery(scope).toString(), selected: selection?.id ?? "",
      selectedSource: selection?.sourceId ?? "", paused: !live });
  }, [scope, selection, live, updatePreferences]);

  const actions: ViewerActions = {
    toggleLive: () => setLive((v) => !v),
    changeFilter: (key, value) => {
      history.pushState(null, "", location.href);
      setPageCount(1); setLoading(true); setLoadingMore(false);
      setScope((s) => ({ ...s, filters: { ...s.filters, [key]: value, ...((key === "since" || key === "until") ? { range: "custom" } : {}) } }));
    },
    resetFilters: () => { history.pushState(null, "", location.href); setPageCount(1); setScope((s) => ({ ...s, filters: filtersFromUrl(new URLSearchParams()) })); },
    showMore: () => { if (hasMore && nextCursor && !loading && !loadingMore) { setLoadingMore(true); setPageCount((v) => v + 1); } },
    openCall: (id, trigger, sourceId) => {
      returnFocusRef.current = trigger;
      const call = calls.find((c) => c.id === id && (!sourceId || c.sourceId === sourceId));
      if (!call) return;
      setSelection((s) => s?.id === id && s.sourceId === call.sourceId ? s : { id, sourceId: call.sourceId });
    },
    closeInspector: () => setSelection(null),
    selectPayloadTab: (tab) => updatePreferences({ tab }),
    selectHarness: (harness) => {
      const harnesses = harness === "all" ? [] : [harness];
      if (JSON.stringify(scope.harnesses) === JSON.stringify(harnesses)) return;
      history.pushState(null, "", location.href); setPageCount(1); setScope((s) => ({ ...s, harnesses }));
    },
    toggleHarness: (id) => { history.pushState(null, "", location.href); setPageCount(1); setScope((s) => ({ ...s, harnesses: s.harnesses.includes(id) ? s.harnesses.filter((h) => h !== id) : [...s.harnesses, id] })); },
    selectSource: (source) => {
      const sources = source === "all" ? [] : [source];
      if (JSON.stringify(scope.sources) === JSON.stringify(sources)) return;
      history.pushState(null, "", location.href); setPageCount(1); setScope((s) => ({ ...s, sources }));
    },
    toggleSource: (id) => { history.pushState(null, "", location.href); setPageCount(1); setScope((s) => ({ ...s, sources: s.sources.includes(id) ? s.sources.filter((h) => h !== id) : [...s.sources, id] })); },
    retry: () => setRetryVersion((v) => v + 1),
    retryDetail: () => setDetailRetryVersion((v) => v + 1),
    refreshSources: () => setDiscoveryVersion((v) => v + 1),
    setDiagnostics,
    copyLink: () => { void navigator.clipboard.writeText("tool-logger://activity?" + new URLSearchParams(location.search)).then(() => setNotice("Activity link copied"), () => setNotice("Link copy failed. Copy the address instead.")); },
    back: () => history.back(), forward: () => history.forward(),
  };
  actionsRef.current = actions;
  useEffect(() => {
    const restore = () => {
      const q = new URLSearchParams(location.search);
      setScope(scopeFromQuery(q)); setPageCount(1);
      const id = q.get("call");
      setSelection(id ? { id, sourceId: q.get("callSource") ?? "" } : null);
    };
    const command = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      const a = actionsRef.current;
      switch (event.detail) {
        case "search": searchRef.current?.focus(); break;
        case "back": a?.back(); break; case "forward": a?.forward(); break;
        case "pause": a?.toggleLive(); break; case "copy-link": a?.copyLink(); break;
        case "diagnostics": setDiagnostics(true); break;
        case "copy-json": document.getElementById("copy")?.click(); break;
      }
    };
    const openLink = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      try {
        const url = new URL(event.detail);
        if (url.protocol !== "tool-logger:" || url.hostname !== "activity") throw new Error("Use a tool-logger://activity link.");
        const allowed = new Set(["q", "source", "harness", "tool", "session", "agent", "repository", "directory", "lifecycle", "outcome", "range", "since", "until", "call", "callSource"]);
        const q = new URLSearchParams();
        for (const [key, item] of url.searchParams) if (allowed.has(key)) q.append(key, item);
        history.pushState(null, "", "?" + q); restore();
      } catch (reason) { setNotice(message(reason)); }
    };
    const keyboard = (event: KeyboardEvent) => {
      const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
      if ((event.key === "/" && !editing) || ((event.ctrlKey || event.metaKey) && event.key === "f")) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === " " && !editing && event.target === document.body) { event.preventDefault(); actionsRef.current?.toggleLive(); }
      if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); history.back(); }
      if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); history.forward(); }
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("tool-logger:command", command);
    window.addEventListener("tool-logger:open-link", openLink);
    window.addEventListener("keydown", keyboard);
    document.documentElement.dataset.ready = "true";
    return () => {
      delete document.documentElement.dataset.ready;
      window.removeEventListener("popstate", restore); window.removeEventListener("tool-logger:command", command);
      window.removeEventListener("tool-logger:open-link", openLink); window.removeEventListener("keydown", keyboard);
    };
  }, []);
  const descriptor = useMemo(() => {
    if (scope.harnesses.length === 1) return harnessList?.data.find((h) => h.id === scope.harnesses[0]);
    return { id: "all", label: "All harnesses", apiVersions: [], capabilities: {
      filters: [{ id: "agent" }], columns: [], detailFields: [],
      outcomeSemantics: { success: "Harness reported success", failure: "Harness reported failure", unknown: "Result presence does not imply success" },
    } };
  }, [harnessList, scope.harnesses]);
  const options = useMemo(() => filterOptions(facets), [facets]);
  const value = { harnessList, sources, calls, facets, metrics, nextCursor, hasMore, pageCount, live, loading,
    loadingMore, detailLoading, error, harnessError, detailError, updated, filters: scope.filters,
    selectedCallId: selection?.id ?? null, selectedCallSource: selection?.sourceId ?? null,
    selectedCallHarness: selectedCall?.summary.harness ?? null, selectedCall, payloadTab: preferences.tab,
    selectedHarnesses: scope.harnesses, selectedSources: scope.sources, diagnostics, notice, options, descriptor };
  const focus = useMemo(() => ({ searchRef, returnFocusRef }), []);
  return <ViewerStateContext value={value}><ViewerActionsContext value={actions}>
    <ViewerFocusContext value={focus}>{children}</ViewerFocusContext>
  </ViewerActionsContext></ViewerStateContext>;
}
