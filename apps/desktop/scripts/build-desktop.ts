import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { arch, platform } from 'node:process';

const desktop = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flags = args.filter((arg) => arg !== '--prepared');
let targets = `${platform}/${arch === 'x64' ? 'amd64' : arch}`;
for (let index = 0; index < flags.length; index++) {
  const flag = flags[index];
  if (flag === '-platform' || flag === '--platform') {
    const value = flags[index + 1];
    if (!value || value.startsWith('-')) throw new Error('Missing desktop packaging platform');
    targets = value;
    index++;
  } else if (flag?.startsWith('-platform=') || flag?.startsWith('--platform=')) targets = flag.slice(flag.indexOf('=') + 1);
}
const companions = targets.split(',').flatMap((target) => target === 'darwin/universal' ? ['darwin/amd64', 'darwin/arm64'] : [target]);
for (const target of companions) {
  if (!/^(linux|darwin)\/(amd64|arm64)$/.test(target)) throw new Error(`Unsupported companion target: ${target}`);
}
if (!args.includes('--prepared')) execFileSync('pnpm', ['--filter', '@tool-logger/web', 'build'], { cwd: desktop, stdio: 'inherit' });
execFileSync(process.execPath, [resolve(desktop, 'scripts/build-companion.ts'), ...companions], { cwd: desktop, stdio: 'inherit' });
execFileSync('go', ['tool', 'mygo', 'build', '-skip-build-command', ...flags], { cwd: desktop, stdio: 'inherit' });
