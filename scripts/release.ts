import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, object, readJson } from '../packages/installer/index.ts';

export const ROOT = resolve(import.meta.dirname, '..');
export const TARGETS = ['linux/amd64', 'linux/arm64', 'darwin/amd64', 'darwin/arm64'];

export function validateVersion(version: string): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:dev|edge(?:\.[a-f0-9]{12,40})?))?$/.test(version)) {
    throw new Error(`invalid release version: ${version}`);
  }
}

// Edge omits macOS Intel. Each caller of build.yaml passes the matching matrix.
export function releaseTargets(version: string): string[] {
  validateVersion(version);
  return version.includes('-edge') ? TARGETS.filter((value) => value !== 'darwin/amd64') : TARGETS;
}

function target(version: string, os: string, arch: string): void {
  if (!releaseTargets(version).includes(`${os}/${arch}`)) throw new Error(`unsupported target for ${version}: ${os}/${arch}`);
}

function run(command: string, args: string[], cwd = ROOT, environment = process.env): void {
  execFileSync(command, args, { cwd, env: environment, stdio: 'inherit' });
}

function metadata(root = ROOT): { version?: never; commit: string; date: string } {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  return { commit: git(['rev-parse', 'HEAD']), date: git(['show', '-s', '--format=%cI', 'HEAD']) };
}

function flags(version: string): string {
  const { commit, date } = metadata();
  return `-s -w -X main.version=${version} -X main.commit=${commit.slice(0, 12)} -X main.date=${date}`;
}

function stage(out: string, action: (directory: string) => void): void {
  mkdirSync(out, { recursive: true });
  const directory = mkdtempSync(join(out, '.stage-'));
  try { action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function tar(directory: string, name: string, out: string): string {
  const path = join(out, `${name}.tar.gz`);
  run('tar', ['-czf', path, '-C', directory, name]);
  return path;
}

export function bundlePlugins(version: string, output: string, root = ROOT): string {
  validateVersion(version);
  check(root);
  const out = resolve(output);
  const name = `tool-logger-plugins_${version}`;
  stage(out, (directory) => {
    const bundle = join(directory, name);
    mkdirSync(join(bundle, '.agents/plugins'), { recursive: true });
    cpSync(join(root, '.agents/plugins/marketplace.json'), join(bundle, '.agents/plugins/marketplace.json'));
    cpSync(join(root, 'plugins'), join(bundle, 'plugins'), {
      recursive: true, dereference: true,
      filter: (path) => !['node_modules', '.git'].includes(path.split(/[\\/]/).at(-1) ?? ''),
    });
    mkdirSync(join(bundle, 'packages/installer'), { recursive: true });
    cpSync(join(root, 'packages/installer/index.ts'), join(bundle, 'packages/installer/index.ts'));
    cpSync(join(root, 'install.ts'), join(bundle, 'install.ts'));
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ private: true, type: 'module', engines: { node: '26.x' } }) + '\n');
    writeFileSync(join(bundle, 'release.json'), JSON.stringify({ version, ...metadata(root) }, null, 2) + '\n');
    check(bundle);
    tar(directory, name, out);
  });
  return join(out, `${name}.tar.gz`);
}

export function buildCLI(version: string, os: string, arch: string, output: string): string {
  target(version, os, arch);
  const out = resolve(output);
  const name = `tool-logger_${version}_${os}_${arch}`;
  stage(out, (directory) => {
    const destination = join(directory, name);
    mkdirSync(destination);
    run('go', ['build', '-trimpath', '-ldflags', flags(version), '-o', join(destination, 'tool-logger'), './apps/cli'],
      ROOT, { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0' });
    if (os === 'darwin' && process.platform === 'darwin') {
      run('codesign', ['--force', '--sign', '-', join(destination, 'tool-logger')]);
    }
    cpSync(join(ROOT, 'README.md'), join(destination, 'README.md'));
    if (existsSync(join(ROOT, 'LICENSE'))) cpSync(join(ROOT, 'LICENSE'), join(destination, 'LICENSE'));
    writeFileSync(join(destination, 'release.json'), JSON.stringify({ version, ...metadata() }, null, 2) + '\n');
    tar(directory, name, out);
  });
  return join(out, `${name}.tar.gz`);
}

export function buildDesktop(version: string, os: string, arch: string, output: string): string {
  target(version, os, arch);
  if (os === 'darwin' && process.platform !== 'darwin') throw new Error('macOS packaging requires macOS signing tools');
  const out = resolve(output);
  const name = `tool-logger-desktop_${version}_${os}_${arch}`;
  const cliName = `tool-logger_${version}_${os}_${arch}`;
  assert.ok(existsSync(join(out, `${cliName}.tar.gz`)), 'build matching CLI archive first');
  // A temporary MyGo project within the module avoids rewriting the shared
  // desktop config. Bundle the exact CLI bytes already packaged for this target.
  const project = mkdtempSync(join(ROOT, 'apps/desktop/.release-'));
  try {
    mkdirSync(join(project, 'cli'));
    run('tar', ['-xzf', join(out, `${cliName}.tar.gz`), '-C', join(project, 'cli')]);
    const cli = join(project, 'cli', cliName, 'tool-logger');
    mkdirSync(join(project, 'resources/bin'), { recursive: true });
    cpSync(cli, join(project, 'resources/bin/tool-logger'));
    const config = readJson(join(ROOT, 'apps/desktop/mygo.json'));
    writeFileSync(join(project, 'mygo.json'), JSON.stringify({
      ...config, name: 'Tool Logger', slug: 'tool-logger-desktop', version,
      main: '../cmd/tool-logger-desktop', out: 'build', bindings: '',
      buildCommand: '', devCommand: '', frontendDist: '',
    }, null, 2) + '\n');
    run('go', ['tool', 'mygo', 'build', '-platform', `${os}/${arch}`, '-skip-build-command', '-skip-dmg'],
      project, { ...process.env, CGO_ENABLED: '0', MYGO_LDFLAGS: flags(version) });
    stage(out, (directory) => {
      const destination = join(directory, name);
      mkdirSync(destination);
      cpSync(cli, join(destination, 'tool-logger'));
      chmodSync(join(destination, 'tool-logger'), 0o755);
      writeFileSync(join(destination, 'release.json'), JSON.stringify({ version, ...metadata() }, null, 2) + '\n');
      const built = join(project, 'build', `${os}-${arch}`);
      if (os === 'linux') {
        cpSync(join(built, 'tool-logger-desktop'), join(destination, 'tool-logger-desktop'));
        chmodSync(join(destination, 'tool-logger-desktop'), 0o755);
        // Resource CLI is also available next to the MyGo executable.
        cpSync(join(built, 'bin'), join(destination, 'bin'), { recursive: true });
        tar(directory, name, out);
      } else {
        const app = join(destination, 'Tool Logger.app');
        cpSync(join(built, 'Tool Logger.app'), app, { recursive: true });
        const contents = join(app, 'Contents');
        // MyGo names its macOS executable after the display name. The CLI
        // locates a stable companion filename; double-clicking the app needs
        // its headless companion alongside that executable as well.
        renameSync(join(contents, 'MacOS/Tool Logger'), join(contents, 'MacOS/tool-logger-desktop'));
        cpSync(cli, join(contents, 'MacOS/tool-logger'));
        cpSync(cli, join(contents, 'Resources/bin/tool-logger'));
        run('plutil', ['-replace', 'CFBundleExecutable', '-string', 'tool-logger-desktop', join(contents, 'Info.plist')]);
        // Nested CLI files already carry the archive's ad hoc signature.
        // Re-seal the app after layout changes without changing their bytes.
        run('codesign', ['--force', '--sign', '-', app]);
        run('codesign', ['--verify', '--deep', '--strict', app]);
        run('ditto', ['-c', '-k', '--keepParent', destination, join(out, `${name}.zip`)]);
      }
    });
  } finally { rmSync(project, { recursive: true, force: true }); }
  return join(out, `${name}.${os === 'linux' ? 'tar.gz' : 'zip'}`);
}

export function expectedAssets(version: string): string[] {
  return [
    `tool-logger-plugins_${version}.tar.gz`,
    ...releaseTargets(version).flatMap((value) => {
      const [os, arch] = value.split('/');
      return [`tool-logger_${version}_${os}_${arch}.tar.gz`,
        `tool-logger-desktop_${version}_${os}_${arch}.${os === 'linux' ? 'tar.gz' : 'zip'}`];
    }),
  ].sort();
}

export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeChecksums(version: string, directory: string): void {
  const expected = expectedAssets(version);
  const found = readdirSync(directory).filter((name) => !['checksums.txt', 'release.json'].includes(name)).sort();
  assert.deepEqual(found, expected, 'release asset set differs');
  const checksums = expected.map((name) => {
    const path = join(directory, name);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `not a regular asset: ${name}`);
    return `${sha256(path)}  ${name}\n`;
  }).join('');
  writeFileSync(join(directory, 'checksums.txt'), checksums);
  writeFileSync(join(directory, 'release.json'), JSON.stringify({
    version, ...metadata(), checksumsSha256: sha256(join(directory, 'checksums.txt')),
  }, null, 2) + '\n');
  verifyAssets(directory);
}

export function verifyAssets(directory: string): void {
  const metadata = object(JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8')));
  assert.equal(typeof metadata.version, 'string');
  const version = String(metadata.version);
  const expected = expectedAssets(version);
  assert.deepEqual(readdirSync(directory).sort(), [...expected, 'checksums.txt', 'release.json'].sort(), 'unexpected release assets');
  assert.equal(sha256(join(directory, 'checksums.txt')), metadata.checksumsSha256, 'manifest revision mismatch');
  const checksums = expected.map((name) => `${sha256(join(directory, name))}  ${name}\n`).join('');
  assert.equal(readFileSync(join(directory, 'checksums.txt'), 'utf8'), checksums, 'release checksum mismatch');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, version, os, arch, output] = process.argv.slice(2);
    if (command === 'verify' && version && !os) verifyAssets(resolve(version));
    else if (command === 'plugins' && version && os && !arch) bundlePlugins(version, os);
    else if (command === 'checksums' && version && os && !arch) writeChecksums(version, resolve(os));
    else if ((command === 'cli' || command === 'desktop') && version && os && arch && output) {
      if (command === 'cli') buildCLI(version, os, arch, output);
      else buildDesktop(version, os, arch, output);
    } else throw new Error('usage: release.ts plugins|checksums VERSION OUT | cli|desktop VERSION OS ARCH OUT | verify OUT');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  }
}
