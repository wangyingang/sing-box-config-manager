import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('archived Spec #14 final evidence retains its original bytes and complete inventory', async () => {
  const directory = new URL('../../docs/verification/spec-14-final/', import.meta.url);
  const inventory = (await readFile(new URL('SHA256SUMS', directory), 'utf8')).trim().split('\n');
  const names = [];
  for (const line of inventory) {
    const match = /^([a-f0-9]{64})  ([a-z0-9.-]+)$/.exec(line);
    assert.ok(match, `Invalid inventory line: ${line}`);
    const [, expected, name] = match;
    names.push(name);
    const bytes = await readFile(new URL(name, directory));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, name);
  }
  assert.deepEqual((await readdir(directory)).sort(), [...names, 'SHA256SUMS', 'README.md'].sort());
});
