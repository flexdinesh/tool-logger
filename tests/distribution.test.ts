import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  ROOT, buildCLI, buildDesktop, bundlePlugins, expectedAssets, releaseTargets, sha256, validateVersion, verifyAssets, writeChecksums,
} from '../scripts/release.ts';

const VERSION = '1.2.3';

function executable(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source); chmodSync(path, 0o755);
}

function fixture(t: TestContext) {
  mkdirSync(join(ROOT, '.scratch'), { recursive: true });
  const temporary = mkdtempSync(join(ROOT, '.scratch/distribution-test-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const home = join(temporary, 'home with spaces');
  const bin = join(temporary, 'bin');
  const assets = join(temporary, 'assets');
  const staging = join(temporary, 'staging');
  mkdirSync(home); mkdirSync(bin); mkdirSync(assets); mkdirSync(staging);
  const environment = {
    ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config/opencode'),
    TOOL_LOGGER_STATE_DIR: join(home, 'state'), PATH: `${bin}:${process.env.PATH}`,
    FIXTURE_ASSETS: assets, FIXTURE_BIN: bin, FIXTURE_OS: 'Linux', FIXTURE_ARCH: 'x86_64',
    TOOL_LOGGER_VERSION: VERSION, OPENCODE_V1_ONLY: '',
  };
  executable(join(bin, 'uname'), '#!/bin/sh\nif [ "$1" = -s ]; then printf "%s\\n" "$FIXTURE_OS"; else printf "%s\\n" "$FIXTURE_ARCH"; fi\n');
  // Only local fixture downloads. No network access or package managers.
  executable(join(bin, 'curl'), `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2); const output = args[args.indexOf('-o') + 1];
const url = args.at(-1); const name = url.split('/').at(-1);
fs.appendFileSync(path.join(process.env.HOME, 'downloads.log'), url + '\\n');
if (name === 'latest') fs.writeFileSync(output, '{"tag_name":"v${VERSION}"}');
else fs.copyFileSync(path.join(process.env.FIXTURE_ASSETS, name), output);
`);
  executable(join(bin, 'codex'), `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME, 'codex.log'), JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('codex 1.0.0'); process.exit(0); }
const registration = path.join(process.env.HOME, 'marketplace.path');
if (args[1] === 'marketplace') fs.writeFileSync(registration, args[3]);
else if (args[1] === 'add') {
  const root = fs.readFileSync(registration, 'utf8');
  const source = path.join(root, 'plugins/codex-tool-logger');
  const version = JSON.parse(fs.readFileSync(path.join(source, '.codex-plugin/plugin.json'))).version;
  fs.cpSync(source, path.join(process.env.CODEX_HOME, 'plugins/cache/tool-logger/codex-tool-logger', version), {recursive:true});
} else process.exit(2);
`);
  executable(join(bin, 'opencode'), '#!/bin/sh\nprintf "opencode 1.18.0\\n"\n');
  executable(join(bin, 'opencode2'), '#!/bin/sh\n[ -z "$OPENCODE_V1_ONLY" ] || exit 1\nprintf "opencode2 2.0.0\\n"\n');
  const mockCLI = '#!/bin/sh\nset -eu\nif [ "$1" = --version ]; then printf "tool-logger 1.2.3 fixture\\n"; exit 0; fi\nprintf "%s\\n" "$@" >> "$HOME/cli.log"\nif [ "$1" = plugins ]; then node "$5/install.ts" "$3"; fi\n';
  const archive = (name: string, desktop: boolean, os: string) => {
    const directory = join(staging, name);
    mkdirSync(directory);
    executable(join(directory, 'tool-logger'), mockCLI);
    if (desktop) {
      if (os === 'linux') executable(join(directory, 'tool-logger-desktop'), '#!/bin/sh\nexit 0\n');
      else executable(join(directory, 'Tool Logger.app/Contents/MacOS/tool-logger-desktop'), '#!/bin/sh\nexit 0\n');
    }
    if (desktop && os === 'darwin') execFileSync('zip', ['-qr', join(assets, `${name}.zip`), name], { cwd: staging });
    else execFileSync('tar', ['-czf', join(assets, `${name}.tar.gz`), '-C', staging, name]);
  };
  for (const os of ['linux', 'darwin']) for (const arch of ['amd64', 'arm64']) {
    archive(`tool-logger_${VERSION}_${os}_${arch}`, false, os);
    archive(`tool-logger-desktop_${VERSION}_${os}_${arch}`, true, os);
  }
  bundlePlugins(VERSION, assets);
  writeChecksums(VERSION, assets);
  const app = join(environment.XDG_DATA_HOME, 'tool-logger');
  const run = (script: string, args: string[] = [], overrides: Record<string, string> = {}) => spawnSync('sh', [join(ROOT, 'scripts', script), ...args], {
    env: { ...environment, ...overrides }, encoding: 'utf8', timeout: 30_000,
  });
  return { temporary, home, bin, assets, app, environment, run };
}

function success(result: ReturnType<typeof spawnSync>): void {
  assert.equal(result.status, 0, `${String(result.stdout)}\n${String(result.stderr)}`);
}

function regularTree(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, `unfingerprintable file: ${entry.name}`);
    if (entry.isDirectory()) regularTree(join(path, entry.name));
  }
}

test('release asset set covers four CLI/desktop targets and a standalone plugin bundle', () => {
  assert.equal(expectedAssets(VERSION).length, 9);
  assert.ok(expectedAssets('0.0.0-edge.abcdef123456').includes('tool-logger_0.0.0-edge.abcdef123456_linux_arm64.tar.gz'));
  for (const version of ['', '../escape', '1.2', '01.2.3', '1.2.3;touch bad']) assert.throws(() => validateVersion(version));
});

test('edge release omits macOS Intel while stable keeps it', () => {
  const edge = '0.0.0-edge.abcdef123456';
  assert.equal(expectedAssets(edge).length, 7);
  assert.equal(expectedAssets(edge).some((name) => name.includes('darwin_amd64')), false);
  assert.ok(expectedAssets(edge).includes(`tool-logger-desktop_${edge}_darwin_arm64.zip`));
  assert.ok(expectedAssets(VERSION).includes(`tool-logger-desktop_${VERSION}_darwin_amd64.zip`));
  assert.throws(() => buildCLI(edge, 'darwin', 'amd64', 'unused'), /unsupported target/);
  assert.throws(() => buildDesktop(edge, 'darwin', 'amd64', 'unused'), /unsupported target/);
});

for (const { workflow, version } of [
  { workflow: 'edge.yaml', version: '0.0.0-edge.abcdef123456' },
  { workflow: 'release.yaml', version: VERSION },
]) {
  test(`${workflow} builds exactly the targets its release requires`, () => {
    const source = readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8');
    const built = [...source.matchAll(/"os":"(\w+)","arch":"(\w+)"/g)].map(([, os, arch]) => `${os}/${arch}`);
    assert.deepEqual(built.sort(), [...releaseTargets(version)].sort());
  });
}

test('checksum generation requires exact complete assets and verification detects changes', (t) => {
  const f = fixture(t);
  verifyAssets(f.assets);
  const asset = join(f.assets, `tool-logger_${VERSION}_linux_amd64.tar.gz`);
  writeFileSync(asset, 'corrupted');
  assert.throws(() => verifyAssets(f.assets), /checksum mismatch/);
  writeFileSync(join(f.assets, 'unexpected'), 'extra');
  assert.throws(() => writeChecksums(VERSION, f.assets), /asset set differs/);
  rmSync(join(f.assets, 'unexpected'));
  rmSync(asset);
  assert.throws(() => writeChecksums(VERSION, f.assets), /asset set differs/);
});

for (const script of ['install.sh', 'install-edge.sh', 'install-desktop.sh', 'install-desktop-edge.sh', 'install-plugins.sh', 'install-plugins-edge.sh']) {
  test(`${script} installs verified prebuilt assets with no repository/build dependency`, (t) => {
    const f = fixture(t);
    const plugin = script.includes('plugins');
    success(f.run(script, plugin ? ['all'] : []));
    const installed = join(f.home, '.local/bin/tool-logger');
    assert.ok(lstatSync(installed).isFile());
    assert.ok(execFileSync(installed, ['--version'], { encoding: 'utf8' }).includes(VERSION));
    const downloads = readFileSync(join(f.home, 'downloads.log'), 'utf8');
    assert.ok(downloads.includes(script.includes('edge') ? '/download/edge/' : `/download/v${VERSION}/`));
    if (script.includes('desktop')) assert.ok(existsSync(join(f.home, '.local/bin/tool-logger-desktop')));
    if (plugin) {
      assert.ok(existsSync(join(f.app, 'plugins/install.ts')));
      assert.equal(realpathSync(join(f.home, '.config/opencode/plugins/opencode-tool-logger.ts')),
        join(f.app, 'plugins/plugins/opencode-tool-logger/v2.ts'));
      const calls = readFileSync(join(f.home, 'cli.log'), 'utf8');
      assert.equal(calls, `plugins\ninstall\nall\n--bundle\n${f.app}/plugins\n`);
      regularTree(join(f.home, '.codex/plugins/cache'));
    }
    assert.equal(existsSync(join(f.app, 'install.lock')), false);
  });
}

for (const [os, arch] of [['Linux', 'aarch64'], ['Darwin', 'x86_64'], ['Darwin', 'arm64']]) {
  test(`desktop fixture installs ${os}/${arch}, including matching companion`, (t) => {
    const f = fixture(t);
    success(f.run('install-desktop.sh', [], { FIXTURE_OS: os ?? '', FIXTURE_ARCH: arch ?? '' }));
    assert.ok(existsSync(join(f.home, '.local/bin/tool-logger-desktop')));
    if (os === 'Darwin') assert.ok(lstatSync(join(f.home, 'Applications/Tool Logger.app')).isSymbolicLink());
    else assert.ok(readFileSync(join(f.environment.XDG_DATA_HOME, 'applications/tool-logger.desktop'), 'utf8').includes('Exec="'));
    assert.equal(sha256(join(f.home, '.local/bin/tool-logger')), sha256(join(f.app, 'desktop/tool-logger')));
  });
}

test('latest stable resolution works without a pinned version', (t) => {
  const f = fixture(t);
  success(f.run('install.sh', [], { TOOL_LOGGER_VERSION: '' }));
  assert.ok(readFileSync(join(f.home, 'downloads.log'), 'utf8').includes('/releases/latest'));
});

test('Codex updates preserve trust/config, backup snapshots and keep persistent worker paths', (t) => {
  const f = fixture(t);
  const trust = join(f.home, '.codex/config.toml');
  mkdirSync(dirname(trust), { recursive: true });
  writeFileSync(trust, '# user trust is managed by Codex\n');
  const source = join(f.home, 'state/source.json');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, '{"sourceId":"existing-identity"}\n');
  success(f.run('install-plugins.sh', ['codex']));
  const cached = join(f.home, '.codex/plugins/cache/tool-logger/codex-tool-logger/0.2.0');
  writeFileSync(join(cached, 'previous-copy'), 'preserve me');
  success(f.run('install-plugins.sh', ['codex']));
  assert.equal(existsSync(join(cached, 'previous-copy')), false);
  const backups = join(f.home, '.codex/plugins/local-link-backups');
  assert.ok(readdirSync(backups).some((entry) => existsSync(join(backups, entry, 'previous-copy'))));
  assert.equal(readFileSync(trust, 'utf8'), '# user trust is managed by Codex\n');
  assert.equal(readFileSync(source, 'utf8'), '{"sourceId":"existing-identity"}\n');
  assert.ok(existsSync(join(f.app, 'plugins/plugins/codex-tool-logger/transport/cli.ts')));
  regularTree(cached);
  const calls = readFileSync(join(f.home, 'codex.log'), 'utf8').split('\n');
  assert.equal(calls.filter((line) => line.includes('"plugin","add"')).length, 1);
  assert.equal(readdirSync(join(f.app, 'backups')).length, 2);
});

test('OpenCode V1 installs and an owned link upgrades to V2', (t) => {
  const f = fixture(t);
  success(f.run('install-plugins.sh', ['opencode'], { OPENCODE_V1_ONLY: '1' }));
  const destination = join(f.home, '.config/opencode/plugins/opencode-tool-logger.ts');
  assert.ok(realpathSync(destination).endsWith('/v1.ts'));
  success(f.run('install-plugins.sh', ['opencode']));
  assert.ok(realpathSync(destination).endsWith('/v2.ts'));
});

test('standalone extracted bundle installs without scripts/workspace.ts or node_modules', (t) => {
  const f = fixture(t);
  const extracted = join(f.temporary, 'unpacked'); mkdirSync(extracted);
  execFileSync('tar', ['-xzf', join(f.assets, `tool-logger-plugins_${VERSION}.tar.gz`), '-C', extracted]);
  const bundle = join(extracted, `tool-logger-plugins_${VERSION}`);
  assert.equal(existsSync(join(bundle, 'scripts/workspace.ts')), false);
  assert.equal(existsSync(join(bundle, 'node_modules')), false);
  const result = spawnSync(process.execPath, [join(bundle, 'install.ts'), 'all'], { env: f.environment, cwd: f.home, encoding: 'utf8' });
  success(result);
  assert.ok(result.stdout.includes('/hooks'));
  regularTree(bundle);
  const bad = spawnSync(process.execPath, [join(bundle, 'install.ts'), 'invalid'], { env: f.environment, encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /usage:/);
});

test('checksum failure leaves installed CLI, plugins and state intact', (t) => {
  const f = fixture(t);
  success(f.run('install-plugins.sh', ['all']));
  const cli = join(f.home, '.local/bin/tool-logger');
  const original = sha256(cli);
  writeFileSync(join(f.assets, `tool-logger_${VERSION}_linux_amd64.tar.gz`), 'wrong content');
  const result = f.run('install-plugins.sh', ['all']);
  assert.equal(result.status, 1); assert.match(result.stderr, /checksum mismatch/);
  assert.equal(sha256(cli), original);
  assert.equal(readdirSync(join(f.app, 'backups')).length, 1);
  assert.ok(existsSync(join(f.app, 'plugins/install.ts')));
});

test('mixed edge metadata/manifest is rejected before installed files change', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.assets, 'checksums.txt'), 'new revision manifest');
  const result = f.run('install-edge.sh');
  assert.equal(result.status, 1); assert.match(result.stderr, /release changed during download/);
  assert.equal(existsSync(join(f.home, '.local/bin/tool-logger')), false);
});

for (const script of ['install-edge.sh', 'install-desktop-edge.sh', 'install-plugins-edge.sh']) {
  test(`${script} refuses Intel Macs before any downloads`, (t) => {
    const f = fixture(t);
    const result = f.run(script, [], { FIXTURE_OS: 'Darwin', FIXTURE_ARCH: 'x86_64' });
    assert.equal(result.status, 1); assert.match(result.stderr, /no macOS Intel build/);
    assert.equal(existsSync(join(f.home, 'downloads.log')), false);
  });
}

test('stable installer still installs on Intel Macs', (t) => {
  const f = fixture(t);
  success(f.run('install.sh', [], { FIXTURE_OS: 'Darwin', FIXTURE_ARCH: 'x86_64' }));
  assert.ok(readFileSync(join(f.home, 'downloads.log'), 'utf8').includes(`tool-logger_${VERSION}_darwin_amd64.tar.gz`));
});

test('missing Node 26 is reported before any downloads', (t) => {
  const f = fixture(t);
  executable(join(f.bin, 'node'), '#!/bin/sh\nprintf "25\\n"\n');
  const result = f.run('install-plugins.sh', ['codex']);
  assert.equal(result.status, 1); assert.match(result.stderr, /Node.js 26/);
  assert.equal(existsSync(join(f.home, 'downloads.log')), false);
});

test('unrelated OpenCode config files are retained and setup failure propagates', (t) => {
  const f = fixture(t);
  const unrelated = join(f.home, '.config/opencode/plugins/opencode-tool-logger.ts');
  mkdirSync(dirname(unrelated), { recursive: true }); writeFileSync(unrelated, 'user plugin');
  const result = f.run('install-plugins.sh', ['opencode']);
  assert.equal(result.status, 1); assert.match(result.stderr, /refusing to replace unrelated path/);
  assert.equal(readFileSync(unrelated, 'utf8'), 'user plugin');
});

test('uninstall stops collection and retains source, journals, bundles and registrations', (t) => {
  const f = fixture(t);
  success(f.run('install-desktop.sh', ['all']));
  const state = join(f.home, 'state'); mkdirSync(join(state, 'outbox'), { recursive: true });
  writeFileSync(join(state, 'source.json'), 'identity');
  writeFileSync(join(state, 'outbox/events.jsonl'), 'evidence\n');
  success(f.run('uninstall.sh'));
  assert.equal(existsSync(join(f.home, '.local/bin/tool-logger')), false);
  assert.equal(existsSync(join(f.app, 'desktop')), false);
  assert.equal(existsSync(join(f.environment.XDG_DATA_HOME, 'applications/tool-logger.desktop')), false);
  assert.ok(existsSync(join(f.app, 'plugins/install.ts')));
  assert.ok(existsSync(join(f.home, '.codex/plugins/cache')));
  assert.equal(readFileSync(join(state, 'source.json'), 'utf8'), 'identity');
  assert.equal(readFileSync(join(state, 'outbox/events.jsonl'), 'utf8'), 'evidence\n');
  assert.ok(readFileSync(join(f.home, 'cli.log'), 'utf8').endsWith('server\nstop\n'));
});

test('packaging commands use root Go targets, release stamps and byte-identical desktop CLI', (t) => {
  const f = fixture(t);
  const out = join(f.temporary, 'packaged');
  const log = join(f.temporary, 'build.log');
  executable(join(f.bin, 'codesign'), '#!/bin/sh\nexit 0\n');
  executable(join(f.bin, 'go'), `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd:process.cwd(), os:process.env.GOOS, arch:process.env.GOARCH, flags:process.env.MYGO_LDFLAGS}) + '\\n');
if (args[0] === 'build') {
  fs.writeFileSync(args[args.indexOf('-o') + 1], 'fixture CLI bytes');
} else {
  const config = JSON.parse(fs.readFileSync('mygo.json', 'utf8'));
  if (config.main !== '../cmd/tool-logger-desktop' || config.version !== '${VERSION}') process.exit(3);
  const target = args[args.indexOf('-platform') + 1].replace('/', '-');
  const built = path.join('build', target);
  fs.mkdirSync(built, {recursive:true});
  fs.writeFileSync(path.join(built, 'tool-logger-desktop'), 'fixture desktop bytes');
  fs.cpSync('resources/bin', path.join(built, 'bin'), {recursive:true});
}
`);
  const previous = process.env.PATH;
  process.env.PATH = f.environment.PATH;
  try {
    for (const os of ['linux', 'darwin']) for (const arch of ['amd64', 'arm64']) {
      buildCLI(VERSION, os, arch, out);
    }
    const config = readFileSync(join(ROOT, 'apps/desktop/mygo.json'));
    buildDesktop(VERSION, 'linux', 'amd64', out);
    assert.deepEqual(readFileSync(join(ROOT, 'apps/desktop/mygo.json')), config);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
  const extracted = join(f.temporary, 'desktop-package'); mkdirSync(extracted);
  execFileSync('tar', ['-xzf', join(out, `tool-logger-desktop_${VERSION}_linux_amd64.tar.gz`), '-C', extracted]);
  const desktop = join(extracted, `tool-logger-desktop_${VERSION}_linux_amd64`);
  assert.equal(readFileSync(join(desktop, 'tool-logger'), 'utf8'), 'fixture CLI bytes');
  assert.equal(sha256(join(desktop, 'tool-logger')), sha256(join(desktop, 'bin/tool-logger')));
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('./apps/cli'));
  assert.ok(calls.includes('-X main.version=1.2.3'));
  assert.ok(calls.includes('-X main.commit='));
  assert.ok(calls.includes('-X main.date='));
  assert.ok(calls.includes('darwin') && calls.includes('arm64'));
  assert.equal(readdirSync(join(ROOT, 'apps/desktop')).some((name) => name.startsWith('.release-')), false);
});

function publicationFixture(t: TestContext, mode: 'stable' | 'edge', scenario: string) {
  const f = fixture(t);
  const log = join(f.temporary, 'publish.log');
  const candidate = 'a'.repeat(40);
  const previous = 'b'.repeat(40);
  executable(join(f.bin, 'git'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(['git', ...args]) + '\\n');
if (args[0] === 'ls-remote') process.exit(scenario === 'first' ? 2 : 0);
if (args[0] === 'rev-parse') console.log('${previous}');
if (args[0] === 'merge-base') {
  const toMain = args[3] === 'origin/main';
  process.exit(toMain ? (scenario === 'off-main' ? 1 : 0)
    : args[2] === '${candidate}' ? (scenario === 'stale' ? 0 : 1)
    : scenario === 'divergent' ? 1 : 0);
}
`);
  executable(join(f.bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(['gh', ...args]) + '\\n');
if (args[1] === 'view') {
  if (args.includes('--json')) console.log('obsolete.tar.gz\\nrelease.json');
  else process.exit(${JSON.stringify(scenario)} === 'first' ? 1 : 0);
}
`);
  const workflow = readFileSync(join(ROOT, '.github/workflows', mode === 'edge' ? 'edge.yaml' : 'release.yaml'), 'utf8');
  const start = workflow.lastIndexOf('        run: |\n');
  assert.ok(start > 0);
  const script = workflow.slice(start + '        run: |\n'.length).replace(/^          /gm, '');
  const path = join(f.temporary, 'publish.sh'); writeFileSync(path, script);
  mkdirSync(join(f.temporary, 'release-dist'));
  for (const asset of ['fixture.tar.gz', 'fixture.zip', 'checksums.txt', 'release.json']) {
    writeFileSync(join(f.temporary, 'release-dist', asset), 'fixture');
  }
  const result = spawnSync('bash', [path], {
    cwd: f.temporary, env: { ...f.environment, COMMIT: candidate, TAG: 'v1.2.3' }, encoding: 'utf8', timeout: 30_000,
  });
  return { result, log: readFileSync(log, 'utf8') };
}

test('stable publication never modifies an existing release', (t) => {
  const { result, log } = publicationFixture(t, 'stable', 'existing');
  success(result);
  assert.equal(log.includes('"create"'), false);
  assert.equal(log.includes('"upload"'), false);
});

test('stable publication creates a new release without clobber', (t) => {
  const { result, log } = publicationFixture(t, 'stable', 'first');
  success(result);
  assert.ok(log.includes('"create","v1.2.3"'));
  assert.ok(log.includes('--verify-tag'));
  assert.equal(log.includes('--clobber'), false);
});

test('stale edge build cannot upload assets or move edge tag', (t) => {
  const { result, log } = publicationFixture(t, 'edge', 'stale');
  success(result);
  assert.match(result.stdout, /Skipping stale edge build/);
  assert.equal(log.includes('"upload"'), false);
  assert.equal(log.includes('"push"'), false);
});

for (const scenario of ['off-main', 'divergent']) {
  test(`edge publication refuses ${scenario} history before mutation`, (t) => {
    const { result, log } = publicationFixture(t, 'edge', scenario);
    assert.equal(result.status, 1);
    assert.equal(log.includes('"upload"'), false);
    assert.equal(log.includes('"push"'), false);
  });
}

for (const scenario of ['newer', 'first']) {
  test(`edge publication ${scenario} uploads complete revision, metadata last, then removes obsolete assets`, (t) => {
    const { result, log } = publicationFixture(t, 'edge', scenario);
    success(result);
    const uploads = log.split('\n').filter((line) => line.includes('"upload"'));
    assert.equal(uploads.length, 2);
    assert.ok(uploads[0]?.includes('checksums.txt'));
    assert.ok(uploads[1]?.includes('release.json'));
    assert.ok(log.indexOf('"push"') > log.indexOf('"upload","edge","release-dist/release.json"'));
    assert.ok(log.includes('"delete-asset","edge","obsolete.tar.gz"'));
    assert.equal(log.includes('"delete-asset","edge","release.json"'), false);
  });
}

test('wget and shasum fallback install without curl, Node or a build tool', (t) => {
  const f = fixture(t);
  rmSync(join(f.bin, 'curl'));
  for (const tool of ['sh', 'sed', 'cut', 'awk', 'shasum', 'tar', 'gzip', 'cp', 'mv', 'chmod', 'mkdir', 'rmdir', 'rm', 'mktemp']) {
    const source = execFileSync('which', [tool], { encoding: 'utf8' }).trim();
    symlinkSync(source, join(f.bin, tool));
  }
  executable(join(f.bin, 'wget'), `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2);
fs.copyFileSync(path.join(process.env.FIXTURE_ASSETS,args.at(-1).split('/').at(-1)),args[args.indexOf('-O')+1]);
`);
  success(f.run('install.sh', [], { PATH: f.bin }));
  assert.ok(existsSync(join(f.home, '.local/bin/tool-logger')));
});

test('archive symlinks fail before replacing installed files', (t) => {
  const f = fixture(t);
  const name = `tool-logger_${VERSION}_linux_amd64`;
  const directory = join(f.temporary, 'unsafe'); mkdirSync(join(directory, name), { recursive: true });
  symlinkSync('/outside', join(directory, name, 'tool-logger'));
  execFileSync('tar', ['-czf', join(f.assets, `${name}.tar.gz`), '-C', directory, name]);
  writeChecksums(VERSION, f.assets);
  const result = f.run('install.sh');
  assert.equal(result.status, 1); assert.match(result.stderr, /links or special files/);
  assert.equal(existsSync(join(f.home, '.local/bin/tool-logger')), false);
});

test('concurrent install lock is respected and existing installation retained', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.app, 'install.lock'), { recursive: true });
  const result = f.run('install.sh');
  assert.equal(result.status, 1); assert.match(result.stderr, /another install is active/);
  assert.ok(existsSync(join(f.app, 'install.lock')));
});

test('CLI reinstall replaces files after verification and restarts a running collector', (t) => {
  const f = fixture(t);
  success(f.run('install.sh'));
  success(f.run('install.sh'));
  assert.equal(readFileSync(join(f.home, 'cli.log'), 'utf8'), 'server\nstatus\nserver\nstop\nserver\nstart\n');
  assert.ok(readdirSync(join(f.app, 'backups')).some((name) => existsSync(join(f.app, 'backups', name, 'cli'))));
});
