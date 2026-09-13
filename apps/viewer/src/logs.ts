import { constants, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isObject } from "./model.ts";
import type { HarnessDataset, LogRecord, Snapshot } from "./model.ts";
import { groupCodexCalls } from "./server/harnesses/codex.ts";
import { groupOpenCodeCalls } from "./server/harnesses/opencode.ts";
import { harnessAdapter, harnessAdapters } from "./server/harnesses/registry.ts";

export { groupCodexCalls, groupOpenCodeCalls };

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 2000;

export async function readHomeDirectory(directory: string): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(join(directory, "state.json"), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096) return;
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const state: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (isObject(state) && state.schema_version === 1 && typeof state.home_directory === "string"
      && state.home_directory.startsWith("/")) return state.home_directory;
  } catch {
    // Missing display metadata must not hide tool events.
  } finally {
    await file?.close();
  }
}

export function stateDirectory(): string {
  const override = process.env.TOOL_LOGGER_STATE_DIR;
  return !override ? join(homedir(), ".local/state/tool-logger")
    : override === "~" ? homedir()
      : override.startsWith("~/") ? join(homedir(), override.slice(2)) : override;
}

export function logPath(): string {
  const directory = stateDirectory();
  const current = join(directory, "codex-tool-calls.jsonl");
  const legacy = join(directory, "tool-calls.jsonl");
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

export function harnessPaths(directory = stateDirectory()): { harness: string; source: string }[] {
  const legacy = join(directory, "tool-calls.jsonl");
  return harnessAdapters.map((adapter) => ({
    harness: adapter.id,
    source: adapter.id === "codex" && !existsSync(join(directory, adapter.fileName)) && existsSync(legacy)
      ? legacy : join(directory, adapter.fileName),
  }));
}

export function parseLines(data: string, harness: string): { records: LogRecord[]; skipped: number } {
  const adapter = harnessAdapter(harness);
  if (!adapter) throw new Error(`unsupported harness: ${harness}`);
  const records: LogRecord[] = [];
  let skipped = 0;
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (adapter.accepts(value)) records.push(value);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

export async function readLogs(source: string, harness = "codex", maxBytes = MAX_BYTES): Promise<HarnessDataset> {
  const adapter = harnessAdapter(harness);
  if (!adapter) throw new Error(`unsupported harness: ${harness}`);
  const empty: HarnessDataset = {
    harness, label: adapter.label, apiVersion: null, calls: [], source,
    missing: false, truncated: false, skipped: 0, totalEvents: 0, error: "",
  };
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ...empty, missing: true };
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("log source must be a regular file");
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, start + length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const data = buffer.subarray(0, length);
    const first = start > 0 ? data.indexOf(10) + 1 : 0;
    const last = data.lastIndexOf(10);
    const complete = last < first ? "" : data.subarray(first, last + 1).toString("utf8");
    const parsed = parseLines(complete, harness);
    const records = parsed.records.slice(-MAX_EVENTS);
    const calls = adapter.calls(records);
    const apiVersion = harness === "opencode" && records.some((record) => record.api_version === 2)
      ? 2 : harness === "opencode" && records.some((record) => record.api_version === 1) ? 1 : null;
    return { ...empty, apiVersion, calls, totalEvents: records.length, skipped: parsed.skipped,
      truncated: start > 0 || parsed.records.length > MAX_EVENTS };
  } finally {
    await file.close();
  }
}

export async function readSnapshot(directory = stateDirectory()): Promise<Snapshot> {
  const reads = await Promise.all(harnessPaths(directory).map(async ({ harness, source }) => {
    try { return await readLogs(source, harness); }
    catch (error) {
      const adapter = harnessAdapter(harness);
      if (!adapter) return undefined;
      return {
        harness, label: adapter.label, apiVersion: null, calls: [], source, missing: false,
        truncated: false, skipped: 0, totalEvents: 0,
        error: error instanceof Error ? error.message : "Unable to read source",
      };
    }
  }));
  const homeDirectory = await readHomeDirectory(directory);
  return {
    ...(homeDirectory ? { homeDirectory } : {}),
    harnesses: reads.filter((dataset): dataset is HarnessDataset => dataset !== undefined)
      .sort((a, b) => a.label.localeCompare(b.label)),
    demo: false,
  };
}
