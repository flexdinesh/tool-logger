import assert from "node:assert/strict";
import { once } from "node:events";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { testDataSnapshot, testLogPath, testOpenCodeV1LogPath, testOpenCodeV2LogPath } from "../src/demo.ts";
import { groupCodexCalls, logPath, readLogs, readSnapshot } from "../src/logs.ts";
import { callContext, displayPath, isObject, matchesContext, recordContext, repositoryLabel } from "../src/model.ts";
import type { LogRecord } from "../src/model.ts";
import { browserUrl, createViewer, interfaceUrls, openBrowser, shouldOpenBrowser } from "../src/server.ts";
import { parseHarnessList, parseToolCallPage } from "../src/shared/api.ts";
import { appendEvent } from '../../../plugins/codex-tool-logger/scripts/log-tool-call.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "codex-viewer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "codex-tool-calls.jsonl") };
}

test("committed Codex test data is valid and covers viewer semantics", async () => {
  const data = readFileSync(testLogPath, "utf8");
  assert.ok(data.endsWith("\n"));
  const records: unknown[] = data.trimEnd().split("\n").map((line) => JSON.parse(line));
  const eventIds = new Set<string>();
  for (const value of records) {
    assert.ok(isObject(value));
    assert.equal(value.schema_version, 2);
    assert.match(String(value.event_id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    eventIds.add(String(value.event_id));
  }
  assert.equal(eventIds.size, records.length);

  const snapshot = await readLogs(testLogPath);
  assert.equal(snapshot.missing, false);
  assert.equal(snapshot.skipped, 0);
  assert.equal(snapshot.totalEvents, records.length);
  assert.equal(snapshot.calls.length, 8);
  assert.equal((await readSnapshot(dirname(testLogPath))).homeDirectory, "/home/fixture-user");
  assert.ok(snapshot.calls.some((call) => call.status === "completed"));
  assert.ok(snapshot.calls.some((call) => call.status === "awaiting"));
  assert.ok(snapshot.calls.some((call) => call.pre === null && call.post !== null));
  assert.ok(new Set(snapshot.calls.map((call) => call.session)).size > 1);
  assert.ok(new Set(snapshot.calls.map((call) => call.tool)).size > 2);
  const roots = snapshot.calls.map(callContext).map((context) => context.root).filter(Boolean);
  assert.ok(new Set(roots).size > 1);
  assert.ok(roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && root !== other && basename(root) === basename(other))));
  assert.ok(snapshot.calls.some((call) => call.pre && call.post
    && callContext({ ...call, post: call.pre }).dirty === false
    && callContext(call).dirty === true));
  assert.ok(snapshot.calls.some((call) => callContext(call).error));
  assert.ok(snapshot.calls.some((call) => isObject(call.output) && call.output.exit_code === 1));
  assert.match(data, /🐟/u);
  assert.match(data, /<script>/);
});

test("committed OpenCode V1 data preserves arguments, title, output, and metadata", async () => {
  const snapshot = await readLogs(testOpenCodeV1LogPath, "opencode");
  assert.equal(snapshot.apiVersion, 1);
  assert.equal(snapshot.calls.length, 2);
  const complete = snapshot.calls.find((call) => call.callId === "oc-v1-call-1");
  assert.ok(complete);
  assert.equal(complete.status, "completed");
  assert.equal(complete.title, "Run checks");
  assert.deepEqual(complete.input, { command: "pnpm check" });
  assert.equal(complete.output, "All checks passed");
  assert.deepEqual(complete.resultMetadata, { exit: 0, summary: "clean" });
  assert.equal(snapshot.calls.find((call) => call.callId === "oc-v1-call-2")?.status, "awaiting");
});

test("committed OpenCode V2 data preserves identifiers and explicit execution status", async () => {
  const snapshot = await readLogs(testOpenCodeV2LogPath, "opencode");
  assert.equal(snapshot.apiVersion, 2);
  assert.equal(snapshot.calls.length, 3);
  const complete = snapshot.calls.find((call) => call.callId === "oc-v2-call-1");
  assert.ok(complete);
  assert.equal(complete.agent, "build");
  assert.equal(complete.message, "msg-1");
  assert.equal(complete.status, "completed");
  assert.deepEqual(complete.output, { content: "Checks passed", metadata: { exit: 0, files: 12 } });
  const failed = snapshot.calls.find((call) => call.callId === "oc-v2-call-2");
  assert.equal(failed?.status, "failed");
  assert.deepEqual(failed?.output, { name: "FileNotFound", message: "No such file" });
  assert.equal(snapshot.calls.find((call) => call.callId === "oc-v2-call-3")?.status, "awaiting");
});

test("OpenCode preserves mixed V1 and V2 history", async (t) => {
  const f = fixture(t);
  const mixed = readFileSync(testOpenCodeV1LogPath, "utf8") + readFileSync(testOpenCodeV2LogPath, "utf8");
  writeFileSync(f.path, mixed);
  const snapshot = await readLogs(f.path, "opencode");
  assert.equal(snapshot.apiVersion, 2);
  assert.deepEqual([...new Set(snapshot.calls.map((call) => call.apiVersion))].sort(), [1, 2]);
  assert.equal(snapshot.totalEvents, 8);
});

test("test-data timestamps rebase together without changing the fixture", async () => {
  const original = readFileSync(testLogPath, "utf8");
  const now = Date.parse("2030-01-02T03:04:05.000Z");
  const snapshot = await testDataSnapshot(now);
  const times = snapshot.harnesses.flatMap((dataset) => dataset.calls.flatMap((call) => [call.pre?.logged_at, call.post?.logged_at]))
    .filter((value): value is string => value !== undefined).map((value) => Date.parse(value));
  assert.equal(Math.max(...times), now);
  for (const call of snapshot.harnesses.flatMap((dataset) => dataset.calls)) {
    if (call.pre && call.post) {
      assert.equal(Date.parse(call.post.logged_at) - Date.parse(call.pre.logged_at), call.durationMs);
    }
  }
  assert.equal(snapshot.demo, true);
  assert.deepEqual(snapshot.harnesses.map((dataset) => dataset.harness), ["codex", "opencode"]);
  assert.equal(snapshot.harnesses[0]?.source, "test-data/codex/codex-tool-calls.jsonl");
  assert.equal(readFileSync(testLogPath, "utf8"), original);
});

test("prefers Codex logs and falls back to legacy logs without modifying either", (t) => {
  const f = fixture(t);
  const legacy = join(f.directory, "tool-calls.jsonl");
  const original = process.env.TOOL_LOGGER_STATE_DIR;
  process.env.TOOL_LOGGER_STATE_DIR = f.directory;
  t.after(() => {
    if (original === undefined) delete process.env.TOOL_LOGGER_STATE_DIR;
    else process.env.TOOL_LOGGER_STATE_DIR = original;
  });
  assert.equal(logPath(), f.path);
  writeFileSync(legacy, "legacy\n");
  assert.equal(logPath(), legacy);
  assert.equal(readFileSync(legacy, "utf8"), "legacy\n");
  assert.equal(existsSync(f.path), false);
  writeFileSync(f.path, "current\n");
  assert.equal(logPath(), f.path);
  assert.equal(readFileSync(legacy, "utf8"), "legacy\n");
});

test("snapshot reports every harness source in alphabetical order", async (t) => {
  const f = fixture(t);
  writeFileSync(f.path, record());
  const opencode = join(f.directory, "opencode-tool-calls.jsonl");
  copyFileSync(testOpenCodeV2LogPath, opencode);
  const both = await readSnapshot(f.directory);
  assert.deepEqual(both.harnesses.map((dataset) => dataset.label), ["Codex", "OpenCode"]);
  rmSync(opencode);
  symlinkSync(join(f.directory, "missing-target"), opencode);
  const withUnreadable = await readSnapshot(f.directory);
  assert.deepEqual(withUnreadable.harnesses.map((dataset) => dataset.harness), ["codex", "opencode"]);
  assert.match(withUnreadable.harnesses[1]?.error ?? "", /symbolic link|ELOOP/i);
});

test("lists every IPv4 interface as a reachable viewer URL", () => {
  assert.deepEqual(interfaceUrls(4317, {
    lo0: [{ address: "127.0.0.1", family: "IPv4" }, { address: "::1", family: "IPv6" }],
    en0: [{ address: "192.168.1.12", family: "IPv4" }],
    en1: undefined,
  }), [
    { name: "lo0", url: "http://127.0.0.1:4317" },
    { name: "en0", url: "http://192.168.1.12:4317" },
  ]);
});

test("path labels shorten only the configured home directory, including a Docker host home", () => {
  assert.equal(displayPath("/Users/alex/work/repo", "/Users/alex"), "~/work/repo");
  assert.equal(displayPath("/Users/alex", "/Users/alex/"), "~");
  assert.equal(displayPath("/Users/alex-other/repo", "/Users/alex"), "/Users/alex-other/repo");
  assert.equal(displayPath("/Users/sam/repo", "/Users/alex"), "/Users/sam/repo");
  assert.equal(displayPath("/logs/codex-tool-calls.jsonl", "/Users/alex"), "/logs/codex-tool-calls.jsonl");
  assert.equal(displayPath("/work/repo"), "/work/repo");
});

test("repository labels use names and disambiguate identical names without changing filter keys", () => {
  const roots = ["/Users/alex/repo", "/work/repo", "/work/another"];
  assert.equal(repositoryLabel("/work/another", roots, "/Users/alex"), "another");
  assert.equal(repositoryLabel(roots[0] ?? "", roots, "/Users/alex"), "repo — ~/repo");
  assert.equal(repositoryLabel("/work/repo", roots, "/Users/alex"), "repo — /work/repo");
});

test("viewer reads mounted host state and tolerates missing or malformed state without modifying logs", async (t) => {
  const f = fixture(t);
  const state = join(f.directory, 'state.json');
  const data = record();
  writeFileSync(f.path, data);
  assert.equal((await readSnapshot(f.directory)).homeDirectory, undefined);
  writeFileSync(state, JSON.stringify({ schema_version: 1, home_directory: '/Users/alex' }));
  assert.equal((await readSnapshot(f.directory)).homeDirectory, '/Users/alex');
  writeFileSync(state, 'broken');
  const snapshot = await readSnapshot(f.directory);
  assert.equal(snapshot.homeDirectory, undefined);
  assert.equal(snapshot.harnesses[0]?.calls.length, 1);
  assert.equal(readFileSync(f.path, 'utf8'), data);
});
function record(
  phase = "PreToolUse",
  session = "s1",
  time = "2026-09-08T01:00:00.000Z",
  input: unknown = { command: "pwd" },
) {
  return (
    JSON.stringify({
      schema_version: 1,
      logged_at: time,
      event: {
        hook_event_name: phase,
        tool_name: "Bash",
        session_id: session,
        turn_id: "t1",
        tool_use_id: "c1",
        tool_input: input,
        ...(phase === "PostToolUse" ? { tool_response: { exit_code: 0 } } : {}),
      },
    }) + "\n"
  );
}

test("Git details preserve before/after snapshots and use the latest captured state", () => {
  const pre: LogRecord = {
    logged_at: "2026-09-08T01:00:00Z",
    event: { hook_event_name: "PreToolUse", cwd: "/work/repo/apps/viewer", tool_use_id: "1" },
    metadata: { git: { root: "/work/repo", branch: "main", commit: "abc", dirty: false } },
  };
  const post: LogRecord = { ...pre, event: { ...pre.event, hook_event_name: "PostToolUse" },
    metadata: { git: { root: "/work/repo", branch: "feature/viewer", commit: "def", dirty: true,
      upstream: "origin/main", ahead_behind: "+2 -1", status_porcelain_v2: "? new file.ts\0" } } };
  const call = groupCodexCalls([pre, post])[0];
  assert.ok(call);
  assert.equal(recordContext(call.pre).dirty, false);
  assert.equal(callContext(call).dirty, true);
  assert.equal(callContext(call).branch, "feature/viewer");
  assert.equal(callContext(call).commit, "def");
  assert.equal(callContext(call).upstream, "origin/main");
  assert.equal(callContext(call).divergence, "+2 -1");
  assert.equal(recordContext(call.post).status, "? new file.ts\0");
  assert.equal(callContext({ ...call, post: { ...post, metadata: undefined } }).branch, "main");
  const unavailable = callContext({ ...call, post: { ...post,
    metadata: { git: null, errors: [{ source: "git", message: "Git timed out" }] } } });
  assert.equal(unavailable.root, "");
  assert.equal(unavailable.dirty, null);
  assert.equal(unavailable.error, "Git timed out");
});

test("repository and directory filters combine exact full paths, including missing metadata", () => {
  const calls = groupCodexCalls([
    { logged_at: "2026-09-08T01:00:00Z", event: { hook_event_name: "PreToolUse", cwd: "/work/repo/app" },
      metadata: { git: { root: "/work/repo" } } },
    { logged_at: "2026-09-08T01:00:01Z", event: { hook_event_name: "PreToolUse", cwd: "/elsewhere/repo" },
      metadata: { git: { root: "/elsewhere/repo" } } },
    { logged_at: "2026-09-08T01:00:02Z", event: { hook_event_name: "PreToolUse", cwd: "/work/repo/lib" },
      metadata: { git: { root: "/work/repo" } } },
    { logged_at: "2026-09-08T01:00:03Z", event: { hook_event_name: "PreToolUse" } },
  ]);
  assert.equal(calls.filter((call) => matchesContext(call, "all", "/work/repo")).length, 2);
  assert.equal(calls.filter((call) => matchesContext(call, "/work/repo/app", "/work/repo")).length, 1);
  assert.equal(calls.filter((call) => matchesContext(call, "/work/repo/app", "/elsewhere/repo")).length, 0);
  assert.equal(calls.filter((call) => matchesContext(call, "unknown", "unknown")).length, 1);
  assert.equal(calls.filter((call) => matchesContext(call, "all", "all")).length, 4);
});

test("legacy and malformed Git metadata remain unknown and never imply a clean repository", () => {
  const context = recordContext({ logged_at: "2026-09-08T01:00:00Z",
    event: { hook_event_name: "PreToolUse" }, metadata: {
      session_cwd: "/work/nested", git: { root: 12, branch: {}, dirty: "false" }, errors: [null, 3],
    } });
  assert.equal(context.directory, "/work/nested");
  assert.equal(context.root, "");
  assert.equal(context.branch, "");
  assert.equal(context.dirty, null);
  assert.equal(recordContext(null).dirty, null);
});

test("missing log gives an empty view without creating files", async (t) => {
  const f = fixture(t);
  const result = await readLogs(f.path);
  assert.equal(result.missing, true);
  assert.deepEqual(result.calls, []);
  assert.equal(existsSync(f.path), false);
});

test("pairs calls by session, turn, and tool ID and preserves raw payloads", async (t) => {
  const f = fixture(t);
  const input = { command: '<script>alert("unsafe")</script>\n🐟' };
  const data =
    record("PreToolUse", "s1", undefined, input) +
    record("PreToolUse", "s2") +
    record("PostToolUse", "s1", "2026-09-08T01:00:01.250Z", input);
  writeFileSync(f.path, data);
  const snapshot = await readLogs(f.path);
  assert.equal(snapshot.calls.length, 2);
  assert.equal(snapshot.totalEvents, 3);
  const complete = snapshot.calls.find((call) => call.session === "s1");
  assert.ok(complete);
  assert.equal(complete.status, "completed");
  assert.equal(complete.durationMs, 1250);
  assert.deepEqual(complete.input, input);
  assert.deepEqual(complete.output, { exit_code: 0 });
  assert.equal(
    snapshot.calls.find((call) => call.session === "s2")?.status,
    "awaiting",
  );
  assert.equal(readFileSync(f.path, "utf8"), data);
});

test("ignores malformed lines and waits for complete appended records", async (t) => {
  const f = fixture(t);
  const post = record("PostToolUse", "s1", "2026-09-08T01:00:02.000Z");
  writeFileSync(f.path, `broken\n{}\n${record()}${post.slice(0, -2)}`);
  const first = await readLogs(f.path);
  assert.equal(first.skipped, 2);
  assert.equal(first.calls[0]?.status, "awaiting");
  appendFileSync(f.path, post.slice(-2));
  const second = await readLogs(f.path);
  assert.equal(second.calls[0]?.status, "completed");
  assert.equal(second.calls[0]?.durationMs, 2000);
});

test('viewer raw events retain enriched logger records alongside legacy records', async (t) => {
  const f = fixture(t);
  const legacy: unknown = JSON.parse(record());
  writeFileSync(f.path, record());
  appendEvent({
    hook_event_name: 'PostToolUse', cwd: f.directory, session_id: 's1', turn_id: 't1',
    tool_use_id: 'c1', tool_name: 'Bash', tool_response: { exit_code: 0 },
  }, f.directory);
  const stored: unknown = JSON.parse(readFileSync(f.path, 'utf8').trimEnd().split('\n').at(-1) ?? 'null');
  const snapshot = await readLogs(f.path);
  assert.equal(snapshot.calls.length, 1);
  assert.deepEqual(snapshot.calls[0]?.pre, legacy);
  assert.deepEqual(snapshot.calls[0]?.post, stored);
});

test("logger appends to a fixture copy that the viewer reads without losing history", async (t) => {
  const f = fixture(t);
  copyFileSync(testLogPath, f.path);
  const original = readFileSync(f.path, "utf8");
  const before = await readLogs(f.path);
  const event = {
    cwd: f.directory,
    session_id: "fixture-integration-session",
    turn_id: "fixture-integration-turn",
    tool_use_id: "fixture-integration-call",
    tool_name: "Bash",
    tool_input: { command: "pnpm check" },
  };
  appendEvent({ ...event, hook_event_name: "PreToolUse" }, f.directory);
  appendEvent({
    ...event,
    hook_event_name: "PostToolUse",
    tool_response: { exit_code: 0, stdout: "checks passed\n" },
  }, f.directory);

  const after = await readLogs(f.path);
  assert.ok(readFileSync(f.path, "utf8").startsWith(original));
  assert.equal(after.calls.length, before.calls.length + 1);
  const appended = after.calls.find((call) => call.session === event.session_id);
  assert.equal(appended?.status, "completed");
  assert.deepEqual(appended?.input, event.tool_input);
  assert.deepEqual(appended?.output, { exit_code: 0, stdout: "checks passed\n" });
});

test("bounds reading to a tail window and never parses cut-off lines", async (t) => {
  const f = fixture(t);
  const tail = record("PostToolUse", "s2");
  writeFileSync(
    f.path,
    record("PreToolUse", "s1", undefined, "x".repeat(3000)) + tail,
  );
  const result = await readLogs(f.path, "codex", Buffer.byteLength(tail) + 20);
  assert.equal(result.truncated, true);
  assert.equal(result.skipped, 0);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.session, "s2");
  assert.equal(result.calls[0]?.durationMs, null);
});

test("rejects non-file sources", async (t) => {
  const f = fixture(t);
  mkdirSync(f.path);
  await assert.rejects(readLogs(f.path));
});

test("HTTP serves the app, browser JavaScript, live data, and read-only routes", async (t) => {
  const f = fixture(t);
  const server = await createViewer({ source: f.path });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="root"/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self';/);
  const entry = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  assert.ok(entry, "built HTML references a bundled entry");
  const client = await fetch(`${base}${entry}`);
  assert.equal(client.status, 200);
  assert.match(client.headers.get("content-type") ?? "", /javascript/);
  const javascript = await client.text();
  assert.match(javascript, /Call explorer/);
  assert.doesNotMatch(javascript, /import type/);
  const empty = parseHarnessList(await (await fetch(`${base}/api/v1/harnesses`)).json());
  assert.deepEqual(empty.data, []);
  assert.equal(empty.sourceHealth.find((source) => source.harness === "codex")?.status, "missing");
  writeFileSync(f.path, record());
  const updated = parseToolCallPage(await (await fetch(`${base}/api/v1/harnesses/codex/tool-calls`)).json());
  assert.equal(updated.data.length, 1);
  assert.equal(
    (await fetch(`${base}/api/v1/harnesses`, { method: "POST" })).status,
    405,
  );
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  const foreignHost = await new Promise<number | undefined>(
    (resolve, reject) => {
      const req = request(
        `${base}/api/v1/harnesses`,
        { headers: { Host: "untrusted.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  assert.equal(foreignHost, 403);
  const ipHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${base}/api/v1/harnesses`, { headers: { Host: "192.168.1.12:4317" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(ipHost, 200);
});

test("opens the local viewer URL with the platform browser opener", () => {
  assert.equal(browserUrl("0.0.0.0", 4317), "http://127.0.0.1:4317");
  assert.equal(browserUrl("127.0.0.1", 4318), "http://127.0.0.1:4318");
  assert.equal(shouldOpenBrowser({}), true);
  assert.equal(shouldOpenBrowser({ SSH_CONNECTION: "192.0.2.10 54321 192.0.2.20 22" }), false);
  assert.equal(shouldOpenBrowser({ SSH_TTY: "/dev/pts/0" }), false);

  const opened: { command: string; args: string[] }[] = [];
  assert.equal(openBrowser("http://127.0.0.1:4317", "linux", (command, args) => opened.push({ command, args: [...args] })), true);
  assert.deepEqual(opened, [{ command: "xdg-open", args: ["http://127.0.0.1:4317"] }]);
  assert.equal(openBrowser("http://127.0.0.1:4317", "darwin", (command, args) => opened.push({ command, args: [...args] })), true);
  assert.deepEqual(opened[1], { command: "open", args: ["http://127.0.0.1:4317"] });
  assert.equal(openBrowser("http://127.0.0.1:4317", "win32", (command, args) => opened.push({ command, args: [...args] })), false);
  assert.equal(opened.length, 2);
});

async function listen(t: TestContext, options: Parameters<typeof createViewer>[0] = {}) {
  const server = await createViewer(options);
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

test("production fails clearly when its build is missing", async (t) => {
  const f = fixture(t);
  await assert.rejects(createViewer({ buildDirectory: f.directory }), /Viewer build missing.*pnpm --filter viewer build/);
  writeFileSync(join(f.directory, "index.html"), "<div id='root'></div>");
  await assert.rejects(createViewer({ buildDirectory: f.directory }), /Viewer assets missing/);
});

test("production serves only compiled assets and never follows symlinks", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.directory, "assets"));
  writeFileSync(join(f.directory, "index.html"), "<div id='root'></div>");
  writeFileSync(join(f.directory, "assets", "app.js"), "document.title = 'viewer'");
  writeFileSync(join(f.directory, "assets", "app.js.map"), "private source");
  writeFileSync(join(f.directory, "assets", "secret.json"), "private data");
  writeFileSync(f.path, "private logs");
  symlinkSync(f.path, join(f.directory, "assets", "linked.js"));
  const base = await listen(t, { buildDirectory: f.directory, source: f.path });
  assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
  for (const path of ["/assets/app.js.map", "/assets/secret.json", "/assets/linked.js", "/src/server.ts", "/codex-tool-calls.jsonl", "/client.js", "/assets/missing.js"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
});

test("development transforms React with fresh CSP nonces and blocks backend files", async (t) => {
  const base = await listen(t, { dev: true, testData: true });
  const page = await fetch(base);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /\/@vite\/client/);
  assert.match(html, /\/@react-refresh/);
  const nonce = html.match(/nonce="([^"]+)"/)?.[1];
  assert.ok(nonce);
  assert.notEqual(nonce, "__VIEWER_CSP_NONCE__");
  assert.ok(page.headers.get("content-security-policy")?.includes(`'nonce-${nonce}'`));
  const nextPage = await fetch(base);
  assert.notEqual((await nextPage.text()).match(/nonce="([^"]+)"/)?.[1], nonce);
  const client = await fetch(`${base}/src/client/main.tsx`);
  assert.equal(client.status, 200);
  assert.match(client.headers.get("content-type") ?? "", /javascript/);
  assert.equal((await fetch(`${base}/@vite/client`)).status, 200);
  assert.equal((await fetch(`${base}/@react-refresh`)).status, 200);
  const harnesses = parseHarnessList(await (await fetch(`${base}/api/v1/harnesses`)).json());
  assert.deepEqual(harnesses.data.map((dataset) => dataset.id), ["codex", "opencode"]);
  assert.equal(harnesses.demo, true);
  const codex = parseToolCallPage(await (await fetch(`${base}/api/v1/harnesses/codex/tool-calls`)).json());
  const opencode = parseToolCallPage(await (await fetch(`${base}/api/v1/harnesses/opencode/tool-calls`)).json());
  assert.equal(codex.data.length, 8);
  assert.equal(opencode.data.length, 3);
  assert.equal((await fetch(`${base}/src/shared/api.ts`)).status, 200);
  for (const path of ["/src/server.ts", "/src/logs.ts?raw", "/src/demo.ts", "/package.json", "/vite.config.ts", "/tests/viewer.test.ts", "/.env", "/@fs/etc/passwd", "/src/client/%2e%2e%2fserver.ts", "/node_modules/.vite/deps/_metadata.json"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${base}/src/shared/api.ts`, { method: "POST" })).status, 405);
  for (const origin of ["http://untrusted.example", "http://localhost:1234"]) {
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const req = request(`${base}/`, {
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Protocol": "vite-ping", Origin: origin },
      });
      req.on("upgrade", (_response, socket) => { socket.destroy(); resolve(); });
      req.on("error", reject);
      req.setTimeout(2000, () => req.destroy(new Error("Unexpected websocket timeout")));
      req.end();
    }), /socket hang up/);
  }
});
