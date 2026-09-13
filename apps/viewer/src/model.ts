export type JsonObject = Record<string, unknown>;
export type HarnessId = string;
export type CallStatus = "completed" | "failed" | "awaiting";

export type LogRecord = {
  schema_version?: unknown;
  event_id?: unknown;
  logged_at: string;
  event: JsonObject;
  metadata?: unknown;
  api_version?: unknown;
  hook?: unknown;
  harness?: unknown;
};

export type ToolCall = {
  id: string;
  harness: HarnessId;
  apiVersion: string | number | null;
  time: string;
  tool: string;
  session: string;
  turn: string;
  callId: string;
  message: string;
  agent: string;
  title: string;
  cwd: string;
  status: CallStatus;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  resultMetadata: unknown;
  pre: LogRecord | null;
  post: LogRecord | null;
};

export type HarnessDataset = {
  harness: HarnessId;
  label: string;
  apiVersion: string | number | null;
  calls: ToolCall[];
  source: string;
  missing: boolean;
  truncated: boolean;
  skipped: number;
  totalEvents: number;
  error: string;
};

export type Snapshot = {
  homeDirectory?: string;
  harnesses: HarnessDataset[];
  demo: boolean;
};

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function displayPath(path: string, homeDirectory = ""): string {
  const home = homeDirectory.replace(/\/+$/, "");
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function repositoryName(root: string): string {
  return root.split("/").filter(Boolean).at(-1) || root;
}

export function repositoryLabel(root: string, roots: string[], homeDirectory = ""): string {
  const name = repositoryName(root);
  const duplicate = roots.some((other) => other !== root && repositoryName(other) === name);
  return duplicate ? `${name} — ${displayPath(root, homeDirectory)}` : name;
}

export function recordContext(record: LogRecord | null) {
  const metadata = isObject(record?.metadata) ? record.metadata : {};
  const git = isObject(metadata.git) ? metadata.git : {};
  const text = (value: unknown): string => typeof value === "string" ? value : "";
  const errors = Array.isArray(metadata.errors) ? metadata.errors : [];
  const gitError = errors.find((error: unknown) => isObject(error) && error.source === "git");
  return {
    directory: text(record?.event.cwd) || text(metadata.session_cwd),
    root: text(git.root), branch: text(git.branch), commit: text(git.commit),
    upstream: text(git.upstream), divergence: text(git.ahead_behind),
    dirty: typeof git.dirty === "boolean" ? git.dirty : null,
    status: text(git.status_porcelain_v2),
    error: text(git.error) || (isObject(gitError) ? text(gitError.message) : ""),
  };
}

export function callContext(call: ToolCall) {
  const record = call.post && isObject(call.post.metadata) ? call.post : call.pre ?? call.post;
  const context = recordContext(record);
  return { ...context, directory: context.directory || call.cwd };
}

export function matchesContext(call: ToolCall, directory: string, repository: string): boolean {
  const context = callContext(call);
  return (directory === "all" || directory === (context.directory || "unknown"))
    && (repository === "all" || repository === (context.root || "unknown"));
}

export function isLogRecord(value: unknown): value is LogRecord {
  return isObject(value) && typeof value.logged_at === "string"
    && Number.isFinite(Date.parse(value.logged_at)) && isObject(value.event);
}

function isCall(value: unknown): value is ToolCall {
  return isObject(value) && typeof value.harness === "string"
    && (value.apiVersion === null || typeof value.apiVersion === "string" || typeof value.apiVersion === "number")
    && typeof value.id === "string" && typeof value.time === "string"
    && typeof value.tool === "string" && typeof value.session === "string"
    && typeof value.turn === "string" && typeof value.callId === "string"
    && typeof value.message === "string" && typeof value.agent === "string"
    && typeof value.title === "string" && typeof value.cwd === "string"
    && (value.status === "completed" || value.status === "failed" || value.status === "awaiting")
    && (value.durationMs === null || typeof value.durationMs === "number")
    && (value.pre === null || isLogRecord(value.pre)) && (value.post === null || isLogRecord(value.post))
    && "input" in value && "output" in value && "resultMetadata" in value;
}

function isHarnessDataset(value: unknown): value is HarnessDataset {
  return isObject(value) && typeof value.harness === "string"
    && typeof value.label === "string" && (value.apiVersion === null || typeof value.apiVersion === "string" || typeof value.apiVersion === "number")
    && Array.isArray(value.calls) && value.calls.every(isCall) && typeof value.source === "string"
    && typeof value.missing === "boolean" && typeof value.truncated === "boolean"
    && typeof value.skipped === "number" && typeof value.totalEvents === "number" && typeof value.error === "string";
}

export function isSnapshot(value: unknown): value is Snapshot {
  return isObject(value) && Array.isArray(value.harnesses) && value.harnesses.every(isHarnessDataset)
    && (value.homeDirectory === undefined || typeof value.homeDirectory === "string")
    && typeof value.demo === "boolean";
}
