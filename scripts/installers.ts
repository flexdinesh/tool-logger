import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = import.meta.dirname;
const template = readFileSync(join(directory, 'install-template.sh'), 'utf8');
for (const mode of ['cli', 'desktop', 'plugins']) {
  for (const channel of ['stable', 'edge']) {
    const name = `install${mode === 'cli' ? '' : `-${mode}`}${channel === 'edge' ? '-edge' : ''}.sh`;
    const output = template.replace('CHANNEL=stable', `CHANNEL=${channel}`).replace('MODE=cli', `MODE=${mode}`);
    const path = join(directory, name);
    if (process.argv.includes('--check')) {
      if (readFileSync(path, 'utf8') !== output) throw new Error(`${name} drifted; run node scripts/installers.ts`);
    } else writeFileSync(path, output, { mode: 0o755 });
  }
}
