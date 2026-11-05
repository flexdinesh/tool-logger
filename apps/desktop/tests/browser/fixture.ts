import { parseCredentials, parseToolCallPage } from "../../frontend/src/shared/api.ts";
import { randomUUID } from "node:crypto";
export const adminToken = Buffer.alloc(32, 7).toString("base64url");
export function uiOrigin() { const value = process.env.TOOL_LOGGER_TEST_UI; if (!value) throw new Error("Missing test UI origin."); return value; }
export function ingestionOrigin() { const value = process.env.TOOL_LOGGER_TEST_INGESTION; if (!value) throw new Error("Missing test ingestion origin."); return value; }
export function sourceA() { const value = process.env.TOOL_LOGGER_TEST_SOURCE_A; if (!value) throw new Error("Missing test source A."); return value; }
export async function admin(path: string, method = "GET", body?: unknown) {
  const response = await fetch(ingestionOrigin() + path, { method, headers: { Authorization: "Bearer " + adminToken, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(method + " " + path + ": " + response.status + " " + await response.text());
  return response;
}
export async function createSource(name: string) {
  return parseCredentials(await (await admin("/api/v1/sources", "POST", { name, hostname: "synthetic-host", platform: "linux", labels: { fixture: "synthetic" } })).json());
}
export function nativeEvent(sourceId: string, index: number, phase: "pre" | "post", stamp = Date.now() - index * 1000 - 1000, harness = "codex", status = "success") {
  const recordedAt = new Date(stamp + (phase === "post" ? 50 : 0)).toISOString();
  const eventId = randomUUID();
  const hook = harness === "codex" ? phase === "pre" ? "PreToolUse" : "PostToolUse" : phase === "pre" ? "tool.execute.before" : "tool.execute.after";
  const command = index === 1 ? '<img src="/injected-image" onerror="document.title=123">' : "synthetic-command-" + index;
  return { schemaVersion: 1, eventId, sourceId, harness, recordedAt, native: {
    schema_version: 2, event_id: eventId, logged_at: recordedAt, harness, hook, ...(harness === "opencode" ? { api_version: 2 } : {}),
    event: harness === "codex"
      ? { hook_event_name: hook, tool_use_id: "call-" + index, tool_name: index % 2 ? "read_file" : "shell", session_id: "session-" + index % 2, turn_id: "turn", cwd: "/work/repo", tool_input: { command }, tool_response: { output: "synthetic-result-" + index } }
      : { id: "call-" + index, tool: "shell", sessionID: "session-0", agent: "build", messageID: "message", input: { command }, status, result: { output: "synthetic-result-" + index }, error: "synthetic-error" },
    metadata: { session_cwd: "/work/repo", git: { root: "/work/repo", branch: "main", commit: "synthetic-commit", dirty: false, upstream: "origin/main", ahead_behind: "0 0" } },
    futureNativeField: { retained: true },
  } };
}
export async function ingest(sourceId: string, token: string, events: ReturnType<typeof nativeEvent>[]) {
  const response = await fetch(ingestionOrigin() + "/api/v1/ingest/events", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
  if (!response.ok) throw new Error("Synthetic ingestion: " + response.status + " " + await response.text());
  return response;
}
export async function calls(source: string) { return parseToolCallPage(await (await admin("/api/v1/tool-calls?source=" + source)).json()); }
