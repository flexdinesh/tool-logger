import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { arch, platform } from 'node:process';
import test from 'node:test';

test('desktop packaging prepares only requested companion targets and rejects invalid targets before building', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tl-companion-targets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts')); mkdirSync(join(directory, 'bin'));
  cpSync(resolve(import.meta.dirname, '../apps/desktop/scripts/build-companion.ts'), join(directory, 'scripts/build-companion.ts'));
  cpSync(resolve(import.meta.dirname, '../apps/desktop/scripts/build-desktop.ts'), join(directory, 'scripts/build-desktop.ts'));
  writeFileSync(join(directory, 'bin/go'), `#!${process.execPath}\nconsole.log(process.env.GOOS + '/' + process.env.GOARCH);\n`, { mode: 0o755 });
  const run = (...targets: string[]) => spawnSync(process.execPath, [join(directory, 'scripts/build-companion.ts'), ...targets], {
    encoding: 'utf8', env: { ...process.env, PATH: join(directory, 'bin') },
  });
  const host = run();
  assert.equal(host.status, 0, host.stderr);
  assert.equal(host.stdout.trim(), `${platform}/${arch === 'x64' ? 'amd64' : arch}`);
  const cross = run('linux/arm64', 'darwin/amd64', 'linux/arm64');
  assert.equal(cross.status, 0, cross.stderr);
  assert.deepEqual(cross.stdout.trim().split('\n'), ['linux/arm64', 'darwin/amd64']);
  const invalid = run('linux/arm64', '../unsafe');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unsupported companion target/);
  assert.equal(invalid.stdout, '');

  writeFileSync(join(directory, 'bin/pnpm'), `#!${process.execPath}\nconsole.log('frontend');\n`, { mode: 0o755 });
  writeFileSync(join(directory, 'bin/go'), `#!${process.execPath}\nif (process.argv[2] === 'build') console.log(process.env.GOOS + '/' + process.env.GOARCH); else console.log('package:' + process.argv.slice(5).join(' '));\n`, { mode: 0o755 });
  const packaged = spawnSync(process.execPath, [join(directory, 'scripts/build-desktop.ts'), '-platform', 'linux/arm64,darwin/amd64'], {
    encoding: 'utf8', env: { ...process.env, PATH: join(directory, 'bin') },
  });
  assert.equal(packaged.status, 0, packaged.stderr);
  assert.deepEqual(packaged.stdout.trim().split('\n'), ['frontend', 'linux/arm64', 'darwin/amd64', 'package:-skip-build-command -platform linux/arm64,darwin/amd64']);
  const prepared = spawnSync(process.execPath, [join(directory, 'scripts/build-desktop.ts'), '--prepared', '-platform=linux/arm64'], {
    encoding: 'utf8', env: { ...process.env, PATH: join(directory, 'bin') },
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(prepared.stdout.trim().split('\n'), ['linux/arm64', 'package:-skip-build-command -platform=linux/arm64']);
});
