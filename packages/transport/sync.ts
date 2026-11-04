import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const plugins = ['codex-tool-logger', 'opencode-tool-logger'];

export async function syncTransport(repository = root, check = false): Promise<void> {
  const source = join(repository, 'packages/transport/src');
  const names = (await readdir(source)).sort();
  for (const plugin of plugins) {
    const destination = join(repository, 'plugins', plugin, 'transport');
    if (check) {
      let copies: string[];
      try { copies = (await readdir(destination)).sort(); }
      catch { throw new Error(`Transport copy missing: ${plugin}; run transport sync`); }
      if (JSON.stringify(copies) !== JSON.stringify(names)) {
        throw new Error(`Transport file drift: ${plugin}; run transport sync`);
      }
      for (const name of names) {
        const [canonical, copy] = await Promise.all([readFile(join(source, name)), readFile(join(destination, name))]);
        if (!canonical.equals(copy)) throw new Error(`Transport drift: ${plugin}/${name}; run transport sync`);
      }
    } else {
      await mkdir(destination, { recursive: true });
      for (const stale of await readdir(destination)) {
        if (!names.includes(stale)) await rm(join(destination, stale), { recursive: true });
      }
      for (const name of names) await cp(join(source, name), join(destination, name));
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('Usage: node sync.ts [--check]'); process.exitCode = 1;
  } else {
    syncTransport(root, args[0] === '--check').catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Transport sync failed'); process.exitCode = 1;
    });
  }
}
