import { expect, test as base } from "@playwright/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { isLogRecord } from "../../src/model.ts";
import type { Snapshot, ToolCall } from "../../src/model.ts";
import { RestApi } from "../../src/server/rest.ts";
import type { SnapshotLoader } from "../../src/server/rest.ts";
import type { Page, Route } from "@playwright/test";
import type { ToolCallDetail, ToolCallSummary } from "../../src/shared/api.ts";

type ApiServer = (load: SnapshotLoader) => string;

const test = base.extend<{ apiServer: ApiServer }>({
  apiServer: async ({}, use) => {
    let load: SnapshotLoader = async () => ({ harnesses: [], demo: false });
    const api = new RestApi(() => load());
    const server = createServer((request, response) => {
      void api.handle(request, response, new URL(request.url ?? "/", "http://localhost"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture listener");
      await use((loader) => {
        load = loader;
        return "http://127.0.0.1:" + address.port;
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  },
});

const now = new Date("2026-09-09T10:00:00.000Z");
const home = "/home/viewer";
const repository = `${home}/work/project`;

function call(index: number, overrides: Partial<ToolCallSummary> = {}): ToolCallDetail {
  const observedAt = new Date(now.getTime() - index * 60_000).toISOString();
  const input = { command: `command-${index}` };
  const common = { tool_name: "Bash", tool_use_id: `call-${index}`, session_id: "session-main",
    turn_id: "turn-1", cwd: `${repository}/src`, tool_input: input };
  const pre = { logged_at: observedAt, event: { ...common, hook_event_name: "PreToolUse" },
    metadata: { git: { root: repository, branch: "main", dirty: false } } };
  const output = { output: `result-${index}`, exit_code: 0 };
  const post = { logged_at: observedAt, event: { ...common, hook_event_name: "PostToolUse", tool_response: output },
    metadata: { git: { root: repository, branch: "feature/viewer", dirty: true,
      status_porcelain_v2: "? changed.ts\0" } } };
  const summary: ToolCallSummary = {
    id: `call-${index}`, harness: "codex", harnessApiVersion: overrides.harness === "opencode" ? 2 : null, tool: "Bash", observedAt,
    startedAt: observedAt, finishedAt: observedAt, lifecycle: "finished", outcome: "unknown", durationMs: 120,
    sessionId: "session-main", agentId: null, directory: `${repository}/src`, repository,
    inputSummary: `command-${index}`, attributes: { callId: `call-${index}`, turnId: "turn-1", branch: "feature/viewer" },
    ...overrides,
  };
  return { summary, input, output, native: { attributes: {}, events: [pre, post] } };
}

function fixtureCall(detail: ToolCallDetail): ToolCall {
  const summary = detail.summary;
  const text = (key: string) => typeof summary.attributes[key] === "string" ? summary.attributes[key] : "";
  const first = detail.native.events[0];
  const last = detail.native.events.at(-1);
  return {
    id: summary.id, harness: summary.harness, apiVersion: summary.harnessApiVersion, time: summary.observedAt,
    tool: summary.tool, session: summary.sessionId ?? "", turn: text("turnId"), callId: text("callId"),
    message: text("messageId"), agent: summary.agentId ?? "", title: text("title"), cwd: summary.directory ?? "",
    status: summary.outcome === "failure" ? "failed" : summary.lifecycle === "awaiting" ? "awaiting" : "completed",
    durationMs: summary.durationMs, input: detail.input, output: detail.output, resultMetadata: null,
    pre: summary.lifecycle !== "result-only" && isLogRecord(first) ? first : null,
    post: summary.lifecycle !== "awaiting" && isLogRecord(last) ? last : null,
  };
}

function fixtureSnapshot(details: ToolCallDetail[], harnesses: string[], readable = harnesses): Snapshot {
  return {
    homeDirectory: home, demo: false,
    harnesses: harnesses.map((harness) => ({
      harness, label: harness === "codex" ? "Codex" : "OpenCode", apiVersion: null,
      calls: details.filter((detail) => detail.summary.harness === harness).map(fixtureCall),
      source: `${home}/.local/state/tool-logger/${harness}-tool-calls.jsonl`, missing: !readable.includes(harness),
      truncated: false, skipped: 0, totalEvents: 0, error: "",
    })),
  };
}

async function fulfillApi(route: Route, apiBase: string): Promise<void> {
  const url = new URL(route.request().url());
  const response = await fetch(apiBase + url.pathname + url.search, { headers: route.request().headers() });
  await route.fulfill({
    status: response.status, headers: Object.fromEntries(response.headers), body: await response.text(),
  });
}

async function mockApi(page: Page, apiServer: ApiServer, details: ToolCallDetail[], path = "/", expected = details.length): Promise<void> {
  await page.clock.install({ time: now });
  const harnesses = [...new Set(details.map((detail) => detail.summary.harness))];
  const apiBase = apiServer(async () => fixtureSnapshot(details, harnesses));
  await page.route("**/api/v1/**", (route) => fulfillApi(route, apiBase));
  await page.goto(path);
  await expect(page.locator("#stat-calls")).toHaveText(String(expected));
}

test("committed test data renders both harnesses through REST", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#demo")).toHaveText("TEST DATA");
  await expect(page.locator("#stat-calls")).toHaveText("11");
  await expect(page.locator("#rows > tr")).toHaveCount(11);
  await expect(page.getByRole("group", { name: "Filter by harness" }).getByRole("button")).toHaveCount(3);
  await page.getByRole("button", { name: "OpenCode", exact: true }).click();
  await expect(page).toHaveURL(/\?harness=opencode$/);
  await expect(page.getByRole("heading", { name: "Tool activity", exact: true })).toBeVisible();
  await expect(page.locator("#rows > tr")).toHaveCount(3);
  await page.locator(".filter-disclosure summary").click();
  await expect(page.getByLabel("Filter by agent")).toBeVisible();
});

test("invalid harness falls back and empty sources show onboarding", async ({ page, apiServer }) => {
  const apiBase = apiServer(async () => fixtureSnapshot([], ["codex"], []));
  await page.route("**/api/v1/**", (route) => fulfillApi(route, apiBase));
  await page.goto("/?harness=missing");
  await expect(page.getByText("No harness data")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for your first tool call" })).toBeVisible();
  await expect(page.locator("#empty-message")).toContainText("Your local logs will appear here");
});

test("filters query the server, update metrics, URL, and reset", async ({ page, apiServer }) => {
  const calls = [call(0), call(1, { tool: "read_file", inputSummary: "notes.txt", lifecycle: "awaiting",
    finishedAt: null, durationMs: null }), call(120)];
  await mockApi(page, apiServer, calls, "/?harness=codex&q=command-120", 1);
  await expect(page.locator("#rows > tr")).toHaveCount(1);
  await expect(page).toHaveURL(/q=command-120/);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator("#rows > tr")).toHaveCount(3);
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: "Search tool calls" })).toBeFocused();
  await page.getByRole("searchbox").fill("command-120");
  await expect(page.locator("#rows > tr")).toHaveCount(1);
  await expect(page).toHaveURL(/q=command-120/);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.locator(".filter-disclosure summary").click();
  await page.getByLabel("Filter by status").selectOption("lifecycle:awaiting");
  await expect(page.locator("#rows > tr")).toHaveCount(1);
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await expect(page).toHaveURL(/lifecycle=awaiting/);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator("#rows > tr")).toHaveCount(3);
});

test("cursor pagination appends unique pages", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, Array.from({ length: 205 }, (_, index) => call(index)));
  await expect(page.locator("#rows > tr")).toHaveCount(100);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.locator("#rows > tr")).toHaveCount(200);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.locator("#rows > tr")).toHaveCount(205);
  await expect(page.getByRole("button", { name: "Show more" })).toBeHidden();
  await page.clock.runFor(5_000);
  await expect(page.locator("#rows > tr")).toHaveCount(205);
  await expect(page.getByRole("button", { name: "Show more" })).toBeHidden();
});

test("time-filtered pagination remains valid across minute changes", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, Array.from({ length: 205 }, (_, index) => call(index)), "/?range=24");
  await expect(page.locator("#rows > tr")).toHaveCount(100);
  await page.clock.fastForward(61_000);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.locator("#rows > tr")).toHaveCount(200);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.locator("#rows > tr")).toHaveCount(205);
  await expect(page.locator("#error")).toBeHidden();
});

test("live filtering removes completed calls while their inspector updates", async ({ page, apiServer }) => {
  const value = call(0, { lifecycle: "awaiting", finishedAt: null, durationMs: null });
  await mockApi(page, apiServer, [value], "/?lifecycle=awaiting");
  await page.locator("#rows > tr").click();
  await page.getByRole("tab", { name: "Result", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("No matching result");
  value.summary = { ...value.summary, lifecycle: "finished", finishedAt: now.toISOString(), durationMs: 120 };
  await page.clock.runFor(2_100);
  await expect(page.locator("#rows > tr")).toHaveCount(0);
  await expect(page.locator("#stat-calls")).toHaveText("0");
  await expect(page.locator("#detail-status")).toHaveText("Result received");
  await expect(page.getByRole("tab", { name: "Result", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("result-0");
  await page.getByRole("button", { name: "Close call details" }).click();
  await expect(page.getByRole("searchbox")).toBeFocused();
});

test("live time windows remove expired calls", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, [call(59)], "/?range=1");
  await page.clock.fastForward(120_000);
  await expect(page.locator("#rows > tr")).toHaveCount(0);
  await expect(page.locator("#stat-calls")).toHaveText("0");
});

test("selecting the current harness while paused preserves the collection", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, [call(0)]);
  await page.getByRole("button", { name: /Live updates/ }).click();
  await page.getByRole("button", { name: "All harnesses", exact: true }).click();
  await page.clock.runFor(5_000);
  await expect(page.locator("#rows > tr")).toHaveCount(1);
});

test("detail failures survive healthy polls and retry without closing", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, [call(0)]);
  let fail = true;
  await page.route("**/api/v1/harnesses/codex/tool-calls/call-0", async (route) => {
    if (fail) await route.fulfill({ status: 500, json: { detail: "Details unavailable" } });
    else await route.fallback();
  });
  await page.locator("#rows > tr").click();
  await expect(page.locator("#inspector [role=alert]")).toContainText("Details unavailable");
  await page.clock.runFor(5_000);
  await expect(page.locator("#inspector [role=alert]")).toContainText("Details unavailable");
  await expect(page.locator("#error")).toBeHidden();
  fail = false;
  await page.getByRole("button", { name: "Retry details", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("command-0");
  await expect(page.locator("#inspector [role=alert]")).toHaveCount(0);
});

test("paused activity failures retry without resuming updates", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, [call(0)]);
  let fail = true;
  await page.route("**/api/v1/**", async (route) => {
    if (fail && new URL(route.request().url()).pathname.endsWith("/tool-call-metrics")) {
      await route.fulfill({ status: 500, json: { detail: "Activity unavailable" } });
    } else await route.fallback();
  });
  await page.getByRole("button", { name: /Live updates/ }).click();
  await expect(page.locator("#error")).toContainText("Activity unavailable");
  fail = false;
  await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#rows > tr")).toHaveCount(1);
  await expect(page.locator("#live-label")).toHaveText("Updates paused");
});

test("initial discovery failure exposes a working retry", async ({ page, apiServer }) => {
  const apiBase = apiServer(async () => fixtureSnapshot([call(0)], ["codex"]));
  let fail = true;
  await page.route("**/api/v1/**", async (route) => {
    if (fail && new URL(route.request().url()).pathname === "/api/v1/harnesses") {
      await route.fulfill({ status: 500, json: { detail: "Discovery unavailable" } });
    } else await fulfillApi(route, apiBase);
  });
  await page.goto("/");
  await expect(page.locator("#error")).toContainText("Discovery unavailable");
  fail = false;
  await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#rows > tr")).toHaveCount(1);
});

test("activity failure preserves a pending detail request", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, [call(0)]);
  const pending = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  await page.route("**/api/v1/harnesses/codex/tool-calls/call-0", async (route) => {
    started.resolve();
    await pending.promise;
    await route.fallback();
  });
  await page.route("**/api/v1/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/tool-call-metrics")) {
      await route.fulfill({ status: 500, json: { detail: "Activity unavailable" } });
    } else await route.fallback();
  });
  try {
    await page.locator("#rows > tr").click();
    await started.promise;
    await page.clock.runFor(2_100);
    await expect(page.locator("#error")).toContainText("Activity unavailable");
    await expect(page.getByRole("status", { name: "Loading call details" })).toBeVisible();
    pending.resolve();
    await expect(page.getByRole("tabpanel")).toContainText("command-0");
    await expect(page.locator("#error")).toContainText("Activity unavailable");
  } finally {
    pending.resolve();
  }
});

test("late detail responses cannot overwrite a newer selection", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, [call(0), call(1)]);
  const pending = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  await page.route("**/api/v1/harnesses/codex/tool-calls/call-0", async (route) => {
    started.resolve();
    await pending.promise;
    await route.fallback();
  });
  try {
    await page.locator("#rows > tr").first().click();
    await started.promise;
    await page.locator("#rows > tr").nth(1).click();
    await expect(page.getByRole("tabpanel")).toContainText("command-1");
    pending.resolve();
    await expect(page.getByRole("tabpanel")).toContainText("command-1");
    await expect(page.locator("#inspector [role=alert]")).toHaveCount(0);
  } finally {
    pending.resolve();
  }
});

test("inspector uses accessible dialog and tabs, preserves payload text, and copies JSON", async ({ page, context, apiServer }) => {
  const value = call(0);
  const payload = '<img src="/injected-image" onerror="document.title=\'injected\'">';
  value.input = { command: payload };
  value.output = { html: payload };
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page, apiServer, [value]);
  const row = page.locator("#rows > tr").first();
  await row.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Tool call details" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Close call details" })).toBeFocused();
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked", "1");
  await expect(page.getByRole("tabpanel")).toContainText("injected-image");
  await expect(page.locator('img[src="/injected-image"]')).toHaveCount(0);
  const inputTab = page.getByRole("tab", { name: "Input", exact: true });
  await inputTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Result", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveText(JSON.stringify(value.output, null, 2));
  await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(JSON.stringify(value.output, null, 2));
  await page.getByRole("tab", { name: "Raw events" }).click();
  await expect(page.getByRole("tabpanel")).toHaveText(JSON.stringify(value.native.events, null, 2));
  await page.getByText("Git snapshots", { exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "First event" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Last event" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(row).toBeFocused();
  await expect(page).toHaveTitle("Tool activity · Tool Logger");
});

test("responsive layout keeps navigation and inspector usable", async ({ page, apiServer }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, apiServer, [call(0)]);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Filter by harness" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.locator("#mobile-calls button").click();
  const dialog = page.getByRole("dialog", { name: "Tool call details" });
  await expect.poll(async () => (await dialog.boundingBox())?.x).toBe(0);
  await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1");
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBe(0);
  expect(bounds?.width).toBe(390);
});

test("theme follows the system initially and preserves an explicit choice", async ({ page, apiServer }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockApi(page, apiServer, [call(0)]);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("desktop inspector stays beside usable calls and follows their selection", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, [call(0), call(1)]);
  const rows = page.locator("#rows > tr");
  await rows.first().click();
  const dialog = page.getByRole("dialog", { name: "Tool call details" });
  await expect(dialog).toBeVisible();
  const detailsBounds = await dialog.boundingBox();
  const callsBounds = await page.locator(".desktop-calls").boundingBox();
  expect(detailsBounds?.x).toBeGreaterThan(0);
  expect((callsBounds?.x ?? 0) + (callsBounds?.width ?? 0)).toBeLessThanOrEqual(detailsBounds?.x ?? 0);
  await expect(page.getByRole("tabpanel")).toContainText("command-0");
  await rows.nth(1).click();
  await expect(page.getByRole("tabpanel")).toContainText("command-1");
  await page.getByRole("button", { name: "Close call details" }).click();
  await expect(dialog).toBeHidden();
  await expect(rows.nth(1)).toBeFocused();
});

test("combined scope filters both harnesses and loads native detail from its own source", async ({ page, apiServer }) => {
  const mixed = [call(0), call(1, { harness: "opencode", tool: "read", outcome: "failure", agentId: "build" })];
  await mockApi(page, apiServer, mixed);
  await expect(page.getByRole("button", { name: "All harnesses", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#stat-completed")).toHaveText("2");
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await expect(page.locator("#rows")).toContainText("Codex");
  await page.getByRole("button", { name: "All harnesses", exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("2");
  await page.locator(".filter-disclosure summary").click();
  await page.getByLabel("Filter by status").selectOption("outcome:failure");
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await expect(page.locator("#rows > tr")).toHaveCount(1);
  const detailRequest = page.waitForRequest((request) => request.url().includes("/harnesses/opencode/tool-calls/call-1"));
  await page.locator("#rows > tr").click();
  await detailRequest;
  await expect(page.locator("#metadata")).toContainText("OpenCode");
  await expect(page.locator("#detail-status")).toHaveText("Failed");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Remove status filter" }).click();
  await expect(page.locator("#stat-calls")).toHaveText("2");
});

test("pausing holds activity until updates resume", async ({ page, apiServer }) => {
  const calls = [call(0)];
  await mockApi(page, apiServer, calls);
  await page.getByRole("button", { name: /Live updates/ }).click();
  await expect(page.locator("#live-label")).toHaveText("Updates paused");
  // Let the pause transition's initial read settle, then append a new observed call.
  await page.clock.runFor(300);
  calls.unshift(call(-1));
  await page.clock.runFor(5_000);
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await page.getByRole("button", { name: /Updates paused/ }).click();
  await expect(page.locator("#stat-calls")).toHaveText("2");
});

test("filtered empty state suggests recovery", async ({ page, apiServer }) => {
  await mockApi(page, apiServer, [call(0)], "/?q=no-such-command", 0);
  await expect(page.getByRole("heading", { name: "No matching calls" })).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("1");
});
