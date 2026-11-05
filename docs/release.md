# Releases

Installed use needs no checkout, npm, pnpm or Go. Publish GitHub release assets
for Linux/macOS, amd64/arm64. Plugin execution requires Node.js 26 and the selected
harness CLI. Desktop packages currently have no Developer ID signing or
notarization; macOS builds use MyGo's ad hoc signature.

## Stable

Tag a tested main commit `vX.Y.Z` and push that tag. `release.yaml` validates the
tag and main ancestry, runs `check.yaml`, calls `build.yaml`, verifies all assets
and creates the release. Both validation and publishing skip an existing release.
Published stable assets are immutable by workflow policy; publish a new patch to
correct them. The workflow uses its scoped GitHub token, no publication secrets.

## Edge

A successful Check run for a push to main triggers `edge.yaml`. Its version is
`0.0.0-edge.<12-character commit>`. The same build workflow makes all targets.
Publishing is serialized and never cancelled midway; an ancestor of the current
edge tag cannot overwrite it. Divergent history fails publication. Archive names
include the revision; `release.json` is uploaded last. Old archives are removed
only after the new revision is available. Edge stays a prerelease and never latest.

## Assets and build commands

Every release contains exactly nine archives, `checksums.txt` and `release.json`:

- `tool-logger_<version>_<linux|darwin>_<amd64|arm64>.tar.gz`
- `tool-logger-desktop_<version>_linux_<amd64|arm64>.tar.gz`
- `tool-logger-desktop_<version>_darwin_<amd64|arm64>.zip`
- `tool-logger-plugins_<version>.tar.gz`

Each archive has a matching named root directory. Desktop archives include the
byte-identical CLI from that target's CLI archive, both at their root and in MyGo
resources (also beside the macOS app executable for direct launches). macOS CLI
archives carry an ad hoc signature before bundling. The plugin archive contains `install.ts`, the Codex marketplace, both
complete plugin snapshots and the shared installer package. It runs with
`node install.ts codex|opencode|all` without repository dependencies. Keep the
extracted bundle at a persistent path; workers and OpenCode reference its files.

```sh
pnpm --filter @tool-logger/web build
node scripts/release.ts cli 0.1.0 linux amd64 release-dist
node scripts/release.ts desktop 0.1.0 linux amd64 release-dist
node scripts/release.ts plugins 0.1.0 release-dist
# After building every target:
node scripts/release.ts checksums 0.1.0 release-dist
node scripts/release.ts verify release-dist
node scripts/release-smoke.ts 0.1.0 linux amd64 release-dist
```

MyGo builds use a temporary config inside the root Go module; the shared desktop
config is not rewritten. macOS packaging needs macOS signing tools. Every target
has a native runner that executes the extracted CLI and version commands, compares
the companion bytes, and starts/stops the actual collector. Native UI process
automation remains in Check. Binaries carry version, commit and commit date.

## Installers

`install.sh` installs CLI; `install-desktop.sh` adds MyGo; `install-plugins.sh`
installs CLI and selected plugins (`codex`, `opencode`, default `all`). Each has an
`-edge.sh` equivalent. CLI/desktop installers also accept an optional harness
selection. `TOOL_LOGGER_VERSION=0.1.0` pins a stable installer.
Linux installs a desktop entry; macOS links the persistent app in ~/Applications.

Downloads verify SHA-256 before installation. `release.json` pins the checksum
manifest, so an edge update during download fails safely before replacing files.
Updates stage files and retain prior files under the installation's `backups/`.
Rerun the installer to update; a running collector is stopped after verification
and restarted with the new CLI/worker. Installation failures retain backups and report the
error; plugin registration across two independent harnesses is not transactional.

Generated shell files must match `scripts/install-template.sh`:

```sh
pnpm installers:sync
pnpm test:distribution
shellcheck scripts/install*.sh scripts/uninstall.sh
actionlint
```

`uninstall.sh` stops the collector, removes installed CLI/desktop executables,
and retains state, plugin registrations, persistent bundles and backups. Disable
plugins through the harness before removing retained bundles manually.
