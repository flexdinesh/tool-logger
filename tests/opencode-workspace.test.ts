import assert from 'node:assert/strict';
import {
  lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  detectOpenCodeGeneration, linkOpenCodePlugin, openCodeConfigDirectory, writeJson,
} from '../scripts/workspace.ts';

function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'opencode workspace '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'repo');
  const source = join(root, 'plugins/opencode-tool-logger');
  mkdirSync(source, { recursive: true });
  writeJson(join(source, 'package.json'), {
    name: 'opencode-tool-logger', private: true, type: 'module',
  });
  const v1 = join(source, 'v1.ts');
  const v2 = join(source, 'v2.ts');
  writeFileSync(v1, 'export default function plugin() { return {}; }\n');
  writeFileSync(v2, 'export default { id: "opencode-tool-logger" };\n');
  const configDirectory = join(temp, 'config');
  const destination = join(configDirectory, 'plugins/opencode-tool-logger.ts');
  return { temp, root, source, v1, v2, configDirectory, destination };
}

test('detects OpenCode CLI generation with V2 priority', () => {
  assert.equal(detectOpenCodeGeneration((command) => command === 'opencode' ? 'opencode 1.18.0' : undefined), 1);
  assert.equal(detectOpenCodeGeneration((command) => command === 'opencode2' ? 'opencode2 v0.0.0-beta' : undefined), 2);
  assert.equal(detectOpenCodeGeneration((command) => command === 'opencode' ? '2.0.1' : undefined), 2);
  assert.equal(detectOpenCodeGeneration(() => '1.18.0'), 2);
  assert.throws(() => detectOpenCodeGeneration(() => undefined), /CLI not found/);
  assert.throws(() => detectOpenCodeGeneration(
    (command) => command === 'opencode' ? 'development' : undefined,
  ), /identify OpenCode generation/);
});

test('resolves OpenCode config precedence', () => {
  assert.equal(openCodeConfigDirectory({
    configDirectory: '/explicit',
    environment: { OPENCODE_CONFIG_DIR: '/environment', XDG_CONFIG_HOME: '/xdg' },
    homeDirectory: '/home/example',
  }), '/explicit');
  assert.equal(openCodeConfigDirectory({
    environment: { OPENCODE_CONFIG_DIR: '/environment', XDG_CONFIG_HOME: '/xdg' },
    homeDirectory: '/home/example',
  }), '/environment');
  assert.equal(openCodeConfigDirectory({
    environment: { XDG_CONFIG_HOME: '/xdg' }, homeDirectory: '/home/example',
  }), '/xdg/opencode');
  assert.equal(openCodeConfigDirectory({ environment: {}, homeDirectory: '/home/example' }),
    '/home/example/.config/opencode');
});

test('links exactly one V1 entrypoint without editing config', (t) => {
  const f = fixture(t);
  linkOpenCodePlugin(f.root, 'opencode-tool-logger', {
    configDirectory: f.configDirectory,
    commandVersion: (command) => command === 'opencode' ? '1.18.0' : undefined,
  });
  assert.ok(lstatSync(f.destination).isSymbolicLink());
  assert.equal(realpathSync(f.destination), realpathSync(f.v1));
  assert.deepEqual(readdirSync(dirname(f.destination)), ['opencode-tool-logger.ts']);
  assert.equal(lstatSync(join(f.configDirectory, 'opencode.json'), { throwIfNoEntry: false }), undefined);
});

test('V2 wins, safely replaces an owned V1 link and relinks idempotently', (t) => {
  const f = fixture(t);
  linkOpenCodePlugin(f.root, 'opencode-tool-logger', {
    configDirectory: f.configDirectory,
    commandVersion: (command) => command === 'opencode' ? '1.18.0' : undefined,
  });
  linkOpenCodePlugin(f.root, 'opencode-tool-logger', {
    configDirectory: f.configDirectory,
    commandVersion: () => '0.0.0-beta',
  });
  assert.equal(realpathSync(f.destination), realpathSync(f.v2));
  assert.deepEqual(readdirSync(dirname(f.destination)), ['opencode-tool-logger.ts']);
  const target = readlinkSync(f.destination);
  linkOpenCodePlugin(f.root, 'opencode-tool-logger', {
    configDirectory: f.configDirectory, commandVersion: () => '0.0.0-beta',
  });
  assert.equal(readlinkSync(f.destination), target);
  assert.deepEqual(readdirSync(dirname(f.destination)), ['opencode-tool-logger.ts']);
});

test('refuses unrelated files and links', (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.destination), { recursive: true });
  writeFileSync(f.destination, 'unrelated');
  const options = { configDirectory: f.configDirectory, commandVersion: () => '0.0.0-beta' };
  assert.throws(() => linkOpenCodePlugin(f.root, 'opencode-tool-logger', options), /unrelated path/);
  rmSync(f.destination);
  symlinkSync(f.temp, f.destination);
  assert.throws(() => linkOpenCodePlugin(f.root, 'opencode-tool-logger', options), /unrelated path/);
  assert.equal(realpathSync(f.destination), realpathSync(f.temp));
});

test('fails before creating config when no CLI or entrypoint exists', (t) => {
  const f = fixture(t);
  assert.throws(() => linkOpenCodePlugin(f.root, 'opencode-tool-logger', {
    configDirectory: f.configDirectory, commandVersion: () => undefined,
  }), /CLI not found/);
  assert.equal(lstatSync(f.configDirectory, { throwIfNoEntry: false }), undefined);
  rmSync(f.v2);
  assert.throws(() => linkOpenCodePlugin(f.root, 'opencode-tool-logger', {
    configDirectory: f.configDirectory, commandVersion: () => '0.0.0-beta',
  }), /missing OpenCode V2 entrypoint/);
  assert.equal(lstatSync(f.configDirectory, { throwIfNoEntry: false }), undefined);
});
