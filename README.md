# Tool Logger

Inspect Codex and OpenCode tool calls, full inputs/results and Git context.
MyGo webview desktop for Linux/macOS, with browser fallback and remote viewing.

## Install

Prebuilt stable, Linux/macOS on amd64/arm64. No checkout or build.

```sh
# Desktop and CLI
curl -fsSL https://raw.githubusercontent.com/flexdinesh/tool-logger/main/scripts/install-desktop.sh | sh
# Plugins, local source and supervised worker
curl -fsSL https://raw.githubusercontent.com/flexdinesh/tool-logger/main/scripts/install-plugins.sh | sh -s -- all
```

Use `codex` or `opencode` instead of `all`. Plugins require Node.js 26 and
the selected harness. Restart the harness; Codex requires hook trust in `/hooks`.
Linux desktop needs GTK 3 and WebKitGTK 4.1. macOS packages are ad hoc signed.

CLI only: [install.sh](scripts/install.sh). Rerun installers to update.
[Edge installation](docs/development.md#install-from-main).
[Uninstall](scripts/uninstall.sh) retains state and plugin registrations.

## Use

```sh
tool-logger                     # Desktop; starts independent collector
tool-logger browser             # Explicit browser mode
tool-logger server status
tool-logger server stop          # Stop collection and its worker
```

Closing or quitting the UI leaves collection running. The collector uses a
private Unix socket; each UI window connects to one server.

On an SSH machine:

```sh
tool-logger remote
# If its hostname is not reachable:
tool-logger remote --advertise reachable-host:4317
```

Run the printed `tool-logger connect ...` command on your viewing machine.
Remote mode binds network interfaces on port 4317, uses pinned TLS, and issues
a single-use pairing code valid for ten minutes. Paired clients are revocable
with `tool-logger clients list` and `tool-logger clients revoke <id>`.
Local and remote histories stay separate.

State: `~/.local/state/tool-logger/`, overridden by `TOOL_LOGGER_STATE_DIR`.
Hooks append locally and never wait for HTTP. Collection retains full native
payloads, which may contain private code or credentials. Legacy history is
never imported or modified automatically.

[Development](docs/development.md) · [Architecture](docs/architecture.md) ·
[Source delivery](packages/transport/README.md) · [Releases](docs/release.md)
