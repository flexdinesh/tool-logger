# OpenCode Tool Logger

Local OpenCode V1/V2 plugin. Each native before/after tool event is appended to
`~/.local/state/tool-logger/opencode-tool-calls.jsonl`, or the directory selected
by `TOOL_LOGGER_STATE_DIR`.

From the repository root, run:

```sh
pnpm run link:opencode opencode-tool-logger
```

The linker selects `v1.ts` for OpenCode V1 or `v2.ts` for V2. Both generations
append independently to the same history. Existing activation markers are ignored.
Codex logs are independent.
