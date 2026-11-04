# Development

Install Node.js 26, pnpm 11.25.0 and Go 1.27.3. Linux native UI needs GTK 3. Use synthetic temporary state during development and tests; never edit real journal evidence.

```sh
pnpm install --frozen-lockfile
pnpm --filter @tool-logger/desktop dev
```

The app owns its REST listener and native window. Source forwarding is a separate supervised process:

```sh
pnpm --filter @tool-logger/transport source configure /private/synthetic-source.json
pnpm --filter @tool-logger/transport source run
```

Create the source/configuration in the native setup UI first. An isolated TOOL_LOGGER_STATE_DIR keeps development history separate. No legacy history is read.

## Contracts and runtime copies

Edit packages/protocol/generate.ts, regenerate artifacts with `pnpm --filter @tool-logger/protocol generate`, and update shared fixtures for public contract changes. Go DTOs and TypeScript encoders are checked against shared synthetic events.

Edit packages/transport/src, then run `pnpm --filter @tool-logger/transport sync`. Installed plugins contain byte-identical runtime copies. Rerun link:codex to refresh a local installation; Codex hook trust fingerprints require regular files.

## Checks

```sh
pnpm check
pnpm --filter @tool-logger/desktop test:e2e
pnpm --filter @tool-logger/desktop build
pnpm --filter @tool-logger/desktop bench
```

pnpm check validates contracts, drift, strict TypeScript, actual plugin processes, Docker/SSH delivery when available, Go vet, MyGo lifetime vet and race-tested Go packages. Tests use ui.Tester for real headless view behavior.

The e2e command requires a desktop display. Headless Linux CI uses `xvfb-run -a`. It builds native UI with the e2e-tagged automation plugin, ingests events through the real REST backend, selects/inspects calls, pauses updates, closes/reopens the window, and quits. Release builds exclude automation.

To inspect the backend without a window, use `pnpm --filter @tool-logger/desktop start --serve --listen 127.0.0.1:4317`. Administration credentials are stored privately in collector/admin.token and are never printed. Source credentials are separate.

Linux/macOS CI runs checks, native process automation and packaging. Local cross-compilation does not verify another platform's runtime. Refer to docs/native-parity.md before changing an inspection behavior.
