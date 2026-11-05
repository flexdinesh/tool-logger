import assert from 'node:assert/strict';
import test from 'node:test';
import { e2eCommand } from '../scripts/check-pr.ts';

const E2E = ['pnpm', '--filter', '@tool-logger/desktop', 'test:e2e'];

test('headless Linux runs native automation under xvfb-run', () => {
  assert.deepEqual(e2eCommand('linux', false, true), ['xvfb-run', '-a', ...E2E]);
});

test('headless Linux without xvfb-run fails instead of passing skipped tests', () => {
  assert.throws(() => e2eCommand('linux', false, false), /needs a display or xvfb-run/);
});

test('Linux display sessions and macOS run native automation directly', () => {
  assert.deepEqual(e2eCommand('linux', true, false), E2E);
  assert.deepEqual(e2eCommand('darwin', false, false), E2E);
});
