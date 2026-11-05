import { parseCredentials, parseToolCallPage } from "../../src/shared/api.ts";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
export const adminToken = Buffer.alloc(32, 7).toString("base64url");
export function uiOrigin() { const value = process.env.TOOL_LOGGER_TEST_UI; if (!value) throw new Error("Missing test UI origin."); return value; }
export function ingestionOrigin() { const value = process.env.TOOL_LOGGER_TEST_INGESTION; if (!value) throw new Error("Missing test ingestion origin."); return value; }
export function sourceA() { const value = process.env.TOOL_LOGGER_TEST_SOURCE_A; if (!value) throw new Error("Missing test source A."); return value; }
export function collectorFetch(path: string, method: string, token: string, body?: unknown): Promise<Response> {
  const socketPath = process.env.TOOL_LOGGER_TEST_SOCKET;
  if (!socketPath) throw new Error("Missing collector socket.");
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === "string") headers.set(key, value);
          else if (value) for (const item of value) headers.append(key, item);
        }
        resolve(new Response(res.statusCode === 204 || res.statusCode === 304 ? null : Buffer.concat(chunks), { status: res.statusCode ?? 500, headers }));
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
export async function admin(path: string, method = "GET", body?: unknown) {
  const response = await collectorFetch(path, method, adminToken, body);
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
  const response = await collectorFetch("/api/v1/ingest/events", "POST", token, { events });
  if (!response.ok) throw new Error("Synthetic ingestion: " + response.status + " " + await response.text());
  return response;
}
export async function calls(source: string) { return parseToolCallPage(await (await admin("/api/v1/tool-calls?source=" + source)).json()); }
