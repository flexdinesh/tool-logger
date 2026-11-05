import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isObject } from "../../src/shared/api.ts";
import { adminToken, createSource, ingest, nativeEvent } from "./fixture.ts";

export default async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "tl-browser-"));
  const executable = join(directory, "tool-logger");
  const build = spawn("go", ["build", "-o", executable, "./apps/cli"], { cwd: resolve(import.meta.dirname, "../../../.."), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  build.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  build.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const [code] = await once(build, "close");
  if (code !== 0) { await rm(directory, { recursive: true, force: true }); throw new Error("Browser fixture build failed: " + output); }
  const children: ChildProcess[] = [];
  const close = async () => {
    for (const child of children.toReversed()) {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "close"); }
    }
    await rm(directory, { recursive: true, force: true });
  };
  async function start(name: string) {
    const state = join(directory, name);
    await mkdir(join(state, "collector"), { recursive: true, mode: 0o700 });
    await writeFile(join(state, "collector/admin.token"), adminToken + "\n", { mode: 0o600 });
    const env = { ...process.env, TOOL_LOGGER_STATE_DIR: state, TOOL_LOGGER_WEB_DEV_URL: "", MYGO_DEV_URL: "", TOOL_LOGGER_UI_LISTEN: "" };
    const collector = spawn(executable, ["server", "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(collector);
    let connection: unknown;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try { connection = JSON.parse(await readFile(join(state, "collector/connection.json"), "utf8")); break; }
      catch { await setTimeout(20); }
    }
    if (!isObject(connection) || typeof connection.endpoint !== "string" || typeof connection.serverId !== "string") throw new Error("Collector not ready.");
    const child = spawn(executable, ["browser", "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const address = await new Promise<{ ui: string; bootstrap: string }>((resolve, reject) => {
      let text = "", ui = "", bootstrap = "";
      const timeout = globalThis.setTimeout(() => reject(new Error("Browser startup timed out: " + text)), 15_000);
      const parse = (chunk: Buffer) => {
        text += chunk.toString();
        ui = /Tool Logger UI (http:\/\/[^\s]+)/.exec(text)?.[1] ?? ui;
        bootstrap = /Open (http:\/\/[^\s]+)/.exec(text)?.[1] ?? bootstrap;
        if (ui && bootstrap) { globalThis.clearTimeout(timeout); resolve({ ui, bootstrap }); }
      };
      child.stderr.on("data", parse); child.stdout.on("data", parse);
      child.once("error", (error) => { globalThis.clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => { globalThis.clearTimeout(timeout); reject(new Error("Browser exited " + code + ": " + text)); });
    });
    return { ...address, endpoint: connection.endpoint, serverId: connection.serverId };
  }
  try {
    const primary = await start("primary"), other = await start("other");
    process.env.TOOL_LOGGER_TEST_UI = primary.ui;
    process.env.TOOL_LOGGER_TEST_BOOTSTRAP = primary.bootstrap;
    process.env.TOOL_LOGGER_TEST_OTHER_UI = other.ui;
    process.env.TOOL_LOGGER_TEST_OTHER_BOOTSTRAP = other.bootstrap;
    process.env.TOOL_LOGGER_TEST_SERVER_ID = primary.serverId;
    process.env.TOOL_LOGGER_TEST_OTHER_SERVER_ID = other.serverId;
    process.env.TOOL_LOGGER_TEST_INGESTION = primary.endpoint;
    process.env.TOOL_LOGGER_TEST_SOCKET = new URL(primary.endpoint).pathname;
    const a = await createSource("Synthetic laptop"), b = await createSource("Synthetic container");
    process.env.TOOL_LOGGER_TEST_SOURCE_A = a.source.id;
    const stamp = Date.now() - 3000;
    const events: ReturnType<typeof nativeEvent>[] = [];
    for (let i = 0; i < 205; i++) { events.push(nativeEvent(a.source.id, i, "pre", stamp - i * 1000)); if (i > 0) events.push(nativeEvent(a.source.id, i, "post", stamp - i * 1000)); }
    events.push(nativeEvent(a.source.id, 300, "pre", stamp - 500, "opencode"), nativeEvent(a.source.id, 300, "post", stamp - 500, "opencode"),
      nativeEvent(a.source.id, 301, "pre", stamp - 800, "opencode", "error"), nativeEvent(a.source.id, 301, "post", stamp - 800, "opencode", "error"),
      nativeEvent(a.source.id, 302, "post", stamp - 900, "opencode", "unrecognized"));
    await ingest(a.source.id, a.token, events);
    await ingest(b.source.id, b.token, [nativeEvent(b.source.id, 0, "pre", stamp)]);
    return close;
  } catch (error) { await close(); throw error; }
}
