import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { adminToken, createSource, ingest, nativeEvent } from "./fixture.ts";
export default async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "tool-logger-browser-"));
  const executable = join(directory, "tool-logger");
  const build = spawn("go", ["build", "-o", executable, "./cmd/tool-logger"], { cwd: resolve(import.meta.dirname, "../.."), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  build.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  build.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const [code] = await once(build, "close");
  if (code !== 0) { await rm(directory, { recursive: true, force: true }); throw new Error("Browser fixture build failed: " + output); }
  const state = join(directory, "state");
  await mkdir(join(state, "collector"), { recursive: true, mode: 0o700 });
  await writeFile(join(state, "collector/admin.token"), adminToken + "\n", { mode: 0o600 });
  const child = spawn(executable, ["--serve", "--listen", "127.0.0.1:0", "--ui-listen", "127.0.0.1:0"], { env: { ...process.env, TOOL_LOGGER_STATE_DIR: state, TOOL_LOGGER_WEB_DEV_URL: "", MYGO_DEV_URL: "" }, stdio: ["ignore", "pipe", "pipe"] });
  const close = async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "close"); }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const address = await new Promise<{ ingestion: string; ui: string }>((resolve, reject) => {
      let text = "";
      const timeout = setTimeout(() => reject(new Error("Browser fixture startup timed out: " + text)), 15_000);
      child.stderr.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        const match = /Tool Logger ingestion (http:\/\/[^;\s]+); UI (http:\/\/[^\s]+)/.exec(text);
        if (match?.[1] && match[2]) { clearTimeout(timeout); resolve({ ingestion: match[1], ui: match[2] }); }
      });
      child.once("error", (e) => { clearTimeout(timeout); reject(e); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error("Browser fixture exited " + code + ": " + text)); });
    });
    process.env.TOOL_LOGGER_TEST_UI = address.ui;
    process.env.TOOL_LOGGER_TEST_INGESTION = address.ingestion;
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
  } catch (e) { await close(); throw e; }
}
