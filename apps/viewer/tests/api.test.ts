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

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "viewer-api-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "codex-tool-calls.jsonl");
  writeFileSync(source,
    record("PreToolUse", "one", "2026-09-13T01:00:00.000Z")
    + record("PostToolUse", "one", "2026-09-13T01:00:00.100Z")
    + record("PreToolUse", "two", "2026-09-13T02:00:00.000Z", "read_file")
    + record("PreToolUse", "three", "2026-09-13T03:00:00.000Z")
    + record("PostToolUse", "three", "2026-09-13T03:00:00.300Z"));
  const server = await createViewer({ source });
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
