# OpenCode Tool Logger

Local OpenCode V1/V2 plugin. Each native before/after tool event is appended to
`~/.local/state/tool-logger/outbox/opencode-tool-calls.jsonl`, or the directory selected
by `TOOL_LOGGER_STATE_DIR`.

From the repository root, run:

```sh
pnpm run link:opencode opencode-tool-logger
```

The linker selects `v1.ts` for OpenCode V1 or `v2.ts` for V2. Both generations
append independently to the same history. Existing activation markers are ignored.
Codex logs are independent.

## Source delivery

New records append to `STATE/outbox/opencode-tool-calls.jsonl`, independently of
legacy `STATE/opencode-tool-calls.jsonl`. `STATE` defaults to
`~/.local/state/tool-logger`, overridden by `TOOL_LOGGER_STATE_DIR`. Existing
history and activation markers are never imported or rewritten. Local appends
continue before source configuration. Hooks perform no delivery HTTP requests.

Supervise one worker for both harnesses in a source directory. This plugin carries
the complete Node.js 26 worker under `transport/`:

```sh
node /absolute/plugin/transport/cli.ts configure /private/source.json
node /absolute/plugin/transport/cli.ts status
node /absolute/plugin/transport/cli.ts run
```

Configuration, supplied through a private file (mode `0600`) or `configure -`
stdin, has shape:

```json
{"schemaVersion":1,"sourceId":"550e8400-e29b-41d4-a716-446655440000","endpoint":"http://127.0.0.1:4317","token":"SOURCE_WRITE_TOKEN","name":"Laptop","labels":{}}
```

Create source UUID/token through native source setup. Never pass credentials in
command arguments. Commands redact tokens. Without `source.json`, delivery reports
`waiting_configuration` and uploads nothing. Checkpoints, heartbeat health and
quarantine references live under `outbox/`. Retried events retain their original
UUID, timestamp and native payload. Permanent event rejections remain local and
later events continue. Keep storage persistent and private. Changing source UUID
requires a fresh state directory; rotating credentials or endpoint is supported.

Repository `packages/transport/README.md` includes Linux systemd, macOS launchd,
Docker, SSH and private-network supervision examples. Installed workers depend
only on Node built-ins and their own plugin files.
