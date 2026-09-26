import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createViewer } from "../src/server.ts";
import { LogStore } from "../src/server/repository/log-store.ts";
import {
  parseHarnessList,
  parseToolCallDetail,
  parseToolCallFacets,
  parseToolCallMetrics,
  parseToolCallPage,
} from "../src/shared/api.ts";

function record(phase: "PreToolUse" | "PostToolUse", call: string, time: string, tool = "Bash") {
  return JSON.stringify({
    schema_version: 2,
    event_id: `${call}-${phase}`,
    logged_at: time,
    harness: "codex",
    hook: phase,
    event: {
      hook_event_name: phase,
      session_id: "session-one",
      turn_id: "turn-one",
      tool_use_id: call,
      tool_name: tool,
      cwd: "/work/project",
      tool_input: { command: `command-${call}` },
      ...(phase === "PostToolUse" ? { tool_response: { output: `result-${call}` } } : {}),
    },
    metadata: { git: { root: "/work/project", branch: "main", dirty: false } },
  }) + "\n";
}

async function fixture(t: TestContext, testData = false, malformed = false) {
  const directory = mkdtempSync(join(tmpdir(), "viewer-api-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "codex-tool-calls.jsonl");
  writeFileSync(source,
    record("PreToolUse", "one", "2026-09-13T01:00:00.000Z")
    + record("PostToolUse", "one", "2026-09-13T01:00:00.100Z")
    + record("PreToolUse", "two", "2026-09-13T02:00:00.000Z", "read_file")
    + record("PreToolUse", "three", "2026-09-13T03:00:00.000Z")
    + record("PostToolUse", "three", "2026-09-13T03:00:00.300Z"));
  if (malformed) appendFileSync(source, "invalid-json\n");
  const server = await createViewer({ source, testData });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function value(response: Response): Promise<unknown> {
  return response.json();
}

test("REST resources expose summaries, lazy details, facets, and metrics", async (t) => {
  const base = await fixture(t);
  const harnesses = parseHarnessList(await value(await fetch(`${base}/api/v1/harnesses`)));
  assert.deepEqual(harnesses.data.map((entry) => entry.id), ["codex"]);
  assert.equal(harnesses.sourceHealth[0]?.sourceLabel, "codex-tool-calls.jsonl");
  assert.equal(harnesses.data[0]?.capabilities.outcomeSemantics.unknown, "Result presence does not imply success");

  const firstResponse = await fetch(`${base}/api/v1/harnesses/codex/tool-calls?limit=1`);
  const first = parseToolCallPage(await value(firstResponse));
  assert.equal(first.data.length, 1);
  assert.equal(first.data[0]?.inputSummary, "command-three");
  assert.equal(first.page.hasMore, true);
  assert.ok(first.page.nextCursor);
  const next = parseToolCallPage(await value(await fetch(
    `${base}/api/v1/harnesses/codex/tool-calls?limit=1&cursor=${encodeURIComponent(first.page.nextCursor)}`,
  )));
  assert.equal(next.data[0]?.inputSummary, "command-two");

  const awaiting = parseToolCallPage(await value(await fetch(
    `${base}/api/v1/harnesses/codex/tool-calls?lifecycle=awaiting`,
  )));
  assert.equal(awaiting.data.length, 1);
  const call = first.data[0];
  assert.ok(call);
  const detail = parseToolCallDetail(await value(await fetch(
    `${base}/api/v1/harnesses/codex/tool-calls/${encodeURIComponent(call.id)}`,
  )));
  assert.deepEqual(detail.input, { command: "command-three" });
  assert.equal(detail.native.events.length, 2);

  const facets = parseToolCallFacets(await value(await fetch(`${base}/api/v1/harnesses/codex/tool-call-facets`)));
  assert.deepEqual(facets.data.tools.map((entry) => [entry.value, entry.count]), [["Bash", 2], ["read_file", 1]]);
  const metrics = parseToolCallMetrics(await value(await fetch(`${base}/api/v1/harnesses/codex/tool-call-metrics`)));
  assert.equal(metrics.data.totalCalls, 3);
  assert.equal(metrics.data.completedCalls, 2);
  assert.equal(metrics.data.awaitingCalls, 1);
  assert.equal(metrics.data.averageDurationMs, 200);
});

test("REST validates queries, methods, cursors, and conditional requests", async (t) => {
  const base = await fixture(t);
  const resource = `${base}/api/v1/harnesses/codex/tool-calls?limit=1`;
  const first = await fetch(resource);
  const tag = first.headers.get("etag");
  assert.ok(tag);
  assert.equal((await fetch(resource, { headers: { "If-None-Match": tag } })).status, 304);
  assert.equal((await fetch(`${base}/api/v1/harnesses/codex/tool-calls?unknown=true`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/harnesses/codex/tool-calls?cursor=broken`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/harnesses/missing/tool-calls`)).status, 404);
  const method = await fetch(resource, { method: "POST" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD");
  assert.match(method.headers.get("content-type") ?? "", /application\/problem\+json/);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("append-aware store reads only complete new records and updates existing calls", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "viewer-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "codex-tool-calls.jsonl");
  writeFileSync(source, record("PreToolUse", "one", "2026-09-13T01:00:00.000Z"));
  const store = new LogStore({ source });
  const first = await store.snapshot();
  assert.equal(first.harnesses[0]?.calls[0]?.status, "awaiting");
  const after = record("PostToolUse", "one", "2026-09-13T01:00:00.100Z");
  appendFileSync(source, after.slice(0, -1));
  const partial = await store.snapshot();
  assert.equal(partial.harnesses[0]?.totalEvents, 1);
  appendFileSync(source, "\n");
  const completed = await store.snapshot();
  assert.equal(completed.harnesses[0]?.totalEvents, 2);
  assert.equal(completed.harnesses[0]?.calls[0]?.status, "completed");

  rmSync(source);
  assert.equal((await store.snapshot()).harnesses[0]?.missing, true);
  writeFileSync(source, record("PreToolUse", "two", "2026-09-13T02:00:00.000Z"));
  const recreated = await store.snapshot();
  assert.equal(recreated.harnesses[0]?.totalEvents, 1);
  assert.equal(recreated.harnesses[0]?.calls.length, 1);
  assert.equal(recreated.harnesses[0]?.calls[0]?.callId, "two");
});

test("combined scope preserves global chronology, native outcomes, facets, and paging", async (t) => {
  const base = await fixture(t, true);
  const collection = base + "/api/v1/harnesses/all/tool-calls";
  const all = parseToolCallPage(await value(await fetch(collection)));
  assert.equal(all.data.length, 11);
  assert.deepEqual([...new Set(all.data.map((call) => call.harness))].sort(), ["codex", "opencode"]);
  for (let index = 1; index < all.data.length; index += 1) {
    assert.ok(Date.parse(all.data[index - 1]?.observedAt ?? "") >= Date.parse(all.data[index]?.observedAt ?? ""));
  }
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "2" });
    if (cursor) query.set("cursor", cursor);
    const page = parseToolCallPage(await value(await fetch(collection + "?" + query)));
    ids.push(...page.data.map((call) => call.id));
    cursor = page.page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, all.data.map((call) => call.id));
  const first = parseToolCallPage(await value(await fetch(collection + "?limit=2")));
  assert.ok(first.page.nextCursor);
  assert.equal((await fetch(base + "/api/v1/harnesses/codex/tool-calls?limit=2&cursor=" + encodeURIComponent(first.page.nextCursor))).status, 400);

  const metrics = parseToolCallMetrics(await value(await fetch(base + "/api/v1/harnesses/all/tool-call-metrics")));
  assert.equal(metrics.data.totalCalls, 11);
  assert.equal(metrics.data.completedCalls, 9);
  assert.equal(metrics.data.awaitingCalls, 2);
  assert.equal(metrics.data.successCalls, 1);
  assert.equal(metrics.data.failureCalls, 1);
  assert.equal(metrics.data.unknownCalls, 9);
  assert.equal(metrics.data.activity.reduce((total, bin) => total + bin.count, 0), 11);
  assert.equal(metrics.data.activity.reduce((total, bin) => total + (bin.harnesses?.codex ?? 0), 0), 8);
  assert.equal(metrics.data.activity.reduce((total, bin) => total + (bin.harnesses?.opencode ?? 0), 0), 3);
  for (const bin of metrics.data.activity) assert.equal(Object.values(bin.harnesses ?? {}).reduce((sum, count) => sum + count, 0), bin.count);

  const facets = parseToolCallFacets(await value(await fetch(base + "/api/v1/harnesses/all/tool-call-facets")));
  assert.equal(facets.data.tools.reduce((total, bucket) => total + bucket.count, 0), 11);
  const filtered = parseToolCallPage(await value(await fetch(collection + "?outcome=failure")));
  assert.equal(filtered.data.length, 1);
  const failed = filtered.data[0];
  assert.ok(failed);
  assert.equal(failed.harness, "opencode");
  const detail = parseToolCallDetail(await value(await fetch(base + "/api/v1/harnesses/" + failed.harness + "/tool-calls/" + encodeURIComponent(failed.id))));
  assert.equal(detail.summary.outcome, "failure");
  assert.ok(detail.native.events.length);
});

test("combined scope keeps valid calls when a source has malformed records", async (t) => {
  const base = await fixture(t, false, true);
  const all = parseToolCallPage(await value(await fetch(base + "/api/v1/harnesses/all/tool-calls")));
  assert.equal(all.data.length, 3);
  assert.equal(all.sourceHealth.status, "partial");
  const metrics = parseToolCallMetrics(await value(await fetch(base + "/api/v1/harnesses/all/tool-call-metrics?lifecycle=awaiting")));
  assert.equal(metrics.data.totalCalls, 1);
  assert.equal(metrics.data.successCalls, 0);
  const starts = metrics.data.activity.map((bin) => bin.start);
  assert.equal(new Set(starts).size, starts.length);
  assert.ok(metrics.data.window.until);
  const end = Date.parse(metrics.data.window.until);
  assert.ok(starts.every((start) => Date.parse(start) < end));
});
