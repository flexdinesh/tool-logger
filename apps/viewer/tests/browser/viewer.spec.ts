import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import type {
  FacetBucket,
  FilterCapability,
  HarnessDescriptor,
  HarnessList,
  SourceHealth,
  ToolCallDetail,
  ToolCallFacets,
  ToolCallMetrics,
  ToolCallSummary,
} from "../../src/shared/api.ts";

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
    id: `call-${index}`, harness: "codex", harnessApiVersion: null, tool: "Bash", observedAt,
    startedAt: observedAt, finishedAt: observedAt, lifecycle: "finished", outcome: "unknown", durationMs: 120,
    sessionId: "session-main", agentId: null, directory: `${repository}/src`, repository,
    inputSummary: `command-${index}`, attributes: { callId: `call-${index}`, turnId: "turn-1", branch: "feature/viewer" },
    ...overrides,
  };
  return { summary, input, output, native: { attributes: {}, events: [pre, post] } };
}

function sourceHealth(harness = "codex"): SourceHealth {
  return { harness, status: "healthy", sourceLabel: "~/.local/state/tool-logger/codex-tool-calls.jsonl",
    apiVersions: [], skippedRecords: 0, lastObservedAt: now.toISOString() };
}

function descriptor(harness = "codex", agent = false): HarnessDescriptor {
  const filter = (id: string, label: string): FilterCapability => ({ id, label, type: "multi-select", queryParameter: id });
  return { id: harness, label: harness === "codex" ? "Codex" : "OpenCode", apiVersions: harness === "codex" ? [] : [1],
    capabilities: {
      filters: [filter("tool", "Tool"), filter("session", "Session"), filter("repository", "Repository"),
        filter("directory", "Directory"), ...(agent ? [filter("agent", "Agent")] : [])],
      columns: [], detailFields: [],
      outcomeSemantics: { success: "Harness reported success", failure: "Harness reported failure", unknown: "Unknown" },
    } };
}

function matches(detail: ToolCallDetail, url: URL): boolean {
  const summary = detail.summary;
  const selected = (key: string, value: string | null) => {
    const values = url.searchParams.getAll(key);
    return values.length === 0 || values.includes(value ?? "unknown");
  };
  const query = (url.searchParams.get("q") ?? "").toLowerCase();
  const since = url.searchParams.get("since");
  return selected("lifecycle", summary.lifecycle) && selected("outcome", summary.outcome)
    && selected("tool", summary.tool) && selected("session", summary.sessionId)
    && selected("agent", summary.agentId) && selected("repository", summary.repository)
    && selected("directory", summary.directory)
    && (!since || Date.parse(summary.observedAt) >= Date.parse(since))
    && (!query || JSON.stringify(detail).toLowerCase().includes(query));
}

function buckets(values: (string | null)[]): FacetBucket[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value ?? "unknown", (counts.get(value ?? "unknown") ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, label: value, count }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function facets(details: ToolCallDetail[], health: SourceHealth): ToolCallFacets {
  const summaries = details.map((detail) => detail.summary);
  return { data: {
    tools: buckets(summaries.map((call) => call.tool)), sessions: buckets(summaries.map((call) => call.sessionId)),
    agents: buckets(summaries.map((call) => call.agentId)), repositories: buckets(summaries.map((call) => call.repository)),
    directories: buckets(summaries.map((call) => call.directory)), lifecycles: buckets(summaries.map((call) => call.lifecycle)),
    outcomes: buckets(summaries.map((call) => call.outcome)),
  }, sourceHealth: health };
}

function metrics(details: ToolCallDetail[], health: SourceHealth): ToolCallMetrics {
  const summaries = details.map((detail) => detail.summary);
  const durations = summaries.flatMap((call) => call.durationMs === null ? [] : [call.durationMs]);
  return { data: {
    totalCalls: summaries.length,
    completedCalls: summaries.filter((call) => call.lifecycle !== "awaiting").length,
    awaitingCalls: summaries.filter((call) => call.lifecycle === "awaiting").length,
    successCalls: summaries.filter((call) => call.outcome === "success").length,
    failureCalls: summaries.filter((call) => call.outcome === "failure").length,
    unknownCalls: summaries.filter((call) => call.outcome === "unknown").length,
    averageDurationMs: durations.length ? durations.reduce((total, value) => total + value, 0) / durations.length : null,
    failureRate: null, window: { since: null, until: null }, activity: [],
    toolUsage: buckets(summaries.map((call) => call.tool)).map((bucket) => ({ tool: bucket.value, count: bucket.count })),
  }, sourceHealth: health };
}

async function fulfillApi(route: Route, details: ToolCallDetail[], list: HarnessList): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/v1/harnesses") {
    await route.fulfill({ json: list });
    return;
  }
  const harness = url.pathname.split("/")[4] ?? "codex";
  const health = list.sourceHealth.find((source) => source.harness === harness) ?? sourceHealth(harness);
  const filtered = details.filter((detail) => (harness === "all" || detail.summary.harness === harness) && matches(detail, url));
  if (url.pathname.endsWith("/tool-call-facets")) {
    await route.fulfill({ json: facets(details.filter((detail) => harness === "all" || detail.summary.harness === harness), health) });
    return;
  }
  if (url.pathname.endsWith("/tool-call-metrics")) {
    await route.fulfill({ json: metrics(filtered, health) });
    return;
  }
  if (url.pathname.endsWith("/tool-calls")) {
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const data = filtered.slice(offset, offset + limit).map((detail) => detail.summary);
    const next = offset + data.length;
    await route.fulfill({ json: { data, page: { nextCursor: next < filtered.length ? String(next) : null,
      hasMore: next < filtered.length }, sourceHealth: health } });
    return;
  }
  const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  const detail = details.find((candidate) => candidate.summary.harness === harness && candidate.summary.id === id);
  await route.fulfill(detail ? { json: detail } : { status: 404, json: { title: "Not found", status: 404 } });
}

async function mockApi(page: Page, details: ToolCallDetail[], path = "/", expected = details.length): Promise<void> {
  await page.clock.install({ time: now });
  const harnesses = [...new Set(details.map((detail) => detail.summary.harness))];
  const list: HarnessList = { data: harnesses.map((harness) => descriptor(harness,
    details.some((detail) => detail.summary.harness === harness && detail.summary.agentId !== null))),
    sourceHealth: harnesses.map((harness) => sourceHealth(harness)), demo: false };
  await page.route("**/api/v1/**", (route) => fulfillApi(route, details, list));
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

test("invalid harness falls back and empty sources show onboarding", async ({ page }) => {
  const list: HarnessList = { data: [], sourceHealth: [sourceHealth()], demo: false };
  await page.route("**/api/v1/**", (route) => fulfillApi(route, [], list));
  await page.goto("/?harness=missing");
  await expect(page.getByText("No harness data")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for your first tool call" })).toBeVisible();
  await expect(page.locator("#empty-message")).toContainText("Your local logs will appear here");
});

test("filters query the server, update metrics, URL, and reset", async ({ page }) => {
  const calls = [call(0), call(1, { tool: "read_file", inputSummary: "notes.txt", lifecycle: "awaiting",
    finishedAt: null, durationMs: null }), call(120)];
  await mockApi(page, calls, "/?harness=codex&q=command-120", 1);
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

test("cursor pagination appends unique pages", async ({ page }) => {
  await mockApi(page, Array.from({ length: 205 }, (_, index) => call(index)));
  await expect(page.locator("#rows > tr")).toHaveCount(100);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.locator("#rows > tr")).toHaveCount(200);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.locator("#rows > tr")).toHaveCount(205);
  await expect(page.getByRole("button", { name: "Show more" })).toBeHidden();
});

test("inspector uses accessible dialog and tabs, preserves payload text, and copies JSON", async ({ page, context }) => {
  const value = call(0);
  const payload = '<img src="/injected-image" onerror="document.title=\'injected\'">';
  value.input = { command: payload };
  value.output = { html: payload };
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page, [value]);
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

test("responsive layout keeps navigation and inspector usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, [call(0)]);
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

test("theme follows the system initially and preserves an explicit choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockApi(page, [call(0)]);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("desktop inspector stays beside usable calls and follows their selection", async ({ page }) => {
  await mockApi(page, [call(0), call(1)]);
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

test("combined scope filters both harnesses and loads native detail from its own source", async ({ page }) => {
  const mixed = [call(0), call(1, { harness: "opencode", tool: "read", outcome: "failure", agentId: "build" })];
  await mockApi(page, mixed);
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

test("pausing holds activity until updates resume", async ({ page }) => {
  const calls = [call(0)];
  await mockApi(page, calls);
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

test("filtered empty state suggests recovery", async ({ page }) => {
  await mockApi(page, [call(0)], "/?q=no-such-command", 0);
  await expect(page.getByRole("heading", { name: "No matching calls" })).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("1");
});
