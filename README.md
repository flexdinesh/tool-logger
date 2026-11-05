# Tool Logger

Observe Codex and OpenCode tool calls in a MyGo Linux/macOS application or a local browser. Both use the same React/Graphite interface. Sources deliver complete native events over authenticated HTTP, including from remote hosts and containers. The app owns its REST servers and SQLite database.

## Requirements

Desktop development/builds need Go 1.27.3, Node.js 26 and pnpm 11.25.0. Linux desktop execution needs GTK 3 and WebKitGTK 4.1; macOS uses its system webview. Packaged apps embed the frontend and need no Node or Docker runtime. Sources need Node.js 26, Codex/OpenCode and persistent writable storage.

## Start the app

```sh
pnpm install --frozen-lockfile
pnpm --filter @tool-logger/desktop start
```

Use `pnpm --filter @tool-logger/desktop dev` for development rebuilds. Build platform packages with `pnpm --filter @tool-logger/desktop build`; output goes under `apps/desktop/build/`. Local packages are unsigned; signing is a separate release operation.

Ingestion defaults to `127.0.0.1:4317`; the UI uses a separate loopback listener at `http://127.0.0.1:4318`. Accept private-network/container sources by explicitly choosing a reachable ingestion listener:

```sh
pnpm --filter @tool-logger/desktop start --listen 0.0.0.0:4317
```

`TOOL_LOGGER_LISTEN` also sets the listener. Closing the window keeps ingestion running. Reopen through the tray, Dock, or by launching again. Quit stops the application/server. Linux tray support needs the optional AppIndicator library; launching again reopens a hidden window without it.

For browser access without a desktop session:

```sh
pnpm --filter @tool-logger/desktop start --serve
```

Open `http://127.0.0.1:4318` and sign in using the token in `~/.local/state/tool-logger/collector/admin.token` (under `TOOL_LOGGER_STATE_DIR` when overridden). The browser exchanges it for an opaque HttpOnly session cookie; the administration token is never saved in browser storage. Sessions expire after twelve hours, logout or server restart. MyGo signs in automatically through Go. Browser logout leaves ingestion running; stop `--serve` with Ctrl+C.

`--ui-listen` or `TOOL_LOGGER_UI_LISTEN` changes the UI address; only literal loopback IPs are accepted. For another machine, forward its UI port with SSH, for example `ssh -N -L 4318:127.0.0.1:4318 host`, then open the same local URL. Preserve the UI host and port through the tunnel. Ingestion bindings never expose the browser UI.

## Connect a source

1. Open **Add source**, choose a meaningful name/labels and copy its configuration.
2. Save it on that source in a private file (`chmod 600`). Adjust its endpoint to an address reachable from that source.
3. Install the harness plugin and configure its included forwarder:

   ```sh
   pnpm run link:codex codex-tool-logger
   # Or: pnpm run link:opencode opencode-tool-logger
   pnpm --filter @tool-logger/transport source configure /private/source.json
   pnpm --filter @tool-logger/transport source run
   ```

4. Restart the harness. In Codex, review and trust both hooks in `/hooks`. Use a tool and inspect its source/call.

Run one supervised forwarder per state directory; both harnesses can share it. Installed plugins contain the complete worker under `transport/`. Sources have no runtime dependency on repository scripts or Go.

Codex installs regular-file snapshots because hook fingerprints reject symlinked contents. Rerun `link:codex` after local plugin edits. Previous copies are backed up; Codex controls hook trust. OpenCode supports V1/V2, choosing V2 when both are installed.

[Source deployment](packages/transport/README.md) covers systemd, launchd, Docker volumes/host networking, SSH reverse tunnels, token rotation and diagnostics. Only the source forwarder has a Docker example. The MyGo app runs on the host.

## Inspect activity

Select sources/harnesses independently. Filter by search, tool, lifecycle, outcome, session, agent, repository, directory and time. Metrics/charts follow that scope. Load pages, pause updates, and select successive calls with the inspector open.

Inspect input, result, native payloads, metadata and before/after Git snapshots. JSON remains selectable/copyable text. Result receipt does not prove success: Codex/OpenCode V1 outcomes remain unknown; V2 uses explicit native status. Themes/layout/view preferences persist per client. MyGo seeds compatible settings from `native-preferences.json`, preserves that file and saves subsequent settings in private `webview-preferences.json`. Browsers keep their own settings locally. Activity links use `tool-logger://activity?...`; browser navigation also uses ordinary URLs.

## Delivery and data

State defaults to `~/.local/state/tool-logger/`; `TOOL_LOGGER_STATE_DIR` overrides it on desktop and sources.

| Path | Owner/purpose |
| --- | --- |
| `collector/events.sqlite` | Desktop: immutable events, indexed projections, source records |
| `collector/admin.token` | Desktop: private query/administration credential |
| `source.json` | Source: private endpoint, UUID and write token |
| `outbox/codex-tool-calls.jsonl` | Source: append-only Codex journal |
| `outbox/opencode-tool-calls.jsonl` | Source: append-only OpenCode journal |
| `outbox/checkpoint.json` | Source: durable acknowledgement positions |
| `outbox/health.json`, `outbox/rejections.jsonl` | Source: diagnostics and retained rejection references |

Hooks never wait for HTTP. The worker retries outages/replays after crashes; the server deduplicates source/event IDs and acknowledges after commit. Permanent rejects remain journaled and visible. Records over 8 MiB remain local with rejection references. Memory/requests are bounded; retained data is not automatically deleted.

This release starts fresh. Legacy root-level logs are neither imported nor modified. Independent hosts/containers need distinct source identities and persistent configurations/journals.

Full inputs/results can contain private code/credentials. Source tokens cannot read activity or administer sources. HTTP tokens authenticate; SSH, VPN or HTTPS supplies encryption. Public-internet hosting is outside this release.

## Verification

```sh
pnpm check
pnpm --filter @tool-logger/desktop test:browser
pnpm --filter @tool-logger/desktop test:e2e
pnpm --filter @tool-logger/desktop bench
```

Browser tests run headlessly against the real Go servers and temporary SQLite state. Install Chromium with `pnpm --filter @tool-logger/desktop exec playwright install chromium`. MyGo process tests need WebKitGTK and a desktop session; Linux CI uses `xvfb-run -a pnpm --filter @tool-logger/desktop test:e2e`. Tests use synthetic temporary state. CI checks Linux/macOS, browser behavior, webview automation and packaging. Real harness loader tests run when their CLIs are installed; Docker/SSH tests exercise available network dependencies. Displayless local runs do not verify native rendering or window lifecycle.

See [architecture](docs/architecture.md), [feature parity](docs/native-parity.md), [OpenAPI](packages/protocol/openapi.json) and [design tokens](DESIGN.md).
