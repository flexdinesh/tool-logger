import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { api } from "../src/client/api.ts";
import { testDataSnapshot } from "../src/demo.ts";
import { detailCall } from "../src/server/rest.ts";

async function fixture(t: TestContext, outputSize = 0) {
  const sample = (await testDataSnapshot()).harnesses[0]?.calls[0];
  assert.ok(sample);
  const detail = { ...detailCall(sample), output: "x".repeat(outputSize) };
  const requests = new Map<string, string[]>();
  const server = createServer((request, response) => {
    const id = decodeURIComponent((request.url ?? "").split("/").at(-1) ?? "");
    const tag = `"${id}"`;
    const conditional = request.headers["if-none-match"] ?? "";
    requests.set(id, [...requests.get(id) ?? [], conditional]);
    response.setHeader("ETag", tag);
    if (conditional === tag) response.writeHead(304).end();
    else response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      ...detail, summary: { ...detail.summary, id },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const fetchOriginal = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetchOriginal(new URL(url, base), init);
  });
  const signal = new AbortController().signal;
  return { requests, read: (id: string) => api.detail("codex", id, signal) };
}

test("conditional reads retain recent details and evict old query entries", async (t) => {
  const f = await fixture(t);
  await f.read("entry-cold");
  await f.read("entry-hot");
  for (let index = 0; index < 1_000; index += 1) {
    await f.read(`entry-${index}`);
    if (index % 20 === 0) assert.equal((await f.read("entry-hot")).changed, false);
  }
  assert.equal((await f.read("entry-cold")).value.summary.id, "entry-cold");
  assert.deepEqual(f.requests.get("entry-cold"), ["", ""]);
  assert.equal((await f.read("entry-hot")).changed, false);
});

test("large detail history evicts cached responses before exhausting entry capacity", async (t) => {
  const f = await fixture(t, 250_000);
  await f.read("size-old");
  for (let index = 0; index < 30; index += 1) await f.read(`size-${index}`);
  assert.equal((await f.read("size-old")).value.output, "x".repeat(250_000));
  assert.deepEqual(f.requests.get("size-old"), ["", ""]);
  assert.equal((await f.read("size-29")).changed, false);
});

test("oversized details remain readable without retaining conditional cache entries", async (t) => {
  const f = await fixture(t, 5 * 1024 * 1024);
  for (let index = 0; index < 2; index += 1) {
    const result = await f.read("oversized");
    assert.equal(result.value.output, "x".repeat(5 * 1024 * 1024));
  }
  assert.deepEqual(f.requests.get("oversized"), ["", ""]);
});
