import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const CATALOG = '.agents/plugins/marketplace.json';
type ObjectValue = Record<string, unknown>;
type PluginEntry = ObjectValue & { name: string; source: { source: 'local'; path: string } };
type Catalog = ObjectValue & { name: string; plugins: PluginEntry[] };

export function object(value: unknown): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object');
  }
  return { ...value };
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected a JSON array');
  return value;
}

export function readJson(path: string): ObjectValue {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return object(value);
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('name must be lowercase kebab-case, e.g. my-plugin');
  }
}

function localPath(root: string, value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('./')) {
    throw new Error(`expected ./-prefixed local path: ${String(value)}`);
  }
  const path = realpathSync(resolve(root, value));
  const part = relative(realpathSync(root), path);
  if (!part || part === '..' || part.startsWith('../') || isAbsolute(part)) {
    throw new Error(`path escapes its root: ${value}`);
  }
  return path;
}

export function check(root: string): Catalog {
  const catalog = readJson(join(root, CATALOG));
  const name = catalog.name;
  validateName(name);
  const directories = readdirSync(join(root, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const codexNames = new Set<string>();
  for (const directory of directories) {
    validateName(directory);
    const plugin = join(root, 'plugins', directory);
    const packageJson = readJson(join(plugin, 'package.json'));
    if (packageJson.name !== directory || packageJson.private !== true) {
      throw new Error(`${directory}: package name/private mismatch`);
    }
    const marker = lstatSync(join(plugin, '.codex-plugin'), { throwIfNoEntry: false });
    if (marker && !marker.isDirectory()) throw new Error(`${directory}: .codex-plugin must be a directory`);
    if (marker) codexNames.add(directory);
  }
  const seen = new Set<string>();
  const plugins = array(catalog.plugins).map((value): PluginEntry => {
    const entry = object(value);
    const pluginName = entry.name;
    validateName(pluginName);
    if (seen.has(pluginName)) throw new Error(`duplicate plugin: ${pluginName}`);
    seen.add(pluginName);
    const source = object(entry.source);
    if (source.source !== 'local' || typeof source.path !== 'string') {
      throw new Error(`${pluginName}: this workspace uses local plugins`);
    }
    const plugin = localPath(root, source.path);
    if (plugin !== realpathSync(join(root, 'plugins', pluginName))) {
      throw new Error(`${pluginName}: expected plugins/${pluginName}`);
    }
    const policy = object(entry.policy);
    if (typeof entry.category !== 'string' || !entry.category
        || policy.installation !== 'AVAILABLE' || policy.authentication !== 'ON_INSTALL') {
      throw new Error(`${pluginName}: invalid local installation metadata`);
    }
    const manifest = readJson(join(plugin, '.codex-plugin/plugin.json'));
    if (manifest.name !== pluginName || typeof manifest.version !== 'string' || !manifest.version) {
      throw new Error(`${pluginName}: manifest name/version mismatch`);
    }
    for (const field of ['skills', 'hooks', 'mcpServers', 'apps']) {
      if (field in manifest) {
        const component = localPath(plugin, manifest[field]);
        if (field !== 'skills') readJson(component);
      }
    }
    return { ...entry, name: pluginName, source: { source: 'local', path: source.path } };
  });
  if (codexNames.size !== seen.size || [...codexNames].some((pluginName) => !seen.has(pluginName))) {
    throw new Error('catalog and Codex plugins differ');
  }
  return { ...catalog, name, plugins };
}

export function newCodexPlugin(root: string, name: string): void {
  validateName(name);
  const catalog = check(root);
  const plugin = join(root, 'plugins', name);
  if (existsSync(plugin)) throw new Error(`plugin already exists: ${name}`);
  mkdirSync(plugin);
  const temporaryCatalog = join(dirname(join(root, CATALOG)), `${randomUUID()}.json`);
  try {
    mkdirSync(join(plugin, '.codex-plugin'));
    mkdirSync(join(plugin, 'skills', name), { recursive: true });
    writeJson(join(plugin, 'package.json'), {
      name, private: true, type: 'module', engines: { node: '26.x', pnpm: '11.x' },
    });
    writeJson(join(plugin, '.codex-plugin/plugin.json'), {
      name, version: '0.1.0', description: `Local ${name} plugin.`, skills: './skills/',
      interface: { displayName: name, shortDescription: `Local ${name} plugin` },
    });
    writeFileSync(join(plugin, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Use only when the user explicitly invokes ${name}.\n---\n\n`
      + `Tell the user the ${name} plugin is loaded and ready to customize.\n`);
    catalog.plugins.push({
      name, source: { source: 'local', path: `./plugins/${name}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    });
    writeJson(temporaryCatalog, catalog);
    renameSync(temporaryCatalog, join(root, CATALOG));
  } catch (error) {
    rmSync(temporaryCatalog, { force: true });
    rmSync(plugin, { recursive: true, force: true });
    throw error;
  }
  console.log(`Created plugins/${name}; edit its manifest and skill.`);
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

type CodexLinkOptions = {
  codexHome?: string;
  runCodex?: (args: string[]) => void;
};

export type OpenCodeGeneration = 1 | 2;

type OpenCodeLinkOptions = {
  commandVersion?: (command: string) => string | undefined;
  configDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
};

export function linkCodexPlugin(root: string, name: string, options: CodexLinkOptions = {}): void {
  validateName(name);
  const catalog = check(root);
  if (!catalog.plugins.some((entry) => entry.name === name)) throw new Error(`unknown plugin: ${name}`);
  const source = realpathSync(join(root, 'plugins', name));
  const version = readJson(join(source, '.codex-plugin/plugin.json')).version;
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
    throw new Error('plugin version must be a safe cache directory name');
  }
  const codexHome = expandHome(options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'));
  const destination = join(codexHome, 'plugins/cache', catalog.name, name, version);
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    if (realpathSync(destination) !== source) throw new Error(`refusing to replace unrelated link: ${destination}`);
    throw new Error(`Codex ignores symlink cache roots. Move this legacy link aside: ${destination}`);
  }
  const entries = existing?.isDirectory() ? readdirSync(destination) : [];
  const legacy = entries.includes('.codex-plugin') && entries.length > 1 && entries.every((entry) => {
    const path = join(destination, entry);
    if (entry === '.codex-plugin' && lstatSync(path).isDirectory()) return true;
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === join(source, entry);
  });
  const ownershipPath = join(codexHome, 'plugins/local-sources', `${catalog.name}-${name}-${version}.json`);
  const ownership = lstatSync(ownershipPath, { throwIfNoEntry: false });
  const owned = ownership?.isFile() && !ownership.isSymbolicLink()
    && readJson(ownershipPath).source === source;
  if (existing && !legacy && !owned) throw new Error(`cache already exists: ${destination}. Move it aside before linking.`);
  // Codex owns registration and config. Never hand-edit config.toml.
  const runCodex = options.runCodex ?? ((args) => { execFileSync('codex', args, { stdio: 'inherit' }); });
  if (!existing) {
    runCodex(['plugin', 'marketplace', 'add', root]);
    runCodex(['plugin', 'add', `${name}@${catalog.name}`]);
  }
  const installed = lstatSync(destination);
  if (installed.isSymbolicLink() || !installed.isDirectory()) {
    throw new Error(`unexpected Codex cache layout: ${destination}`);
  }
  if (readJson(join(destination, '.codex-plugin/plugin.json')).name !== name) {
    throw new Error(`unexpected installed plugin at ${destination}`);
  }
  const backupRoot = join(codexHome, 'plugins/local-link-backups');
  mkdirSync(backupRoot, { recursive: true });
  const backup = join(backupRoot, `${catalog.name}-${name}-${randomUUID()}`);
  renameSync(destination, backup);
  try {
    // Codex fingerprints every entry for hook trust and rejects symlinked content.
    // Install a complete local snapshot, refreshed explicitly by this command.
    cpSync(source, destination, { recursive: true, dereference: true });
    mkdirSync(dirname(ownershipPath), { recursive: true });
    writeJson(ownershipPath, { source });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    renameSync(backup, destination);
    throw error;
  }
  console.log(`Installed local snapshot: ${destination}\nSource: ${source}\nPrevious copy: ${backup}`);
  console.log("Restart Codex. Review and trust this plugin's hooks in /hooks before use.");
}

function executableVersion(command: string): string | undefined {
  try {
    return execFileSync(command, ['--version'], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return;
  }
}

export function detectOpenCodeGeneration(
  commandVersion: (command: string) => string | undefined = executableVersion,
): OpenCodeGeneration {
  if (commandVersion('opencode2') !== undefined) return 2;
  const version = commandVersion('opencode');
  if (version !== undefined) {
    const match = version.match(/(?:^|\s)v?(\d+)\./);
    const major = match?.[1];
    if (major === undefined) throw new Error(`unable to identify OpenCode generation: ${version}`);
    return Number(major) >= 2 ? 2 : 1;
  }
  throw new Error('OpenCode CLI not found; install opencode2 or opencode');
}

export function openCodeConfigDirectory(options: OpenCodeLinkOptions = {}): string {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const configured = options.configDirectory || environment.OPENCODE_CONFIG_DIR;
  const expand = (path: string): string => path === '~' ? home
    : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  if (configured) return resolve(expand(configured));
  const xdg = environment.XDG_CONFIG_HOME;
  if (xdg) return resolve(expand(xdg), 'opencode');
  return join(home, '.config/opencode');
}

function openCodeLinkTarget(destination: string, source: string): boolean {
  const target = readlinkSync(destination);
  return target === join(source, 'v1.ts') || target === join(source, 'v2.ts')
    || resolve(dirname(destination), target) === join(source, 'v1.ts')
    || resolve(dirname(destination), target) === join(source, 'v2.ts');
}

export function linkOpenCodePlugin(root: string, name: string, options: OpenCodeLinkOptions = {}): void {
  validateName(name);
  const source = realpathSync(join(root, 'plugins', name));
  const packageJson = readJson(join(source, 'package.json'));
  if (packageJson.name !== name || packageJson.private !== true) {
    throw new Error(`${name}: package name/private mismatch`);
  }
  const generation = detectOpenCodeGeneration(options.commandVersion);
  const entrypoint = join(source, `v${generation}.ts`);
  const entry = lstatSync(entrypoint, { throwIfNoEntry: false });
  if (!entry?.isFile()) throw new Error(`missing OpenCode V${generation} entrypoint: ${entrypoint}`);
  const pluginDirectory = join(openCodeConfigDirectory(options), 'plugins');
  mkdirSync(pluginDirectory, { recursive: true });
  const destination = join(pluginDirectory, `${name}.ts`);
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing && (!existing.isSymbolicLink() || !openCodeLinkTarget(destination, source))) {
    throw new Error(`refusing to replace unrelated path: ${destination}`);
  }
  if (existing && resolve(dirname(destination), readlinkSync(destination)) === entrypoint) {
    console.log(`Already linked OpenCode V${generation}: ${destination} -> ${entrypoint}`);
    return;
  }
  const temporary = join(pluginDirectory, `.${name}-${randomUUID()}.tmp`);
  try {
    symlinkSync(entrypoint, temporary, 'file');
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  console.log(`Linked OpenCode V${generation}: ${destination} -> ${entrypoint}`);
}
