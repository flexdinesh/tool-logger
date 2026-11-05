import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// MyGo selects platform resource directories while packaging. Build each CLI
// target so local multi-platform builds cannot accidentally ship a host CLI.
const desktop = resolve(import.meta.dirname, "..");
for (const { goos, goarch } of [
  { goos: "linux", goarch: "amd64" }, { goos: "linux", goarch: "arm64" },
  { goos: "darwin", goarch: "amd64" }, { goos: "darwin", goarch: "arm64" },
]) {
  const directory = resolve(desktop, "resources", goos + "-" + goarch, "bin");
  mkdirSync(directory, { recursive: true });
  execFileSync("go", ["build", "-trimpath", "-o", resolve(directory, "tool-logger"), "../cli"], {
    cwd: desktop, env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch }, stdio: "inherit",
  });
}
