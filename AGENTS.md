# Tool Logger workspace

- `plugins/codex-tool-logger/`, `plugins/opencode-tool-logger/`: self-contained private pnpm packages. Register only Codex plugins in `.agents/plugins/marketplace.json`.
- `apps/desktop/`: one Go module, MyGo native UI and owned HTTP server, no webview or app container. Linux/macOS.
- `packages/protocol/`: OpenAPI/schema source, generated artifacts, shared Go/TypeScript fixtures.
- `packages/transport/`: Node built-ins only forwarder. Sync installed plugin copies and check drift after changes.
- pnpm 11, current lockfile, package-local runnable scripts; root scripts aggregate checks.
- Node 26 native TypeScript, strict erasable syntax, no hook build step, no `any`, assertions or non-null assertions.
- Installed plugins run standalone. Codex requires regular-file snapshots for fingerprints. Relink refreshes owned snapshots and preserves prior copies. Never bypass hook trust.
- Hooks silent on stdout, fail open, never wait on HTTP. Preserve complete native wrappers and serialized append-only writes across processes.
- State `~/.local/state/tool-logger/`, overridden by `TOOL_LOGGER_STATE_DIR`. Separate per-harness journals under `outbox/`. Never import, modify, merge or delete legacy history automatically.
- Source UUID defines identity; hostname/container labels are metadata. Scope correlation/deduplication by source.
- Forwarder checkpoints advance after durable ACK only. Preserve rejects, retry temporary failures, bound memory/requests, surface errors. One supervised worker per source directory.
- Server owns SQLite WAL, immutable events and transactional indexed projections. Result receipt does not establish success.
- UI uses typed REST exclusively. Keep MyGo out of domain/harness/persistence/HTTP code. Explicit composition and small consumer-owned boundary interfaces; no generic repositories or service locators.
- Loopback default; source write and administration credentials separate. Hash source tokens. No public-internet deployment scope.
- Follow DESIGN.md semantic roles. Main-thread UI state; async results use Window.Update and reject stale responses.
- Track parity in docs/native-parity.md. ui.Tester for views, real HTTP/SQLite boundary tests, automation in e2e builds only. Never claim skipped display/platform tests passed.
- Run pnpm check for plugin/workspace changes. Native process automation for UI/lifecycle changes; platform packaging before handoff.
