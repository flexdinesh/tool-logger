import type { LogRecord, ToolCall } from "../../model.ts";

export type HarnessAdapter = {
  id: string;
  label: string;
  fileName: string;
  accepts: (value: unknown) => value is LogRecord;
  calls: (records: LogRecord[]) => ToolCall[];
};

export type EventPair = { pre: LogRecord | null; post: LogRecord | null };

export function pairEvents(
  records: LogRecord[],
  identity: (record: LogRecord, index: number) => string,
  isBefore: (record: LogRecord) => boolean,
): { id: string; pair: EventPair }[] {
  const groups = new Map<string, EventPair[]>();
  records.forEach((record, index) => {
    const id = identity(record, index);
    const pairs = groups.get(id) ?? [];
    if (isBefore(record)) {
      pairs.push({ pre: record, post: null });
    } else {
      const waiting = pairs.find((pair) => pair.post === null);
      if (waiting) waiting.post = record;
      else pairs.push({ pre: null, post: record });
    }
    groups.set(id, pairs);
  });
  return [...groups].flatMap(([id, pairs]) => pairs.map((pair, index) => ({
    id: index === 0 ? id : `${id}#${index + 1}`,
    pair,
  })));
}

export function recordId(record: LogRecord, index: number): string {
  return typeof record.event_id === "string" ? record.event_id : `${record.logged_at}:${index}`;
}

export function text(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

export function elapsed(pre: LogRecord | null, post: LogRecord | null): number | null {
  if (!pre || !post) return null;
  const value = Date.parse(post.logged_at) - Date.parse(pre.logged_at);
  return value >= 0 ? value : null;
}
