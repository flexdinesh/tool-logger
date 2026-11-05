import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256, validateVersion } from './release.ts';

const [version, os, arch, output] = process.argv.slice(2);
if (!version || !os || !arch || !output) throw new Error('usage: release-smoke.ts VERSION OS ARCH OUT');
validateVersion(version);
const out = resolve(output);
// Unix sockets have a short platform path limit. Keep state near /tmp rather
// than under a potentially long checkout/output path.
const temporary = mkdtempSync(join(tmpdir(), 'tl-smoke-'));
const execute = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', timeout: 30_000 });
try {
  const cliName = `tool-logger_${version}_${os}_${arch}`;
  const desktopName = `tool-logger-desktop_${version}_${os}_${arch}`;
  execute('tar', ['-xzf', join(out, `${cliName}.tar.gz`), '-C', temporary]);
  if (os === 'linux') execute('tar', ['-xzf', join(out, `${desktopName}.tar.gz`), '-C', temporary]);
  else execute('unzip', ['-q', join(out, `${desktopName}.zip`), '-d', temporary]);
  const cli = join(temporary, cliName, 'tool-logger');
  assert.ok(execute(cli, ['--version']).includes(version));
  const desktop = join(temporary, desktopName);
  assert.equal(sha256(cli), sha256(join(desktop, 'tool-logger')), 'desktop must bundle matching CLI');
  const resourceCLI = os === 'linux' ? join(desktop, 'bin/tool-logger')
    : join(desktop, 'Tool Logger.app/Contents/Resources/bin/tool-logger');
  assert.equal(sha256(cli), sha256(resourceCLI), 'MyGo resource CLI must match archive');
  const binary = os === 'linux' ? join(desktop, 'tool-logger-desktop')
    : join(desktop, 'Tool Logger.app/Contents/MacOS/tool-logger-desktop');
  assert.ok(existsSync(binary));
  assert.ok(execute(binary, ['--version']).includes(version));
  // Exercise the extracted headless process without a repository, HOME or
  // display dependency. Collection must remain available across CLI invocations.
  const state = join(temporary, 'state');
  const environment = { ...process.env, TOOL_LOGGER_STATE_DIR: state };
  const call = (args: string[]) => execFileSync(cli, args, { env: environment, encoding: 'utf8', timeout: 30_000 });
  let started = false;
  try {
    call(['server', 'start']);
    started = true;
    const status: unknown = JSON.parse(call(['server', 'status']));
    assert.equal(typeof status, 'object');
    call(['server', 'start']);
  } catch (error) {
    const log = join(state, 'collector/server.log');
    if (existsSync(log)) console.error(readFileSync(log, 'utf8'));
    throw error;
  } finally { if (started) call(['server', 'stop']); }
  assert.ok(readFileSync(join(temporary, cliName, 'release.json'), 'utf8').includes(version));
  console.log(`Extracted CLI and desktop smoke passed: ${os}/${arch} ${version}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
