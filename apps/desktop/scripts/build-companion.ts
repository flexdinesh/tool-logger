import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { arch, platform } from "node:process";

// Default packaging targets the host. Explicit multi-platform callers must
// request matching companions, e.g. pnpm build:cli linux/amd64 darwin/arm64.
const desktop = resolve(import.meta.dirname, "..");
const requested = process.argv.slice(2);
const targets = requested.length ? requested : [`${platform}/${arch === "x64" ? "amd64" : arch}`];
for (const target of new Set(targets)) {
  if (!/^(linux|darwin)\/(amd64|arm64)$/.test(target)) throw new Error(`Unsupported companion target: ${target}`);
}
for (const target of new Set(targets)) {
  const [goos, goarch] = target.split("/");
  if (!goos || !goarch) throw new Error(`Invalid companion target: ${target}`);
  const directory = resolve(desktop, "resources", goos + "-" + goarch, "bin");
  mkdirSync(directory, { recursive: true });
  execFileSync("go", ["build", "-trimpath", "-o", resolve(directory, "tool-logger"), "../cli"], {
    cwd: desktop, env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch }, stdio: "inherit",
  });
}
