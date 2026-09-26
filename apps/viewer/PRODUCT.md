# Tool Logger Viewer

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers inspecting their own coding-agent runs. They use tool-call history to understand what happened during a run and examine individual calls when needed.

## Product Purpose

Provide local inspection of unredacted Codex and OpenCode tool activity. The viewer makes recorded calls searchable and explorable through summaries, metrics, and native call details.

## Positioning

The Codex and OpenCode plugins append harness-native events to separate local logs. The read-only viewer projects those records into one query interface while retaining each harness's native payloads and outcome semantics.

## Operating Context

- Runs on the developer's macOS or Linux machine. The server binds to loopback by default; LAN binding is an explicit runtime option.
- Plugins write append-only JSONL files under `~/.local/state/tool-logger/`, or `TOOL_LOGGER_STATE_DIR`. The viewer reads each harness file independently.
- Tool inputs and results may contain unredacted local data. The viewer exposes them to whoever can reach its server.

## Capabilities and Constraints

- Select Codex or OpenCode activity; inspect lifecycle events, call summaries, identifiers, and native payloads.
- Search and filter calls by status, tool, session, time, repository, and directory; filter by agent when available.
- View activity and tool-usage charts, call metrics, source health, and live updates.
- Keep the viewer read-only and preserve separate harness logs. Result presence alone does not prove tool success where the harness does not report an outcome.
- Use the existing Node.js 26, pnpm 11, React, Vite, Tailwind CSS, and shadcn/ui stack.

## Brand Commitments

The product name is Tool Logger. Existing UI language emphasizes local, read-only inspection and precise status labels.

## Evidence on Hand

- The Codex and OpenCode plugins, viewer server, REST API contract, and UI are implemented in this repository.
- Committed synthetic fixtures support viewer development. No customer claims or external proof assets are established.

## Product Principles

1. Make a run's tool activity easy to scan, filter, and inspect.
2. Preserve native context and distinguish observed events from inferred outcomes.
3. Keep log access local and explicit, with no writes from the viewer.
4. Surface incomplete or unreadable source data clearly.

## Accessibility & Inclusion

The existing viewer design system requires WCAG AA contrast, keyboard operation, visible focus, labeled controls, and usable touch targets.
