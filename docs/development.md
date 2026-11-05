# Development

## Install from main

Every push to main publishes prebuilt edge assets once all platforms build. CI
runs no tests. No checkout or build:

```sh
curl -fsSL https://raw.githubusercontent.com/flexdinesh/tool-logger/main/scripts/install-desktop-edge.sh | sh
curl -fsSL https://raw.githubusercontent.com/flexdinesh/tool-logger/main/scripts/install-plugins-edge.sh | sh -s -- all
# Headless CLI only:
curl -fsSL https://raw.githubusercontent.com/flexdinesh/tool-logger/main/scripts/install-edge.sh | sh
tool-logger --version
```

Rerun to update. Run the corresponding stable installer to switch back.
Plugins require Node.js 26 and the selected harness. Review updated Codex hooks
in `/hooks`. [Release details](release.md).

## Checkout

Node.js 26, pnpm 11.25.0, Go 1.27.3. Linux desktop needs GTK 3/WebKitGTK 4.1.

```sh
pnpm install --frozen-lockfile
pnpm --filter @tool-logger/desktop dev
# Explicit browser mode, no display needed:
pnpm start browser
```

Use `TOOL_LOGGER_STATE_DIR` with synthetic state. The collector survives UI exit;
stop it with `go run ./apps/cli server stop`. Never edit real journals.

One root Go module. CLI/processes: `apps/cli`; collector/SQLite:
`apps/server`; MyGo: `apps/desktop`; React: `apps/web`.
`packages/webui` embeds ignored frontend output and serves the loopback gateway.
`MYGO_DEV_URL` or `TOOL_LOGGER_WEB_DEV_URL` explicitly selects a loopback Vite URL.

## Plugin and contract changes

```sh
pnpm --filter @tool-logger/protocol generate  # After protocol/generate.ts edits
pnpm --filter @tool-logger/transport sync    # After transport/src edits
pnpm link:codex codex-tool-logger
pnpm link:opencode opencode-tool-logger
```

Relink after edits; Codex uses regular-file snapshots and preserves backups.
Release installs share the same installer implementation and carry the entire worker.

## Verify

CI runs no tests. Run this before creating or updating a PR:

```sh
pnpm check:pr
```

It runs, in order:

```sh
pnpm check
pnpm --filter @tool-logger/web test:browser
pnpm --filter @tool-logger/desktop test:e2e
pnpm --filter @tool-logger/desktop build
```

A Linux pass does not verify macOS. Run it on macOS too before merging or tagging.

Install Chromium with `pnpm --filter @tool-logger/web exec playwright install chromium`.
Linux native automation requires the platform webview. Without a display it uses
`xvfb-run -a`; if that is missing, `check:pr` fails rather than pass skipped tests.
Checks use synthetic state and real HTTP/SQLite. Cross-compilation does not verify
another platform's runtime. See [parity](native-parity.md) and [releases](release.md).
