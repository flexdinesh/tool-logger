import test from "node:test";
import assert from "node:assert/strict";
import { defaults, normalizePreferences } from "../src/client/preferences-model.ts";
import { filtersFromUrl, queryParameters } from "../src/client/state/filters.ts";
import { parseSource, parseSummary, parseToolCallMetrics } from "../src/shared/api.ts";
import { callKey, loadCallPages } from "../src/client/api.ts";
test("native preferences migrate scopes, theme, time, inspector and column layout", () => {
  const p = normalizePreferences({ query: { source: ["a", "b"], harness: ["codex", "opencode"], q: ["pwd"], token: ["secret"] },
    theme: "Dark", sidebar: 240, collection: 72, tab: "Raw events", selected: "call", paused: true, timeRange: "15 minutes",
    columns: { Order: ["state", "tool"], Widths: { tool: 401 } }, filters: true, chartsHidden: true });
  assert.equal(p.theme, "dark"); assert.equal(p.tab, "raw"); assert.equal(p.paused, true);
  assert.deepEqual(new URLSearchParams(p.query).getAll("source"), ["a", "b"]);
  assert.equal(new URLSearchParams(p.query).has("token"), false);
  assert.equal(new URLSearchParams(p.query).get("range"), "0.25");
  assert.deepEqual(p.columns.order.slice(0, 2), ["state", "tool"]); assert.equal(p.columns.widths.tool, 401);
  assert.equal(p.filters, true); assert.equal(p.chartsHidden, true);
});
test("unknown bridge settings cannot inject credentials or invalid layouts", () => {
  assert.deepEqual(normalizePreferences(null), defaults);
  const p = normalizePreferences({ query: "token=secret&source=a&harness=codex", theme: "purple", sidebar: 1e6, collection: -99, columns: { order: ["evil", "time", "time"], widths: { evil: 3, time: -1 } } });
  assert.equal(p.theme, "system"); assert.equal(p.sidebar, 360); assert.equal(p.collection, 30);
  assert.equal(p.columns.widths.time, 80); assert.equal(p.query.includes("secret"), false);
  assert.equal(new Set(p.columns.order).size, p.columns.order.length);
});
test("native title-based column widths merge Input into Tool", () => {
  const p = normalizePreferences({ columns: { Order: ["State", "Input", "Tool", "Recorded", "Duration", "Harness"], Widths: { Tool: 128, Input: 180, Recorded: 156 } } });
  assert.deepEqual(p.columns.order.slice(0, 5), ["state", "tool", "time", "duration", "harness"]);
  assert.equal(p.columns.widths.tool, 308); assert.equal(p.columns.widths.time, 156);
});
test("legacy activity links accept native time labels", () => {
  for (const [label, range] of [["15 minutes", "0.25"], ["1 hour", "1"], ["24 hours", "24"], ["7 days", "168"], ["Custom", "custom"], ["All time", "all"]]) {
    assert.equal(filtersFromUrl(new URLSearchParams({ range: label ?? "" })).range, range);
  }
});
test("time query preserves explicit UTC bounds and repeated independent dimensions", () => {
  const f = filtersFromUrl(new URLSearchParams("range=24&tool=shell&tool=read&lifecycle=awaiting&outcome=unknown"));
  const stamp = Date.parse("2026-05-11T12:34:56Z"), q = queryParameters(f, stamp);
  assert.deepEqual(q.getAll("tool"), ["shell", "read"]); assert.equal(q.get("lifecycle"), "awaiting"); assert.equal(q.get("outcome"), "unknown");
  assert.equal(q.get("since"), "2026-05-10T12:34:56.000Z"); assert.equal(q.get("until"), "2026-05-11T12:34:56.000Z");
  const custom = filtersFromUrl(new URLSearchParams("since=2026-05-01T00:00:00Z&until=2026-05-02T00:00:00Z"));
  assert.equal(custom.range, "custom"); assert.equal(queryParameters(custom).get("until"), "2026-05-02T00:00:00.000Z");
  assert.equal(queryParameters(filtersFromUrl(new URLSearchParams())).has("until"), false);
});
const summary = { id: "same", sourceId: "a", harness: "codex", harnessApiVersion: null, tool: "shell", observedAt: "2026-05-11T12:00:00Z", startedAt: null, finishedAt: null,
  lifecycle: "awaiting", outcome: "unknown", durationMs: null, sessionId: null, agentId: null, directory: null, repository: null, inputSummary: "pwd", attributes: {} };
test("runtime contract rejects invented success and malformed numeric evidence", () => {
  assert.equal(parseSummary(summary).outcome, "unknown");
  assert.throws(() => parseSummary({ ...summary, outcome: "completed" }));
  assert.throws(() => parseSummary({ ...summary, durationMs: Number.NaN }));
  assert.throws(() => parseSource({ id: "bad" }));
  assert.throws(() => parseToolCallMetrics({ data: {} }));
});
test("source labels preserve literal prototype-like keys", () => {
  const labels: unknown = JSON.parse('{"__proto__":"literal","constructor":"named"}');
  const source = parseSource({ id: "source", name: "Host", hostname: "host", platform: "linux", labels,
    status: "online", lastSeenAt: null, lastEventAt: null, pendingEvents: 0, rejectedEvents: 0, lastError: "" });
  assert.equal(Object.hasOwn(source.labels, "__proto__"), true);
  assert.equal(source.labels["__proto__"], "literal");
  assert.equal(JSON.stringify(source.labels), '{"__proto__":"literal","constructor":"named"}');
});
test("paging deduplicates by source identity and holds the exact request window", async () => {
  const original = globalThis.fetch;
  const queries: URLSearchParams[] = [];
  globalThis.fetch = async (input) => {
    const q = new URL(String(input), "http://localhost").searchParams; queries.push(q);
    return new Response(JSON.stringify(q.has("cursor")
      ? { data: [summary, { ...summary, sourceId: "b" }], page: { nextCursor: null, hasMore: false } }
      : { data: [summary], page: { nextCursor: "next", hasMore: true } }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const q = new URLSearchParams("since=2026-05-11T00:00:00Z&until=2026-05-12T00:00:00Z&limit=100&source=a&source=b");
    const result = await loadCallPages(q, 2, new AbortController().signal);
    assert.equal(result.data.length, 2); assert.notEqual(callKey(result.data[0] ?? parseSummary(summary)), callKey(result.data[1] ?? parseSummary(summary)));
    assert.equal(queries[0]?.get("until"), queries[1]?.get("until"));
    assert.deepEqual(queries[1]?.getAll("source"), ["a", "b"]);
  } finally { globalThis.fetch = original; }
});
