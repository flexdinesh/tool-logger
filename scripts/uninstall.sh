#!/bin/sh
set -eu
[ -n "${HOME:-}" ] || { printf 'HOME is not set\n' >&2; exit 1; }
data_home=${XDG_DATA_HOME:-$HOME/.local/share}
case "$data_home" in /*) ;; *) printf 'XDG_DATA_HOME must be absolute\n' >&2; exit 1;; esac
# Stop collection before removing its executable. Preserve all state and plugin
# bundles: harness registrations and a later reinstall still reference them.
for directory in "$HOME/.local/bin" "$HOME/bin"; do
  if [ -x "$directory/tool-logger" ]; then "$directory/tool-logger" server stop; fi
  rm -f "$directory/tool-logger" "$directory/tool-logger-desktop"
done
rm -rf "$data_home/tool-logger/desktop"
entry="$data_home/applications/tool-logger.desktop"
if [ -f "$entry" ] && grep -q '^X-Tool-Logger-Installer=1$' "$entry"; then rm -f "$entry"; fi
application="$HOME/Applications/Tool Logger.app"
if [ -L "$application" ] && [ "$(readlink "$application")" = "$data_home/tool-logger/desktop/Tool Logger.app" ]; then rm "$application"; fi
printf 'Removed CLI and desktop. State, plugin registrations, bundles and backups retained.\n'
