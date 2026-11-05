import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changedFiles, selectChecks } from '../scripts/check-plan.ts';

test('PR gate selects feature boundaries and fails closed for shared or unknown changes', () => {
  assert.equal(selectChecks('pr', ['docs/development.md', 'README.md']).size, 0);
  for (const path of ['apps/web/src/client/app.tsx', 'apps/web/tests/browser/viewer.spec.ts']) {
    const selected = selectChecks('pr', [path]);
    for (const suite of ['browser', 'native', 'package']) assert.ok(new Set<string>(selected.keys()).has(suite), path + ': ' + suite);
  }
  const plugin = selectChecks('pr', ['plugins/codex-tool-logger/scripts/log-tool-call.ts']);
  for (const suite of ['go', 'distribution', 'harness', 'transport']) assert.ok(new Set<string>(plugin.keys()).has(suite));
  assert.equal(plugin.has('native'), false);
  assert.ok(selectChecks('pr', ['apps/server/internal/sqlite/store.go']).has('go'));
  assert.ok(selectChecks('pr', ['apps/server/remote.go']).has('native'));
  assert.ok(selectChecks('pr', ['packages/client/connection.go']).has('browser'));
  const full = [...selectChecks('full', []).keys()].sort();
  for (const paths of [null, ['new-shared-contract.ts'], ['package.json'], ['scripts/check-pr.ts'], ['packages/protocol/api.go']]) {
    assert.deepEqual([...selectChecks('pr', paths).keys()].sort(), full);
  }
  assert.equal(selectChecks('default', null).size, 0);
});

test('PR selection includes branch, index, worktree, untracked, deleted and both renamed paths', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tl-check-selection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Check selection');
  for (const path of ['renamed.ts', 'deleted.ts', 'index.ts', 'worktree.ts']) writeFileSync(join(directory, path), path);
  git('add', '.'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(directory, 'branch.ts'), 'committed');
  git('add', '.'); git('commit', '-qm', 'branch');
  mkdirSync(join(directory, 'apps'));
  renameSync(join(directory, 'renamed.ts'), join(directory, 'apps/renamed.ts'));
  rmSync(join(directory, 'deleted.ts'));
  writeFileSync(join(directory, 'index.ts'), 'staged');
  git('add', '-A');
  // A staged edit reverted in the worktree still contributes to selection.
  writeFileSync(join(directory, 'index.ts'), 'index.ts');
  writeFileSync(join(directory, 'worktree.ts'), 'unstaged');
  writeFileSync(join(directory, 'untracked.ts'), 'untracked');
  assert.deepEqual(changedFiles(directory), ['apps/renamed.ts', 'branch.ts', 'deleted.ts', 'index.ts', 'renamed.ts', 'untracked.ts', 'worktree.ts']);
  git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.throws(() => changedFiles(directory), /merge-base/);
});
