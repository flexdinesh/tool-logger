import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HarnessList,
  SourceHealth,
  ToolCallDetail,
  ToolCallFacets,
  ToolCallMetrics,
  ToolCallSummary,
} from "../src/shared/api.ts";
import { initialViewerState, viewerReducer } from "../src/client/state/viewer-reducer.ts";
import type { ViewerAction } from "../src/client/state/viewer-reducer.ts";

function summary(id: string, harness = "codex"): ToolCallSummary {
  return {
    id, harness, harnessApiVersion: harness === "codex" ? null : 2, tool: "Bash",
    observedAt: "2026-09-09T10:00:00Z", startedAt: "2026-09-09T10:00:00Z", finishedAt: null,
    lifecycle: "awaiting", outcome: "unknown", durationMs: null, sessionId: "session", agentId: null,
    directory: "/work", repository: "/work", inputSummary: "pwd", attributes: {},
  };
}

function detail(call: ToolCallSummary): ToolCallDetail {
  return { summary: call, input: { command: "pwd" }, output: null, native: { attributes: {}, events: [] } };
}

function health(harness = "codex"): SourceHealth {
  return { harness, status: "healthy", sourceLabel: `${harness}-tool-calls.jsonl`, apiVersions: [],
    skippedRecords: 0, lastObservedAt: "2026-09-09T10:00:00Z" };
}

function harnesses(): HarnessList {
  const capabilities = { filters: [], columns: [], detailFields: [],
    outcomeSemantics: { success: "Succeeded", failure: "Failed", unknown: "Unknown" } };
  return { data: [
    { id: "codex", label: "Codex", apiVersions: [], capabilities },
    { id: "opencode", label: "OpenCode", apiVersions: [2], capabilities },
  ], sourceHealth: [health(), health("opencode")], demo: false };
}

function resources(calls: ToolCallSummary[], hasMore = false): ViewerAction {
  const facets: ToolCallFacets = { data: { tools: [], sessions: [], agents: [], repositories: [], directories: [],
    lifecycles: [], outcomes: [] }, sourceHealth: health() };
  const metrics: ToolCallMetrics = { data: { totalCalls: calls.length, completedCalls: 0, awaitingCalls: calls.length,
    successCalls: 0, failureCalls: 0, unknownCalls: calls.length, averageDurationMs: null, failureRate: null,
    window: { since: null, until: null }, activity: [], toolUsage: [] }, sourceHealth: health() };
  return { type: "resourcesReceived", calls, facets, metrics, health: health(),
    nextCursor: hasMore ? "next" : null, hasMore, updated: "now" };
}

test("selects requested available harness and loads REST resources", () => {
  let state = viewerReducer(initialViewerState, { type: "harnessesReceived", value: harnesses(), requestedHarness: "opencode" });
  assert.equal(state.selectedHarness, "opencode");
  state = viewerReducer(state, { type: "resourcesRequested" });
  assert.equal(state.loading, true);
  state = viewerReducer(state, resources([summary("one", "opencode")]));
  assert.equal(state.calls[0]?.id, "one");
  assert.equal(state.loading, false);
  assert.equal(state.error, "");
});

test("detail response preserves selection and payload tab across refresh", () => {
  const call = summary("one");
  let state = viewerReducer(initialViewerState, { type: "harnessesReceived", value: harnesses(), requestedHarness: null });
  state = viewerReducer(state, resources([call]));
  state = viewerReducer(state, { type: "callSelected", id: call.id });
  state = viewerReducer(state, { type: "detailReceived", detail: detail(call) });
  state = viewerReducer(state, { type: "payloadTabChanged", tab: "output" });
  state = viewerReducer(state, resources([{ ...call, lifecycle: "finished", outcome: "success" }]));
  assert.equal(state.selectedCallId, "one");
  assert.equal(state.selectedCall?.summary.id, "one");
  assert.equal(state.payloadTab, "output");
});

test("pagination requests another page and adopts the refreshed collection", () => {
  let state = viewerReducer(initialViewerState, resources([summary("one")], true));
  state = viewerReducer(state, { type: "moreRequested" });
  assert.equal(state.pageCount, 2);
  assert.equal(state.loadingMore, true);
  assert.equal(viewerReducer(state, { type: "moreRequested" }), state);
  state = viewerReducer(state, resources([summary("two"), summary("one")], true));
  assert.deepEqual(state.calls.map((call) => call.id), ["two", "one"]);
  assert.equal(state.nextCursor, "next");
  assert.equal(state.loadingMore, false);
});

test("connection failure preserves data and user state", () => {
  const call = summary("one");
  let state = viewerReducer(initialViewerState, resources([call]));
  state = viewerReducer(state, { type: "filterChanged", key: "tool", value: "Bash" });
  state = viewerReducer(state, { type: "callSelected", id: call.id });
  state = viewerReducer(state, { type: "detailReceived", detail: detail(call) });
  state = viewerReducer(state, { type: "payloadTabChanged", tab: "raw" });
  state = viewerReducer(state, { type: "resourcesFailed", message: "offline" });
  assert.deepEqual(state.calls.map((entry) => entry.id), ["one"]);
  assert.equal(state.filters.tool, "Bash");
  assert.equal(state.selectedCall?.summary.id, "one");
  assert.equal(state.payloadTab, "raw");
  assert.equal(state.error, "offline");
});

test("refresh removes calls that stop matching and preserves exhausted pagination", () => {
  let state = viewerReducer(initialViewerState, resources([summary("one"), summary("two")]));
  state = viewerReducer(state, resources([summary("two")]));
  assert.deepEqual(state.calls.map((call) => call.id), ["two"]);
  assert.equal(state.hasMore, false);
  assert.equal(state.nextCursor, null);
  assert.equal(viewerReducer(state, { type: "moreRequested" }), state);
  state = viewerReducer(state, resources([]));
  assert.deepEqual(state.calls, []);
  assert.equal(state.metrics?.data.totalCalls, 0);
});

test("request failures and recovery affect only their owner", () => {
  const call = summary("one");
  let state = viewerReducer(initialViewerState, resources([call], true));
  state = viewerReducer(state, { type: "callSelected", id: call.id });
  state = viewerReducer(state, { type: "moreRequested" });
  state = viewerReducer(state, { type: "harnessesFailed", message: "discovery offline" });
  assert.equal(state.loadingMore, true);
  assert.equal(state.detailLoading, true);
  state = viewerReducer(state, { type: "resourcesFailed", message: "activity offline" });
  assert.equal(state.loadingMore, false);
  assert.equal(state.detailLoading, true);
  state = viewerReducer(state, { type: "detailFailed", message: "details offline" });
  state = viewerReducer(state, resources([call]));
  assert.equal(state.error, "");
  assert.equal(state.harnessError, "discovery offline");
  assert.equal(state.detailError, "details offline");
  state = viewerReducer(state, { type: "resourcesFailed", message: "activity offline" });
  state = viewerReducer(state, { type: "detailReceived", detail: detail(call) });
  assert.equal(state.detailError, "");
  assert.equal(state.error, "activity offline");
  assert.equal(state.harnessError, "discovery offline");
});

test("selection retains its harness when a filtered call disappears", () => {
  const call = summary("one", "opencode");
  let state = viewerReducer(initialViewerState, resources([call]));
  state = viewerReducer(state, { type: "callSelected", id: call.id });
  state = viewerReducer(state, resources([]));
  assert.equal(state.selectedCallHarness, "opencode");
  state = viewerReducer(state, { type: "detailReceived", detail: detail({ ...call, lifecycle: "finished" }) });
  assert.equal(state.selectedCall?.summary.lifecycle, "finished");
  assert.equal(viewerReducer(state, { type: "callSelected", id: call.id }), state);
});

test("selecting the current harness while paused preserves calls and filters", () => {
  let state = viewerReducer(initialViewerState, { type: "harnessesReceived", value: harnesses(), requestedHarness: null });
  state = viewerReducer(state, resources([summary("one")]));
  state = viewerReducer(state, { type: "filterChanged", key: "tool", value: "Bash" });
  state = viewerReducer(state, { type: "liveToggled" });
  assert.equal(viewerReducer(state, { type: "harnessSelected", harness: "all" }), state);
});

test("harness selection resets harness-specific state", () => {
  const call = summary("one");
  let state = viewerReducer(initialViewerState, { type: "harnessesReceived", value: harnesses(), requestedHarness: null });
  state = viewerReducer(state, resources([call]));
  state = viewerReducer(state, { type: "callSelected", id: call.id });
  state = viewerReducer(state, { type: "filterChanged", key: "tool", value: "Bash" });
  state = viewerReducer(state, { type: "harnessSelected", harness: "opencode" });
  assert.equal(state.selectedHarness, "opencode");
  assert.equal(state.selectedCallId, null);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.filters, initialViewerState.filters);
});

test("defaults to combined scope, validates selection, and handles empty sources", () => {
  const loaded = viewerReducer(initialViewerState, { type: "harnessesReceived", value: harnesses(), requestedHarness: null });
  assert.equal(loaded.selectedHarness, "all");
  assert.equal(viewerReducer(loaded, { type: "harnessSelected", harness: "missing" }), loaded);
  assert.equal(viewerReducer(loaded, { type: "harnessSelected", harness: "codex" }).selectedHarness, "codex");
  assert.equal(viewerReducer(loaded, { type: "harnessSelected", harness: "all" }).selectedHarness, "all");
  const empty = viewerReducer(loaded, { type: "harnessesReceived", value: { data: [], sourceHealth: [], demo: false }, requestedHarness: null });
  assert.equal(empty.selectedHarness, null);
  assert.equal(empty.loading, false);
});
