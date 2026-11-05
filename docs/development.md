# Development

Install Node.js 26, pnpm 11.25.0 and Go 1.27.3. Linux desktop execution needs GTK 3 and WebKitGTK 4.1. Headless browser development uses --serve and needs no desktop session. Use synthetic temporary state during development and tests; never edit real journal evidence.

```sh
pnpm install --frozen-lockfile
pnpm --filter @tool-logger/desktop dev
```

The app owns ingestion and loopback UI listeners plus its MyGo window. Vite supplies frontend development assets through the same-origin UI server; production embeds its output. Source forwarding is a separate supervised process:

```sh
pnpm --filter @tool-logger/transport source configure /private/synthetic-source.json
pnpm --filter @tool-logger/transport source run
```

Create the source/configuration in the setup UI first. An isolated TOOL_LOGGER_STATE_DIR keeps development history separate. No legacy history is read. For browser-only execution use `pnpm --filter @tool-logger/desktop start --serve --listen 127.0.0.1:4317 --ui-listen 127.0.0.1:4318`; authenticate at the UI URL with the private administration token from that temporary state's collector/admin.token.

MyGo binding generation registers the shell without opening storage, listeners or a display. Its generated client stays under ignored `.mygo/`; the frontend uses only the narrow runtime boundary for preferences and Quit.

## Contracts and runtime copies

Edit packages/protocol/generate.ts, regenerate artifacts with `pnpm --filter @tool-logger/protocol generate`, and update shared fixtures for public contract changes. Go DTOs and TypeScript encoders are checked against shared synthetic events.

Edit packages/transport/src, then run `pnpm --filter @tool-logger/transport sync`. Installed plugins contain byte-identical runtime copies. Rerun link:codex to refresh a local installation; Codex hook trust fingerprints require regular files.

## Checks

```sh
pnpm check
pnpm --filter @tool-logger/desktop test:browser
pnpm --filter @tool-logger/desktop test:e2e
pnpm --filter @tool-logger/desktop build
pnpm --filter @tool-logger/desktop bench
```

pnpm check validates contracts, drift, strict TypeScript, actual plugin processes, Docker/SSH delivery when available, Go vet, MyGo lifetime vet and race-tested Go packages. The desktop scripts compile frontend assets before Go compilation. Browser tests use temporary real HTTP/SQLite processes. Install their browser with `pnpm --filter @tool-logger/desktop exec playwright install chromium`.

The e2e command requires a desktop display and platform webview. Linux CI uses `xvfb-run -a`. It builds MyGo with the e2e-tagged automation plugin, ingests events through the real REST backend, evaluates the actual React page, closes/reopens the window, and quits. Release builds exclude automation. A displayless local run can verify the web UI and headless serving, but cannot establish native rendering or lifecycle correctness.

To run both servers without a window, use `pnpm --filter @tool-logger/desktop start --serve --listen 127.0.0.1:4317`. UI defaults to 127.0.0.1:4318; --ui-listen and TOOL_LOGGER_UI_LISTEN accept literal loopback addresses only. Administration credentials are stored privately in collector/admin.token and are never printed. Source credentials are separate. Tests can select port 0 for isolated listeners. Development proxying is explicit through MYGO_DEV_URL (MyGo dev) or TOOL_LOGGER_WEB_DEV_URL and accepts only loopback URLs.

Linux/macOS CI runs checks, browser tests, webview process automation and packaging. Local cross-compilation does not verify another platform's runtime. Refer to docs/native-parity.md before changing an inspection behavior.
