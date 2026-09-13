import { isObject } from "../../shared/api.ts";
import type { JsonObject, ToolCallDetail } from "../../shared/api.ts";
import { repositoryName } from "../format.ts";
import { MetadataFields } from "./metadata-fields.tsx";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordContext(record: JsonObject | undefined) {
  const metadata = isObject(record?.metadata) ? record.metadata : {};
  const event = isObject(record?.event) ? record.event : {};
  const git = isObject(metadata.git) ? metadata.git : {};
  const errors = Array.isArray(metadata.errors) ? metadata.errors : [];
  const gitError = errors.find((error) => isObject(error) && error.source === "git");
  return {
    directory: text(event.cwd) || text(metadata.session_cwd),
    root: text(git.root), branch: text(git.branch), commit: text(git.commit),
    upstream: text(git.upstream), divergence: text(git.ahead_behind),
    dirty: typeof git.dirty === "boolean" ? git.dirty : null,
    status: text(git.status_porcelain_v2),
    error: text(git.error) || (isObject(gitError) ? text(gitError.message) : ""),
  };
}

function GitSnapshot({ record, title }: { record: JsonObject | undefined; title: string }) {
  const git = recordContext(record);
  return <section className="git-snapshot"><h3 className="mt-5 text-sm font-semibold">{title}</h3>{!record ? <p className="detail-note mt-2 text-xs leading-5 text-muted">No matching hook event recorded.</p> : <>
    <dl className="my-3 grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-y border-border py-4 text-sm"><MetadataFields values={[
      ["Directory", git.directory || "Not recorded"], ["Repository", repositoryName(git.root) || "Not recorded"],
      ["Repo root", git.root || "Not recorded"], ["Branch", git.branch || "Not recorded"],
      ["Commit", git.commit || "Not recorded"], ["Upstream", git.upstream || "Not recorded"],
      ["Ahead / behind", git.divergence || "Not recorded"], ["Working tree", git.dirty === null ? "Unknown" : git.dirty ? "Has changes" : "Clean"],
    ]} /></dl>
    {git.error && <p className="git-error text-sm leading-6 text-warning wrap-break-word">Git unavailable: {git.error}</p>}
    {git.status && <details className="git-status"><summary className="cursor-pointer text-sm text-accent">Recorded Git status</summary><pre>{git.status.replaceAll("\0", "\n")}</pre></details>}
  </>}</section>;
}

export function GitSnapshots({ call }: { call: ToolCallDetail }) {
  const first = call.native.events[0];
  const last = call.native.events.length > 1 ? call.native.events.at(-1) : undefined;
  const hasGit = call.native.events.some((event) => {
    const metadata = isObject(event.metadata) ? event.metadata : {};
    return isObject(metadata.git);
  });
  if (!hasGit) return null;
  return (
    <details className="git-details mb-5 border-b border-border pb-5">
      <summary className="cursor-pointer text-sm font-medium text-accent">Git snapshots</summary>
      <p className="detail-note mt-3 text-xs leading-5 text-muted">Captured lifecycle context from native hook events.</p>
      <div id="git-snapshots"><GitSnapshot record={first} title="First event" /><GitSnapshot record={last} title="Last event" /></div>
    </details>
  );
}
