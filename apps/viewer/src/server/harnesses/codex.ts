import { isLogRecord } from "../../model.ts";
import type { LogRecord, ToolCall } from "../../model.ts";
import { elapsed, pairEvents, recordId, text } from "./types.ts";
import type { HarnessAdapter } from "./types.ts";

function accepts(value: unknown): value is LogRecord {
  return isLogRecord(value) && (value.event.hook_event_name === "PreToolUse" || value.event.hook_event_name === "PostToolUse");
}

export function groupCodexCalls(records: LogRecord[]): ToolCall[] {
  const groups = pairEvents(records, (record, index) => {
    const event = record.event;
    const callId = text(event, "tool_use_id");
    return callId ? JSON.stringify(["codex", text(event, "session_id"), text(event, "turn_id"), callId])
      : JSON.stringify(["codex", "unpaired", recordId(record, index)]);
  }, (record) => record.event.hook_event_name === "PreToolUse");
  return groups.map(({ id, pair }): ToolCall => {
    const record = pair.pre ?? pair.post;
    if (!record) throw new Error("empty event group");
    const event = record.event;
    return {
      id, harness: "codex", apiVersion: null, time: record.logged_at,
      tool: text(event, "tool_name") || "Unknown tool", session: text(event, "session_id"),
      turn: text(event, "turn_id"), callId: text(event, "tool_use_id"), message: "", agent: "", title: "",
      cwd: text(event, "cwd"), status: pair.post ? "completed" : "awaiting", durationMs: elapsed(pair.pre, pair.post),
      input: event.tool_input ?? null, output: pair.post?.event.tool_response ?? null, resultMetadata: null,
      pre: pair.pre, post: pair.post,
    };
  }).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  label: "Codex",
  fileName: "codex-tool-calls.jsonl",
  accepts,
  calls: groupCodexCalls,
};
