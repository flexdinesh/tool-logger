# Codex tool logger

Node.js 26 hooks append full native records, silently, to
`~/.local/state/tool-logger/outbox/codex-tool-calls.jsonl`. Set
`TOOL_LOGGER_STATE_DIR` to override the shared source state directory. Existing
root-level journals remain untouched. Records append even before source setup.
The hook uses one local `O_APPEND` write and fsync per record. It performs no HTTP
requests and does not launch background delivery.

Supervise one source worker per state directory. The worker handles both Codex and
OpenCode journals and is copied entirely into this plugin:

```sh
node /absolute/plugin/transport/cli.ts configure /private/source.json
node /absolute/plugin/transport/cli.ts status
node /absolute/plugin/transport/cli.ts run
```

`configure -` accepts JSON through stdin. Configuration shape:

```json
{"schemaVersion":1,"sourceId":"550e8400-e29b-41d4-a716-446655440000","endpoint":"http://127.0.0.1:4317","token":"SOURCE_WRITE_TOKEN","name":"Laptop","labels":{}}
```

Obtain source UUID/token from native source setup. Input files must be private
regular files, mode `0600`. Never pass tokens as command arguments. The worker
atomically writes private `source.json`; command output redacts the token. Without
configuration, status is `waiting_configuration` and records stay local. Tokens,
labels, name and endpoint can be updated; changing UUID requires a new directory.

Worker checkpoints, heartbeat health and quarantine references live under
`outbox/`. Retries preserve event UUID/time; delivered/rejected native bytes are
never deleted. HTTP failures retry with bounded jitter. Permanent event failures
are isolated so later records continue. Status reports backlog, rejection count,
retry/error state and update time. Keep source storage persistent and private.

Repository service templates and complete Linux systemd, macOS launchd, Docker,
SSH and private-network setup are in `packages/transport/README.md`. Installed
delivery imports only sibling files under `transport/`; no repository code is
required at runtime.
