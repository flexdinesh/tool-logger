import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectOpenCodeGeneration, linkCodexPlugin, linkOpenCodePlugin } from './packages/installer/index.ts';

export function install(root: string, selection: string): void {
  if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('Node.js 26 is required');
  if (!['codex', 'opencode', 'all'].includes(selection)) {
    throw new Error('usage: node install.ts codex|opencode|all');
  }
  // Check every selected harness before changing either installation.
  if (selection === 'codex' || selection === 'all') {
    execFileSync('codex', ['--version'], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (selection === 'opencode' || selection === 'all') detectOpenCodeGeneration();
  if (selection === 'codex' || selection === 'all') linkCodexPlugin(root, 'codex-tool-logger');
  if (selection === 'opencode' || selection === 'all') linkOpenCodePlugin(root, 'opencode-tool-logger');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [selection, ...extra] = process.argv.slice(2);
    if (!selection || extra.length) throw new Error('usage: node install.ts codex|opencode|all');
    install(import.meta.dirname, selection);
  } catch (error) {
    console.error(`installer: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
