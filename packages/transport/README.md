# Source transport

Node.js 26, built-ins only. Hooks append complete native wrappers to a fresh
`outbox` directory. This foreground worker delivers them over authenticated HTTP,
including private Unix sockets. The independent collector supervises the local
worker installed by `tool-logger plugins install`. It retains worker ownership
across collector crashes until the old worker exits. Supervise exactly one worker
per state directory; stop an existing manually supervised worker before handing
that directory to the collector. Hooks never start the worker or
wait for network delivery. All local records remain append-only after delivery.

## Configure and run

Local plugin installation automatically provisions a source, preserving its
existing UUID, token, journals and checkpoints. For a separately managed source,
use the application's source setup to obtain its server-issued UUID and source
write token. Administration credentials never belong
in source configuration. Save this shape in a private file (mode `0600`):

```json
{
  "schemaVersion": 1,
  "sourceId": "550e8400-e29b-41d4-a716-446655440000",
  "endpoint": "unix:///home/user/.local/state/tool-logger/collector/collector.sock",
  "token": "SOURCE_WRITE_TOKEN",
  "name": "Development laptop",
  "labels": { "service.name": "tool-logger", "deployment.environment.name": "development" }
}
```

The endpoint is a base URL without credentials, query or fragment. The worker
appends `/api/v1/ingest/events` and `/api/v1/ingest/heartbeat`. An optional base
path is supported for HTTP(S); Unix endpoints must name an absolute socket path.
The collector defaults to Unix and exposes pinned TLS only when explicitly
activated for remote clients. The Node sender's HTTPS transport uses standard CA
verification; a remote desktop pairing credential is not a source credential.
HTTP is suitable for a loopback SSH bridge; use SSH, VPN or HTTPS for
encrypted remote connections. Public internet hosting is outside the supported
deployment scope.

Repository commands:

```sh
pnpm --filter @tool-logger/transport source configure /private/source.json
pnpm --filter @tool-logger/transport source status
pnpm --filter @tool-logger/transport source run
```

Installed plugins carry the entire runtime under their own `transport` directory:

```sh
node /absolute/plugin/transport/cli.ts configure /private/source.json
node /absolute/plugin/transport/cli.ts status
node /absolute/plugin/transport/cli.ts run
```

`configure -` reads JSON from stdin instead. Do not put tokens in arguments or
shell history. Configuration output and status redact the token. Input files
must be private regular files; symlinks are rejected. Configure atomically writes
`source.json` with mode `0600`, including file and directory fsync. Tokens, name,
labels and the endpoint can be updated. Changing source UUID requires a fresh
state directory to avoid assigning existing journals to a different source.

`TOOL_LOGGER_STATE_DIR` selects the state directory. Default:
`~/.local/state/tool-logger`. All hooks and the worker for one source must share
this directory, including across container restarts. Each independent machine or
container source gets its own persistent directory and source UUID.

## State and delivery

```text
STATE/
  source.json                       private connection credentials
  state.json                        existing host-home metadata
  codex-tool-calls.jsonl             legacy, never read or modified
  opencode-tool-calls.jsonl          legacy, never read or modified
  outbox/
    codex-tool-calls.jsonl           new append-only native records
    opencode-tool-calls.jsonl        new append-only native records
    checkpoint.json                 atomic durable ACK offsets and source identity
    rejections.jsonl                append-only quarantine references and reasons
    health.json                     atomic worker status, backlog, retry and rejection counts
```

Without `source.json`, journals keep growing and the worker reports
`waiting_configuration`. It uploads nothing until the source is configured;
the selected source then owns all fresh outbox records. Legacy history is never
imported. Existing `state.json` behavior is preserved independently.

The stable envelope is `{schemaVersion:1,eventId,sourceId,harness,recordedAt,native}`.
It uses the wrapper's original `event_id` and `logged_at`; `native` preserves the
complete wrapper, including harness API version, metadata and unknown fields.
Only newline-terminated records are eligible for delivery. Hooks use one
`O_APPEND` write per record and fsync; short writes are never retried as fragments.

Batches have at most 100 events and a 1 MiB target; a single event can exceed the
target, up to the 8 MiB journal-record limit. Readers use 64 KiB chunks. A turn
processes at most 200 records per harness, then yields. Backlog counting streams
records without retaining them. Full history is never loaded into memory.
The server allows 9 MiB HTTP bodies so an 8 MiB native record plus its envelope is
deliverable. Records over 8 MiB are retained locally and quarantined by byte range. No automatic
deletion or journal rotation occurs.

Checkpoints advance only when every event in a request appears exactly once in
the durable server acknowledgement's `accepted` or `duplicates` arrays. Atomic
checkpoint replacement fsyncs the file and parent directory. A crash before the
checkpoint replays the original IDs and payloads, allowing server deduplication.
Startup ignores orphan temporary files. Corrupt checkpoints or replaced/truncated
journals stop delivery visibly. Preserve the files before repair. Removing only
an invalid checkpoint deliberately replays journals from byte zero; the server
deduplicates previously accepted IDs. Never repair by guessing a byte offset.

HTTP 400/409/413/415/422 responses split batches until the permanent rejection is
isolated. Its original bytes stay in the journal, with harness, event ID, byte
range, time and HTTP status in `rejections.jsonl`; subsequent events continue.
Invalid native records receive local rejection references. Quarantine persistence
must succeed before its checkpoint can advance. A crash between those writes can
produce duplicate quarantine references, so identify rejects by source, harness
and start/end offsets. Replaying after a server fix requires preserving/removing
the checkpoint and replaying the journal. Existing rejection evidence remains.

Authentication failures, redirects, timeouts, incomplete ACKs and transient HTTP
failures retain pending records. Retries use exponential equal jitter, initially
250–500 ms, capped at 15–30 seconds. Each HTTP operation has a 5-second deadline.
Redirects are never followed, and response bodies/errors never enter diagnostics.
Heartbeats report hostname, platform, configured labels, pending count, rejected
count and fixed error diagnostics every 10 seconds during ordinary operation.
Retries can delay heartbeats up to the capped retry interval. Status includes its
update time and worker liveness so stale health remains visible. SIGTERM/SIGINT
stops the foreground worker cleanly. Abrupt process termination is recoverable
through checkpoint replay.

## Supervision examples

These examples supervise a separate source, not a collector-owned local worker.
Examples require absolute Node.js 26 and plugin paths. Configure first. Templates
contain no credentials; `source.json` remains in the private persistent directory.

Linux user systemd:

1. Edit [tool-logger-source.service](examples/tool-logger-source.service), including
   the absolute Node/plugin paths.
2. Install as `~/.config/systemd/user/tool-logger-source.service`.
3. Run `systemctl --user daemon-reload` and
   `systemctl --user enable --now tool-logger-source`.
4. Use `journalctl --user -u tool-logger-source` for process failures and `status`
   for delivery diagnostics. Enable user lingering if delivery must continue
   after logout: `loginctl enable-linger "$USER"`.

macOS launchd:

1. Edit [dev.tool-logger.source.plist](examples/dev.tool-logger.source.plist),
   replacing `YOUR_USER`, Node location (often `/opt/homebrew/bin/node` on Apple
   Silicon), plugin path and state path.
2. Install under `~/Library/LaunchAgents/`.
3. Run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.tool-logger.source.plist`.
4. `KeepAlive` restarts failed workers within the user session. This example runs
   while the user is logged in. Use a system LaunchDaemon with an explicit user
   for unattended operation.

Docker:

[compose.yaml](examples/compose.yaml) runs the canonical runtime with a persistent
host state directory and restart policy. For an installed plugin, replace the
runtime bind mount with its `transport` directory. Configure the state directory
before starting. For the default collector, mount its private Unix socket into
the worker and configure that mounted `unix:///absolute/path` endpoint with the
container source's own credential. A separately supplied loopback SSH bridge can
also expose an HTTP endpoint, such as `http://host.docker.internal:14317`.
Docker Desktop provides that hostname; Linux uses the template's `host-gateway`
mapping. Keep any bridge restricted to the Docker/private network. The collector's
remote TCP listener uses TLS; it is not a plaintext HTTP bridge.

```sh
export TOOL_LOGGER_SOURCE_UID=$(id -u)
export TOOL_LOGGER_SOURCE_GID=$(id -g)
docker compose -f packages/transport/examples/compose.yaml up -d
docker compose -f packages/transport/examples/compose.yaml exec source node /opt/transport/cli.ts status
```

Run the worker with the volume owner's UID/GID so private checkpoint/config files
remain readable by the harness user and host status command. The template defaults
to UID/GID 1000; export the actual values above, especially on macOS.
Mount the same persistent source directory into the harness container and worker.
The worker needs write access for checkpoints and diagnostics. A dedicated
container source should use a dedicated volume, never the host source's identity.
Set the source volume path through `TOOL_LOGGER_SOURCE_STATE` before invoking
Compose. Never put source tokens in Compose environment values.

SSH reverse tunnel, from the desktop/server machine:

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R 127.0.0.1:14317:/absolute/collector/collector.sock remote-host
```

The remote source uses endpoint `http://127.0.0.1:14317` and its own source token.
Supervise SSH separately; delivery retries while the tunnel is unavailable. A
bearer token authenticates requests; SSH supplies encryption between machines.
Token rotation replaces `source.json`; the worker reloads it without
reassigning its journal identity.

## Development and integration

Canonical files live in `src/`. `sync.ts` copies them into both plugins. It removes
stale copied files and supports `--check` for exact filename/byte drift detection.
No runtime imports leave an installed plugin directory.

```sh
pnpm --filter @tool-logger/transport sync
pnpm --filter @tool-logger/transport check
pnpm --filter @tool-logger/transport typecheck
pnpm --filter @tool-logger/transport test
```

Exports: `parseSourceConfig`, `loadSourceConfig`, `configureSource`, `stateDirectory`,
`envelope`, `readJournal`, `Forwarder.tick()`, `Forwarder.stop()`, `runForwarder`,
`sourceStatus`, CLI `main`, and repository-only `syncTransport`. The worker's
`ForwarderOptions` accepts `AbortSignal`, request/heartbeat/retry timing and a
random source for deterministic tests. Runtime modules depend only on Node
built-ins and sibling transport files.

The root `pnpm check` aggregates drift, strict typechecking and transport tests.
Refresh the workspace lockfile when package metadata changes.
