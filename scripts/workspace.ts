import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, linkCodexPlugin, linkOpenCodePlugin, newCodexPlugin } from '../packages/installer/index.ts';
export * from '../packages/installer/index.ts';
export const ROOT = resolve(import.meta.dirname, '..');

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, name, ...extra] = process.argv.slice(2);
    if (command === 'check' && name === undefined) {
      console.log(`Validated ${check(ROOT).plugins.length} local Codex plugin(s).`);
    } else if ((command === 'new-codex' || command === 'link-codex' || command === 'link-opencode')
        && name !== undefined && extra.length === 0) {
      if (command === 'new-codex') newCodexPlugin(ROOT, name);
      else if (command === 'link-codex') linkCodexPlugin(ROOT, name);
      else linkOpenCodePlugin(ROOT, name);
    } else {
      throw new Error('usage: node scripts/workspace.ts check | new-codex <name> | link-codex <name> | link-opencode <name>');
    }
  } catch (error) {
    console.error(`workspace: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
