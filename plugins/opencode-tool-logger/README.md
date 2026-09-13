# OpenCode Tool Logger

Local OpenCode V1/V2 plugin. Each native before/after tool event is appended to
`~/.local/state/tool-logger/opencode-tool-calls.jsonl`, or the directory selected
by `TOOL_LOGGER_STATE_DIR`.

From the repository root, run:

```sh
pnpm run link:opencode opencode-tool-logger
```

The linker selects `v1.ts` for OpenCode V1 or `v2.ts` for V2. Activating V2
permanently marks the state directory as V2, preserves its existing OpenCode log,
and suppresses all later V1 writes. Codex logs are independent.
