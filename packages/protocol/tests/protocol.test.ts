import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { envelope } from '../../transport/src/journal.ts';

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function read(name: string): unknown { return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')); }

test('the schema and real source encoder agree on shared valid and invalid fixtures', () => {
  const schema = read('../event.schema.json');
  const fixtures = read('../fixtures/events.json');
  assert.ok(object(schema) && object(fixtures) && Array.isArray(fixtures.valid) && Array.isArray(fixtures.invalid));
  const ajv = new Ajv2020({ allErrors: true });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  for (const event of fixtures.valid) {
    assert.ok(object(event) && typeof event.sourceId === 'string' && typeof event.harness === 'string');
    assert.equal(validate(event), true, JSON.stringify(validate.errors));
    assert.deepEqual(envelope(Buffer.from(JSON.stringify(event.native)), event.sourceId, event.harness), event);
  }
  const base = fixtures.valid[0];
  assert.ok(object(base));
  for (const invalid of fixtures.invalid) {
    assert.ok(object(invalid) && object(invalid.patch));
    assert.equal(validate({ ...base, ...invalid.patch }), false, String(invalid.name));
  }
});
