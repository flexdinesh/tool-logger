import { isLogRecord, isObject } from "../../model.ts";
import type { JsonObject, LogRecord, ToolCall } from "../../model.ts";
import { elapsed, pairEvents, recordId, text } from "./types.ts";
import type { HarnessAdapter } from "./types.ts";

function accepts(value: unknown): value is LogRecord {
  return isLogRecord(value) && value.schema_version === 2 && value.harness === "opencode"
    && (value.api_version === 1 || value.api_version === 2)
    && (value.hook === "tool.execute.before" || value.hook === "tool.execute.after");
}

function v1Parts(record: LogRecord): { input: JsonObject; output: JsonObject } {
  return { input: isObject(record.event.input) ? record.event.input : {}, output: isObject(record.event.output) ? record.event.output : {} };
}

function identity(record: LogRecord, index: number): string {
  if (record.api_version === 1) {
    const input = v1Parts(record).input;
    const callId = text(input, "callID");
    return callId ? JSON.stringify(["opencode", 1, text(input, "sessionID"), callId])
      : JSON.stringify(["opencode", 1, "unpaired", recordId(record, index)]);
  }
  const callId = text(record.event, "id");
  return callId ? JSON.stringify(["opencode", 2, text(record.event, "sessionID"), callId])
    : JSON.stringify(["opencode", 2, "unpaired", recordId(record, index)]);
}

function identityEvent(record: LogRecord): JsonObject {
  return record.api_version === 1 ? v1Parts(record).input : record.event;
}

export function groupOpenCodeCalls(records: LogRecord[]): ToolCall[] {
  const groups = pairEvents(records, identity, (record) => record.hook === "tool.execute.before");
  return groups.map(({ id, pair }): ToolCall => {
    const record = pair.pre ?? pair.post;
    if (!record) throw new Error("empty event group");
    const version = record.api_version === 2 ? 2 : 1;
    const event = identityEvent(record);
    const beforeParts = pair.pre && pair.pre.api_version === 1 ? v1Parts(pair.pre) : null;
    const afterParts = pair.post && pair.post.api_version === 1 ? v1Parts(pair.post) : null;
    const failed = version === 2 && pair.post?.event.status === "error";
    const result = pair.post && isObject(pair.post.event.result) ? pair.post.event.result : {};
    return {
      id, harness: "opencode", apiVersion: version, time: record.logged_at,
      tool: text(event, "tool") || "Unknown tool", session: text(event, "sessionID"), turn: "",
      callId: version === 1 ? text(event, "callID") : text(event, "id"),
      message: text(event, "messageID"), agent: text(event, "agent"), title: afterParts ? text(afterParts.output, "title") : "",
      cwd: "", status: failed ? "failed" : pair.post ? "completed" : "awaiting", durationMs: elapsed(pair.pre, pair.post),
      input: version === 1 ? beforeParts?.output.args ?? afterParts?.input.args ?? null : event.input ?? null,
      output: version === 1 ? afterParts?.output.output ?? null : failed ? pair.post?.event.error ?? null : pair.post?.event.result ?? null,
      resultMetadata: version === 1 ? afterParts?.output.metadata ?? null : result.metadata ?? null,
      pre: pair.pre, post: pair.post,
    };
  }).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export const openCodeAdapter: HarnessAdapter = {
  id: "opencode",
  label: "OpenCode",
  fileName: "opencode-tool-calls.jsonl",
  accepts,
  calls: groupOpenCodeCalls,
};
