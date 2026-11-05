import { spawnSync } from 'node:child_process';

export type CheckMode = 'default' | 'pr' | 'full';
export type Suite = 'go' | 'browser' | 'native' | 'package' | 'distribution' | 'harness' | 'transport';
export type Selection = Map<Suite, string[]>;

const suites: Suite[] = ['go', 'browser', 'native', 'package', 'distribution', 'harness', 'transport'];

export function selectChecks(mode: CheckMode, paths: string[] | null): Selection {
  const selected: Selection = new Map();
  const add = (names: Suite[], reason: string) => {
    for (const name of names) selected.set(name, [...selected.get(name) ?? [], reason]);
  };
  if (mode === 'default') return selected;
  if (mode === 'full' || paths === null) {
    add(suites, mode === 'full' ? 'full verification requested' : 'changed files unavailable');
    return selected;
  }
  for (const path of paths) {
    if (/^(docs\/.*\.md$|README\.md$|DESIGN\.md$|LICENSE$)/.test(path) || path.endsWith('/README.md') || path.endsWith('/PRODUCT.md')) continue;
    if (path.startsWith('apps/web/')) add(['browser', 'native', 'package'], path);
    else if (path.startsWith('apps/desktop/')) add(['go', 'native', 'package'], path);
    else if (path.startsWith('packages/protocol/')) add(suites, path);
    else if (path.startsWith('packages/client/') || path.startsWith('packages/webui/')) add(['go', 'browser', 'native', 'package'], path);
    else if (path.startsWith('apps/server/internal/sqlite/') || path.startsWith('apps/server/internal/harnesses/')) add(['go', 'browser'], path);
    else if (path.startsWith('apps/server/') || path.startsWith('apps/cli/')) add(['go', 'browser', 'native', 'package'], path);
    else if (path.startsWith('plugins/') || path.startsWith('packages/transport/') || /^tests\/(logger|codex|opencode[^/]*|workspace)\.test\.ts$/.test(path)) add(['go', 'distribution', 'harness', 'transport'], path);
    else if (path.startsWith('packages/installer/') || path === 'install.ts' || path === 'tests/distribution.test.ts') add(['go', 'distribution', 'harness', 'transport'], path);
    else if (path.startsWith('test-data/')) add(['go', 'browser', 'distribution', 'harness', 'transport'], path);
    else add(suites, path);
  }
  return selected;
}

export function changedFiles(cwd: string): string[] {
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const base = git(['merge-base', 'HEAD', 'origin/main']).trim();
  if (!base) throw new Error('origin/main has no merge base');
  // Disabling rename detection includes both old and new paths. Diffing HEAD
  // against the working tree also includes staged and unstaged edits.
  const committed = git(['diff', '--name-only', '--no-renames', '-z', base, 'HEAD']);
  const working = git(['diff', '--name-only', '--no-renames', '-z', 'HEAD']);
  const staged = git(['diff', '--cached', '--name-only', '--no-renames', '-z']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([committed, working, staged, untracked].flatMap((value) => value.split('\0').filter(Boolean)))].sort();
}
