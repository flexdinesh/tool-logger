import { test, expect } from "@playwright/test";

import type { Page } from "@playwright/test";
import { admin, adminToken, calls, createSource, ingest, nativeEvent, sourceA, uiOrigin, ingestionOrigin } from "./fixture.ts";
import { parseCredentials, parseToolCallMetrics } from "../../frontend/src/shared/api.ts";

test("paused Show more reuses the insertion watermark and preserves existing rows", async ({ page }) => {
  const source = await createSource("Late insertion snapshot");
  const stamp = Date.now() - 5000;
  await ingest(source.source.id, source.token, Array.from({ length: 105 }, (_, index) => nativeEvent(source.source.id, index, "pre", stamp - index * 1000)));
  await login(page); await page.goto(uiOrigin() + "/?source=" + source.source.id);
  await expect(page.locator("#stat-calls")).toHaveText("105");
  await expect(page.locator("#shown-count")).toHaveText("100");
  await page.getByRole("button", { name: /Live updates/ }).click();
  const before = await page.locator("#rows > .call-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-call-id")));
  const firstPage = await calls(source.source.id);
  const firstCursor = firstPage.page.nextCursor;
  expect(firstCursor).not.toBeNull();
  await ingest(source.source.id, source.token, [nativeEvent(source.source.id, 9999, "pre", stamp - 500)]);
  const appended = page.waitForRequest((r) => { const url = new URL(r.url()); return url.pathname === "/api/v1/tool-calls" && url.searchParams.has("cursor"); });
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  const request = new URL((await appended).url());
  expect(request.searchParams.get("cursor")).toBe(firstCursor);
  await expect(page.locator("#shown-count")).toHaveText("105");
  await expect(page.locator("#stat-calls")).toHaveText("105");
  const after = await page.locator("#rows > .call-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-call-id")));
  expect(after.slice(0, before.length)).toEqual(before);
  const loaded = await page.locator(".virtual-scroll").evaluate(async (container) => {
    const ids = new Set<string>();
    for (let top = 0; top <= container.scrollHeight; top += Math.max(1, container.clientHeight - 64)) {
      container.scrollTop = top;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      for (const row of container.querySelectorAll("[data-call-id]")) { const id = row.getAttribute("data-call-id"); if (id) ids.add(id); }
    }
    container.scrollTop = 0;
    return [...ids];
  });
  expect(loaded).toHaveLength(105);
  expect(loaded.slice(0, 100)).toEqual(firstPage.data.map((call) => call.id));
  await expect(page.locator("#rows")).not.toContainText("synthetic-command-9999");
  await page.getByRole("button", { name: /Updates paused/ }).click();
  await expect(page.locator("#shown-count")).toHaveText("106", { timeout: 2000 });
  await expect(page.locator("#rows")).toContainText("synthetic-command-9999");
});
async function login(page: Page) {
  const response = await page.request.post(uiOrigin() + "/ui/session", { headers: { Origin: uiOrigin() }, data: { token: adminToken } });
  expect(response.status()).toBe(204);
}
function activity(path = "") { return uiOrigin() + "/?source=" + sourceA() + "&harness=codex" + path; }
async function open(page: Page, path = "") {
  await login(page); await page.goto(activity(path)); await expect(page.locator("#stat-calls")).toHaveText("205");
}
test("unknown harness links recover to all harnesses within the selected source", async ({ page }) => {
  await login(page);
  await page.goto(uiOrigin() + "/?source=" + sourceA() + "&harness=unavailable");
  await expect(page.locator("#stat-calls")).toHaveText("208");
  await expect(page.getByRole("checkbox", { name: "Codex", exact: true })).not.toBeChecked();
  await expect(page).not.toHaveURL(/harness=/);
  await expect(page.locator("#rows")).toContainText("synthetic-command");
});
test("browser auth rejects source tokens, clears submitted password, expires and logs out", async ({ page, context }) => {
  const source = await createSource("Auth boundary");
  await page.goto(uiOrigin());
  await expect(page.getByRole("heading", { name: "Tool Logger", exact: true })).toBeVisible();
  const password = page.getByLabel("Administration token");
  await password.fill(source.token); await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(password).toHaveValue(""); await expect(page.getByRole("alert")).toContainText("Unauthorized");
  await password.fill(adminToken); await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tool activity", exact: true })).toBeVisible();
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
  expect(JSON.stringify(storage)).not.toContain(adminToken);
  expect(storage.cookies).not.toContain("tool_logger_session");
  await context.clearCookies();
  await expect(page.getByLabel("Administration token")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Session expired");
  await password.fill(adminToken); await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(password).toBeVisible();
  expect((await page.request.get(uiOrigin() + "/api/v1/tool-calls")).status()).toBe(401);
});
test("source create, configuration, edit, rotate and revoke use the real admin API", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page.getByLabel("Source name", { exact: true }).fill("Browser-created");
  await page.getByLabel("Source hostname").fill("remote-host");
  await page.getByLabel("Source platform").fill("linux");
  await page.getByLabel("Source labels").fill('{"container.id":"synthetic","__proto__":"literal"}');
  const created = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/sources" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Create source", exact: true }).click();
  const credential = parseCredentials(await (await created).json());
  expect(credential.source.labels["__proto__"]).toBe("literal");
  await expect(page.getByLabel("Forwarder endpoint")).toHaveValue(ingestionOrigin());
  const config = page.getByLabel("Source configuration JSON");
  await expect(config).toContainText(credential.token);
  await page.getByRole("button", { name: "Copy configuration", exact: true }).click();
  const copied: unknown = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(JSON.stringify(copied)).toContain('"__proto__":"literal"');
  expect(copied).toMatchObject({ sourceId: credential.source.id, token: credential.token, endpoint: ingestionOrigin() });
  await page.getByLabel("Source name", { exact: true }).fill("Browser-renamed");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  await expect(config).toContainText("Browser-renamed");
  await page.getByRole("button", { name: "Rotate token", exact: true }).click();
  await expect(config).not.toContainText(credential.token);
  await page.getByRole("button", { name: "Revoke token…", exact: true }).click();
  await page.getByRole("button", { name: "Confirm revoke", exact: true }).click();
  await expect(page.getByText("Token revoked. History retained.", { exact: true })).toBeVisible();
  await expect(config).toHaveCount(0);
  await page.getByRole("button", { name: "Close source setup" }).click();
  await page.getByRole("button", { name: "Connection diagnostics", exact: true }).click();
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("Server reachable; administration access accepted.", { exact: true })).toBeVisible();
});
test("every filter, missing selected facets, URL history and reset remain usable", async ({ page }) => {
  await open(page);
  await page.locator(".filter-disclosure summary").click();
  await page.getByLabel("Filter by tool", { exact: true }).selectOption(["read_file"]);
  await expect(page.locator("#stat-calls")).toHaveText("102");
  await page.getByLabel("Filter by session", { exact: true }).selectOption(["session-1"]);
  await expect(page.locator("#stat-calls")).toHaveText("102");
  await page.getByLabel("Filter by lifecycle", { exact: true }).selectOption(["finished"]);
  await page.getByLabel("Filter by outcome", { exact: true }).selectOption(["unknown"]);
  await page.getByLabel("Filter by repository", { exact: true }).selectOption(["/work/repo"]);
  await page.getByLabel("Filter by directory", { exact: true }).selectOption(["/work/repo"]);
  await expect(page).toHaveURL(/directory=/);
  await page.getByRole("searchbox").fill("no-such-call");
  await expect(page.getByRole("heading", { name: "No matching calls", exact: true })).toBeVisible();
  await expect(page.getByLabel("Filter by tool").locator('option[value="read_file"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("205");
  await page.getByRole("searchbox").fill("synthetic-command-204");
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("205");
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("1");
});
test("source and harness multi-selection sends repeated independent scopes", async ({ page }) => {
  const baseline = parseToolCallMetrics(await (await admin("/api/v1/tool-call-metrics")).json()).data.totalCalls;
  await login(page); await page.goto(uiOrigin()); await expect(page.locator("#stat-calls")).toHaveText(String(baseline));
  const side = page.getByRole("complementary", { name: "Sources and harnesses" });
  await side.getByText("Synthetic laptop", { exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("208");
  await side.getByText("Synthetic container", { exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("209");
  expect(new URL(page.url()).searchParams.getAll("source")).toHaveLength(2);
  await side.getByText("Codex", { exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("206");
  await side.getByText("OpenCode", { exact: true }).click();
  await expect(page.locator("#stat-calls")).toHaveText("209");
  expect(new URL(page.url()).searchParams.getAll("harness")).toEqual(["codex", "opencode"]);
});
test("cursor paging holds time bounds, deduplicates and really virtualizes loaded rows", async ({ page }) => {
  await open(page);
  const scoped = page.waitForResponse((r) => {
    const url = new URL(r.url());
    return url.pathname === "/api/v1/tool-calls" && url.searchParams.has("since");
  });
  await page.getByLabel("Filter by time").selectOption("24");
  await scoped;
  await expect(page.locator("#shown-count")).toHaveText("100");
  const queries: URLSearchParams[] = [];
  page.on("request", (r) => { const url = new URL(r.url()); if (url.pathname === "/api/v1/tool-calls") queries.push(url.searchParams); });
  await page.getByRole("button", { name: /Live updates/ }).click();
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.locator("#shown-count")).toHaveText("200");
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.locator("#shown-count")).toHaveText("205");
  const cursorQueries = queries.filter((q) => q.has("cursor"));
  expect(cursorQueries.length).toBeGreaterThan(0);
  expect(new Set(cursorQueries.map((q) => q.get("until"))).size).toBe(1);
  expect(await page.locator("#rows > .call-row").count()).toBeLessThan(40);
  await page.locator(".virtual-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator("#rows")).toContainText("synthetic-command-204");
  const ids = await page.locator("#rows > .call-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-call-id")));
  expect(new Set(ids).size).toBe(ids.length);
});
test("inspector has all evidence tabs, preserves text, copies payload and follows keyboard rows", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await page.locator("#rows > .call-row").nth(1).focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Tool call details" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Close call details" })).toBeFocused();
  await expect(page.getByRole("tabpanel")).toContainText("injected-image");
  await expect(page.locator('img[src="/injected-image"]')).toHaveCount(0);
  await page.getByRole("tab", { name: "Result", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("synthetic-result-1");
  await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("synthetic-result-1");
  await page.getByRole("tab", { name: "Native", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("firstMetadata");
  await page.getByRole("tab", { name: "Raw events", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("futureNativeField");
  await page.getByRole("tab", { name: "Metadata", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText(sourceA());
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await expect(page.getByRole("heading", { name: "First event", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Last event", exact: true })).toBeVisible();
  await page.locator("#rows > .call-row").nth(2).click();
  await expect(page.locator("#metadata")).toContainText(sourceA());
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden();
  await expect(page.locator("#rows > .call-row").nth(2)).toBeFocused();
  await page.keyboard.press("ArrowDown"); await expect(dialog).toBeVisible();
});
test("detail failure remains independent of healthy polls and has explicit retry", async ({ page }) => {
  await open(page); let fail = true, attempts = 0;
  await page.route("**/api/v1/tool-calls/*", async (route) => {
    attempts++; if (fail) await route.fulfill({ status: 500, json: { detail: "Synthetic detail failure" } }); else await route.continue();
  });
  await page.locator("#rows > .call-row").first().click();
  await expect(page.locator("#inspector [role=alert]")).toContainText("Synthetic detail failure");
  const updated = await page.locator("#updated").textContent();
  await expect(page.locator("#updated")).not.toHaveText(updated ?? "");
  expect(attempts).toBe(1);
  fail = false; await page.getByRole("button", { name: "Retry details", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("synthetic-command-0");
  await expect(page.locator("#inspector [role=alert]")).toHaveCount(0);
});
test("stale detail completion cannot replace a newer source-scoped selection", async ({ page }) => {
  await open(page);
  const first = await page.locator("#rows > .call-row").first().getAttribute("data-call-id");
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  await page.route("**/api/v1/tool-calls/" + first, async (route) => { started.resolve(); await gate.promise; await route.continue().catch(() => {}); });
  try {
    await page.locator("#rows > .call-row").first().click(); await started.promise;
    await page.locator("#rows > .call-row").nth(2).click();
    await expect(page.getByRole("tabpanel")).toContainText("synthetic-command-2");
    gate.resolve();
    await expect(page.getByRole("tabpanel")).toContainText("synthetic-command-2");
  } finally { gate.resolve(); }
});
test("activity failure and paused retry preserve a pending detail request", async ({ page }) => {
  await open(page);
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  await page.route("**/api/v1/tool-calls/*", async (route) => { started.resolve(); await gate.promise; await route.continue().catch(() => {}); });
  let fail = true;
  await page.route("**/api/v1/tool-call-metrics?*", async (route) => {
    if (fail) await route.fulfill({ status: 503, json: { detail: "Synthetic activity failure" } }); else await route.continue();
  });
  try {
    await page.locator("#rows > .call-row").first().click(); await started.promise;
    await expect(page.locator("#error")).toContainText("Synthetic activity failure");
    await page.getByRole("button", { name: /Live updates/ }).click();
    fail = false; await page.getByRole("button", { name: "Retry connection", exact: true }).click();
    await expect(page.locator("#error")).toBeHidden();
    await expect(page.getByRole("status", { name: "Loading call details" })).toBeVisible();
    gate.resolve(); await expect(page.getByRole("tabpanel")).toContainText("synthetic-command-0");
    await expect(page.locator("#live-label")).toHaveText("Updates paused");
  } finally { gate.resolve(); }
});
test("live completion leaves an awaiting scope while its open inspector updates", async ({ page }) => {
  const source = await createSource("Live completion");
  const stamp = Date.now() - 1000;
  await ingest(source.source.id, source.token, [nativeEvent(source.source.id, 900, "pre", stamp)]);
  await login(page); await page.goto(uiOrigin() + "/?source=" + source.source.id + "&lifecycle=awaiting");
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await page.locator("#rows > .call-row").first().click();
  await page.getByRole("tab", { name: "Result", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("No matching result");
  await ingest(source.source.id, source.token, [nativeEvent(source.source.id, 900, "post", stamp)]);
  await expect(page.locator("#stat-calls")).toHaveText("0", { timeout: 2000 });
  await expect(page.getByRole("tabpanel")).toContainText("synthetic-result-900", { timeout: 2000 });
  await expect(page.locator("#detail-status")).toHaveText("Result received");
});
test("pause cancels activity updates, supports current-scope selection and resumes live", async ({ page }) => {
  const source = await createSource("Pause scope");
  const stamp = Date.now() - 2000;
  await ingest(source.source.id, source.token, [nativeEvent(source.source.id, 800, "pre", stamp)]);
  await login(page); await page.goto(uiOrigin() + "/?source=" + source.source.id);
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await page.getByRole("button", { name: /Live updates/ }).click();
  await ingest(source.source.id, source.token, [nativeEvent(source.source.id, 801, "pre", stamp)]);
  await page.getByRole("group", { name: "Filter by harness" }).getByRole("button", { name: "All harnesses", exact: true }).click();
  await page.locator("#rows > .call-row").first().click();
  await expect(page.getByRole("tabpanel")).toContainText("synthetic-command-800");
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await page.getByRole("button", { name: /Updates paused/ }).click();
  await expect(page.locator("#stat-calls")).toHaveText("2", { timeout: 2000 });
});
test("phone browser restores Graphite, keyboard search and full-width accessible inspector", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.keyboard.press("/"); await expect(page.getByRole("searchbox")).toBeFocused();
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator("#mobile-calls > .call-row").first().click();
  const dialog = page.getByRole("dialog", { name: "Tool call details" }); await expect(dialog).toBeVisible();
  await expect.poll(async () => (await dialog.boundingBox())?.x).toBe(0);
  expect((await dialog.boundingBox())?.width).toBe(390);
  await page.screenshot({ path: "test-results/phone-light.png" });
  await page.getByLabel("Close call details").click();
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Theme", { exact: true }).selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" }); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
test("panes and columns resize by keyboard, persist, and charts toggle", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await open(page);
  await page.screenshot({ path: "test-results/desktop-dark.png" });
  const sidebar = page.getByRole("separator", { name: "Sidebar width", exact: true });
  await sidebar.focus(); await page.keyboard.press("ArrowRight"); await expect(sidebar).toHaveAttribute("aria-valuenow", "224");
  const column = page.getByRole("separator", { name: "Resize Tool / input column", exact: true });
  await column.focus(); await page.keyboard.press("ArrowRight"); await expect(column).toHaveAttribute("aria-valuenow", "316");
  await page.locator("#rows > .call-row").first().click();
  const divider = page.getByRole("separator", { name: "Collection width", exact: true });
  await page.screenshot({ path: "test-results/desktop-inspector-dark.png" });
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "test-results/desktop-inspector-light.png" });
  await divider.focus(); await page.keyboard.press("ArrowLeft"); await expect(divider).toHaveAttribute("aria-valuenow", "62");
  await page.getByLabel("Close call details").click();
  await page.getByRole("button", { name: "Hide charts", exact: true }).click();
  await expect(page.getByRole("region", { name: "Activity overview", exact: true })).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    const value: unknown = JSON.parse(localStorage.getItem("tool-logger-web-preferences-v1") ?? "{}");
    return typeof value === "object" && value !== null && "sidebar" in value && "chartsHidden" in value
      ? { sidebar: value.sidebar, chartsHidden: value.chartsHidden } : null;
  })).toEqual({ sidebar: 224, chartsHidden: true });
  await page.reload(); await expect(sidebar).toHaveAttribute("aria-valuenow", "224");
  await expect(column).toHaveAttribute("aria-valuenow", "316");
  await expect(page.getByRole("button", { name: "Show charts", exact: true })).toBeVisible();
});
test("desktop commands and legacy deep links are installed before readiness", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page); await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tool-logger:command", { detail: "search" })));
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tool-logger:open-link", { detail: "tool-logger://activity?range=24%20hours&harness=codex&q=synthetic-command-204" })));
  await expect(page.getByLabel("Filter by time")).toHaveValue("24");
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tool-logger:command", { detail: "copy-link" })));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("tool-logger://activity?");
  await page.locator("#rows > .call-row").first().click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tool-logger:command", { detail: "copy-json" })));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("synthetic-command-204");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("tool-logger:command", { detail: "diagnostics" })));
  await expect(page.getByRole("region", { name: "Connection diagnostics", exact: true })).toBeVisible();
});
test("discovery failure exposes retry and recovers without a page reload", async ({ page }) => {
  let fail = true;
  await login(page);
  await page.route("**/api/v1/harnesses", async (route) => { if (fail) await route.fulfill({ status: 503, json: { detail: "Synthetic discovery failure" } }); else await route.continue(); });
  await page.goto(activity());
  await expect(page.locator("#error")).toContainText("Synthetic discovery failure");
  fail = false; await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(page.locator("#error")).toBeHidden(); await expect(page.locator("#stat-calls")).toHaveText("205");
});

test("MyGo uses validated shell preferences and exposes Quit without browser storage", async ({ page }) => {
  await login(page);
  await page.addInitScript((initial: string) => {
    Object.defineProperty(window, "mygo", { value: {
      call: async (method: string, ...args: unknown[]) => {
        if (method === "Shell.Preferences") return initial;
        if (method === "Shell.SavePreferences") {
          if (typeof args[0] !== "string") throw new Error("Preferences must be text.");
          document.documentElement.dataset.savedPreferences = args[0]; return null;
        }
        if (method === "Shell.Quit") { document.documentElement.dataset.quitRequested = "true"; return null; }
        throw new Error("Unexpected bridge method " + method);
      },
    } });
  }, JSON.stringify({ query: { source: [sourceA()], harness: ["codex"] }, theme: "Dark", sidebar: 256, collection: 70, tab: "Native", timeRange: "24 hours", columns: { Order: ["State", "Tool", "Recorded"], Widths: { Tool: 128, Input: 180 } }, filters: true, chartsHidden: true }));
  await page.goto(uiOrigin());
  await expect(page.locator("#stat-calls")).toHaveText("205");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Filter by time")).toHaveValue("24");
  await expect(page.getByRole("separator", { name: "Sidebar width", exact: true })).toHaveAttribute("aria-valuenow", "256");
  await expect(page.getByRole("separator", { name: "Resize Tool / input column", exact: true })).toHaveAttribute("aria-valuenow", "308");
  await expect(page.getByRole("button", { name: "Logout", exact: true })).toHaveCount(0);
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await expect.poll(() => page.locator("html").getAttribute("data-saved-preferences")).toContain('"theme":"light"');
  expect(await page.evaluate(() => localStorage.getItem("tool-logger-web-preferences-v1"))).toBeNull();
  await page.getByRole("button", { name: "Quit", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-quit-requested", "true");
});
test("unknown bridge preference values expose startup recovery", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "mygo", { value: { call: async () => ({ unsafe: true }) } }); });
  await page.goto(uiOrigin());
  await expect(page.getByRole("alert")).toContainText("Shell preferences must be JSON text.");
  await expect(page.getByRole("button", { name: "Retry startup", exact: true })).toBeVisible();
});
test("OpenCode outcome and agent filters preserve explicit failure evidence", async ({ page }) => {
  await login(page); await page.goto(uiOrigin() + "/?source=" + sourceA() + "&harness=opencode&outcome=failure&agent=build");
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await page.locator("#rows > .call-row").first().click();
  await expect(page.locator("#detail-status")).toHaveText("Failed");
  await page.getByRole("tab", { name: "Result", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("synthetic-error");
  await page.getByRole("tab", { name: "Native", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText('"status": "error"');
});
test("live relative time windows expire old rows while custom UTC filters stay fixed", async ({ page }) => {
  const source = await createSource("Time expiry");
  const stamp = Date.now() - 14 * 60_000;
  await ingest(source.source.id, source.token, [nativeEvent(source.source.id, 700, "pre", stamp)]);
  await login(page); await page.goto(uiOrigin() + "/?source=" + source.source.id + "&range=15%20minutes");
  await expect(page.locator("#stat-calls")).toHaveText("1");
  await page.clock.install(); await page.clock.fastForward(2 * 60_000);
  await expect(page.locator("#stat-calls")).toHaveText("0");
  await page.locator(".filter-disclosure summary").click();
  await page.getByLabel("Filter since").fill(new Date(stamp - 1000).toISOString().slice(0, 19));
  await page.getByLabel("Filter until").fill(new Date(stamp + 1000).toISOString().slice(0, 19));
  await expect(page.getByLabel("Filter by time")).toHaveValue("custom");
  await expect(page.locator("#stat-calls")).toHaveText("1");
});
