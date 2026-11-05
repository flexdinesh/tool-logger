import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { arch, platform } from 'node:process';
import { fileURLToPath } from 'node:url';

type Command = [string, ...string[]];

const E2E: Command = ['pnpm', '--filter', '@tool-logger/desktop', 'test:e2e'];

// Linux e2e tests skip and exit 0 without a display. A skip must never pass.
export function e2eCommand(os: NodeJS.Platform, hasDisplay: boolean, hasXvfb: boolean): Command {
  if (os !== 'linux' || hasDisplay) return E2E;
  if (hasXvfb) return ['xvfb-run', '-a', ...E2E];
  throw new Error('Linux native automation needs a display or xvfb-run; install Xvfb or use a desktop session');
}

function run([file, ...args]: Command): void {
  const result = spawnSync(file, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${[file, ...args].join(' ')} failed with ${result.signal ?? result.status}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    const hasXvfb = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).error === undefined;
    // Resolve first: a missing display should not cost a full check run.
    const e2e = e2eCommand(platform, hasDisplay, hasXvfb);
    run(['pnpm', 'check']);
    run(['pnpm', '--filter', '@tool-logger/web', 'test:browser']);
    run(e2e);
    run(['pnpm', '--filter', '@tool-logger/desktop', 'build']);
    const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    console.log(`check:pr passed on ${platform}/${arch} at ${commit}. Other platforms not verified.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
