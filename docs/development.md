# Development

## Install from main

Every push to main publishes prebuilt edge assets once all edge targets build.
Edge has no macOS Intel build; use stable there. CI runs no tests. No checkout
or build:

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

During iteration, run the fast default gate:

```sh
pnpm check
```

It checks workspace/installer/transport/schema drift, typechecks every TypeScript
project, runs plugin/frontend/transport feature tests and Go HTTP/SQLite/client/
gateway/preferences contracts, and vets Go. It builds the frontend once. Go
cross-language boundary tests always execute because Node subprocess inputs
escape Go's test result cache. Pure Go contracts reuse normal test-result caching;
compilation reuses the Go build cache throughout.

`check:pr` adds expensive suites based on committed changes since the merge base
with `origin/main`, plus staged, unstaged and untracked files. Renames include
both paths. It prints selected suites and reasons. Refresh `origin/main` before
checking a PR. Inspect selection without executing with `pnpm check:pr --list`.

| Changed area | Additional checks |
| --- | --- |
| Frontend | Browser, native automation, host packaging |
| Desktop | Go race/process tests, native automation, host packaging |
| Collector SQLite/harness adapters | Go race/process tests, browser |
| CLI, collector lifecycle/HTTP, API client, UI gateway | Go race/process tests, browser, native automation, host packaging |
| Protocol, shared build/tooling/config, unknown paths, failed Git selection | Full gate |
| Plugin, transport, installer | Go race/process tests, installed harnesses, distribution, deployment and bounded-memory backlog |
| Documentation | Default gate |

Before releases, run every retained suite:

```sh
pnpm check:full
```

Independent tasks run with at most two workers. Native automation and packaging
run afterward. Package-local commands remain runnable independently and prepare
their own assets. Root aggregates share one frontend build. `pnpm test` remains
the broad Node/transport/frontend/Go test entrypoint, including process and
installed-harness tests; `check:full` also checks protocol/schema drift.

macOS verification is optional and does not block merge or release. Report the
actual host and untested platforms; a Linux pass does not verify macOS.

Install Chromium with `pnpm --filter @tool-logger/web exec playwright install chromium`.
Linux native automation requires the platform webview. Without a display it uses
`xvfb-run -a`; selected native checks fail if it is missing. Both native lifecycle
tests must execute and pass. Optional real Codex/OpenCode and Docker/SSH/service
tests report missing external prerequisites as skips; those environments remain
unverified, even when the rest of the gate passes.
Checks use synthetic state and real HTTP/SQLite. Cross-compilation does not verify
another platform's runtime. See [parity](native-parity.md) and [releases](release.md).

Keep pnpm's content-addressed store, `GOMODCACHE` and `GOCACHE` between worktrees.
TypeScript stores compiler incremental state per project under `.scratch/typecheck`.
Do not clear them during normal checks. There is no custom test-result cache.
Use the per-task timings printed by the runner to compare initial and repeated
runs before introducing another execution system such as Dagger.

Desktop packaging defaults to the host companion only. The package build command
forwards explicit targets to both companion preparation and MyGo:

```sh
pnpm --filter @tool-logger/desktop build -platform linux/amd64,linux/arm64
```

Release packaging already stages the exact matching CLI archive separately.
