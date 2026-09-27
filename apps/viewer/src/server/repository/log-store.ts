import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { HarnessDataset, LogRecord, Snapshot, ToolCall } from "../../model.ts";
import { harnessPaths, readHomeDirectory, stateDirectory } from "../../logs.ts";
import { harnessAdapter } from "../harnesses/registry.ts";

const CHUNK_BYTES = 1024 * 1024;

type Source = { harness: string; source: string };
type Cache = {
  source: string;
  device: number;
  inode: number;
  offset: number;
  remainder: Buffer;
  records: LogRecord[];
  calls: ToolCall[];
  projectedRecords: number;
  skipped: number;
  reset: boolean;
};

function empty(harness: string, source: string): HarnessDataset {
  const adapter = harnessAdapter(harness);
  if (!adapter) throw new Error(`unsupported harness: ${harness}`);
  return {
    harness, label: adapter.label, apiVersion: null, calls: [], source, missing: false,
    truncated: false, skipped: 0, totalEvents: 0, error: "",
  };
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
}

function appendLines(cache: Cache, data: Buffer, harness: string): void {
  const adapter = harnessAdapter(harness);
  if (!adapter) throw new Error(`unsupported harness: ${harness}`);
  const combined = cache.remainder.length ? Buffer.concat([cache.remainder, data]) : data;
  const newline = combined.lastIndexOf(10);
  if (newline < 0) {
    cache.remainder = Buffer.from(combined);
    return;
  }
  const complete = combined.subarray(0, newline).toString("utf8");
  cache.remainder = Buffer.from(combined.subarray(newline + 1));
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (adapter.accepts(value)) cache.records.push(value);
      else cache.skipped += 1;
    } catch {
      cache.skipped += 1;
    }
  }
}

async function readAppended(file: FileHandle, cache: Cache, size: number, harness: string): Promise<void> {
  while (cache.offset < size) {
    const length = Math.min(CHUNK_BYTES, size - cache.offset);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, cache.offset);
    if (bytesRead === 0) break;
    appendLines(cache, buffer.subarray(0, bytesRead), harness);
    cache.offset += bytesRead;
  }
}

export class LogStore {
  private readonly sources: () => Source[];
  private readonly home: () => Promise<string | undefined>;
  private readonly caches = new Map<string, Cache>();
  private pending: Promise<Snapshot> | undefined;

  constructor(options: { directory?: string; source?: string } = {}) {
    const directory = options.directory ?? stateDirectory();
    this.sources = options.source ? () => [{ harness: "codex", source: options.source ?? "" }]
      : () => harnessPaths(directory);
    this.home = options.source ? async () => undefined : () => readHomeDirectory(directory);
  }

  snapshot(): Promise<Snapshot> {
    if (this.pending) return this.pending;
    const task = this.readSnapshot();
    this.pending = task;
    void task.then(
      () => { if (this.pending === task) this.pending = undefined; },
      () => { if (this.pending === task) this.pending = undefined; },
    );
    return task;
  }

  private async readSource(item: Source): Promise<HarnessDataset> {
    const base = empty(item.harness, item.source);
    let file: FileHandle;
    try {
      file = await open(item.source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (error) {
      this.caches.delete(item.harness);
      if (errorCode(error) === "ENOENT") return { ...base, missing: true };
      return { ...base, error: error instanceof Error ? error.message : "Unable to open source" };
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return { ...base, error: "log source must be a regular file" };
      let cache = this.caches.get(item.harness);
      const replaced = cache !== undefined && (cache.source !== item.source || cache.device !== stat.dev
        || cache.inode !== stat.ino || stat.size < cache.offset);
      if (!cache || replaced) {
        cache = { source: item.source, device: stat.dev, inode: stat.ino, offset: 0,
          remainder: Buffer.alloc(0), records: [], calls: [], projectedRecords: -1, skipped: 0, reset: replaced };
        this.caches.set(item.harness, cache);
      }
      await readAppended(file, cache, stat.size, item.harness);
      const adapter = harnessAdapter(item.harness);
      if (!adapter) throw new Error(`unsupported harness: ${item.harness}`);
      if (cache.projectedRecords !== cache.records.length) {
        cache.calls = adapter.calls(cache.records);
        cache.projectedRecords = cache.records.length;
      }
      const apiVersion = item.harness === "opencode" && cache.records.some((record) => record.api_version === 2)
        ? 2 : item.harness === "opencode" && cache.records.some((record) => record.api_version === 1) ? 1 : null;
      return {
        ...base, apiVersion, calls: cache.calls, skipped: cache.skipped, totalEvents: cache.records.length,
        truncated: cache.reset,
      };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : "Unable to read source" };
    } finally {
      await file.close();
    }
  }

  private async readSnapshot(): Promise<Snapshot> {
    const [datasets, homeDirectory] = await Promise.all([
      Promise.all(this.sources().map((source) => this.readSource(source))),
      this.home(),
    ]);
    return {
      ...(homeDirectory ? { homeDirectory } : {}),
      harnesses: datasets.sort((left, right) => left.label.localeCompare(right.label)),
      demo: false,
    };
  }
}
