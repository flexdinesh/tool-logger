import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";

test("development watch stays running and restarts once after a source edit", { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "viewer-watch-"));
  const entry = join(directory, "server.mjs");
  const serverUrl = new URL("../src/server.ts", import.meta.url).href;
  writeFileSync(entry, `
    import { once } from "node:events";
    import { createViewer } from ${JSON.stringify(serverUrl)};
    const server = await createViewer({ dev: true, testData: true });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    console.log("WATCH_READY " + process.pid + " http://127.0.0.1:" + address.port);
  `);
  const child = spawn(process.execPath, ["--watch", "--watch-preserve-output", entry], {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  t.after(async () => {
    child.kill("SIGTERM");
    await closed;
    rmSync(directory, { recursive: true, force: true });
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const starts = () => [...output.matchAll(/WATCH_READY (\d+) (http:\/\/127\.0\.0\.1:\d+)/g)];
  const waitForStart = async (count: number) => {
    const deadline = Date.now() + 8_000;
    while (starts().length < count && Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      await setTimeout(50);
    }
    assert.equal(starts().length, count, output);
    const base = starts()[count - 1]?.[2];
    assert.ok(base, output);
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/src/client/main.tsx`)).status, 200);
    const harnesses = await fetch(`${base}/api/v1/harnesses`);
    assert.match(await harnesses.text(), /"demo":true/);
  };

  await waitForStart(1);
  await setTimeout(2_000);
  assert.equal(starts().length, 1, output);
  appendFileSync(entry, "\n// Source edit must restart the watched server.\n");
  await waitForStart(2);
  await setTimeout(2_000);
  assert.equal(starts().length, 2, output);
  assert.notEqual(starts()[0]?.[1], starts()[1]?.[1]);
});
