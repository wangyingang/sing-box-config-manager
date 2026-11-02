import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Obj } from '../../src/types.js';

if (!process.env.SING_BOX_TEST_BINARY) throw new Error('SING_BOX_TEST_BINARY is required');
const binary = resolve(process.env.SING_BOX_TEST_BINARY);
assert.equal(execFileSync(binary, ['version'], { encoding: 'utf8' }).split('\n')[0], 'sing-box version 1.14.4');
async function merged(a: Obj, b: Obj): Promise<Obj> {
  const directory = await mkdtemp(join(tmpdir(), 'd06-merge-'));
  try {
    await writeFile(join(directory, '01.json'), JSON.stringify(a));
    await writeFile(join(directory, '02.json'), JSON.stringify(b));
    // Reverse CLI argument order deliberately.
    execFileSync(binary, ['merge', 'result.json', '-c', '02.json', '-c', '01.json'], { cwd: directory, stdio: 'pipe' });
    return JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test('merge: earlier scalars win, objects fill missing fields, false survives until typed encoding', async () => {
  assert.deepEqual(await merged({ log: { level: 'debug', timestamp: false } }, { log: { level: 'info', timestamp: true, disabled: true } }), { log: { level: 'debug', disabled: true } });
});
test('merge: arrays append without deduplication; duplicate outbound tags fail typed decoding', async () => {
  const rule = { domain: 'example.com', action: 'reject' };
  assert.deepEqual((await merged({ route: { rules: [rule] } }, { route: { rules: [rule] } })).route, { rules: [rule, rule] });
  await assert.rejects(merged({ outbounds: [{ type: 'direct', tag: 'same' }] }, { outbounds: [{ type: 'direct', tag: 'same' }] }));
});
test('merge: null is positional, not a deletion operator; unknown fields fail early', async () => {
  assert.deepEqual(await merged({ log: null }, { log: { level: 'debug' } }), {});
  await assert.rejects(merged({ log: { level: 'debug' } }, { log: null }));
  await assert.rejects(merged({ unknown_field: true }, {}));
  await assert.rejects(merged({ log: 'not-an-object' }, {}));
});
test('merge: directory scans are shallow and all stored path strings share one sort order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'd06-paths-'));
  try {
    await mkdir(join(directory, 'dir/nested'), { recursive: true });
    await writeFile(join(directory, '20.json'), JSON.stringify({ log: { level: 'info' } }));
    await writeFile(join(directory, 'dir/10.json'), JSON.stringify({ log: { level: 'debug' } }));
    await writeFile(join(directory, 'dir/nested/00.json'), 'invalid ignored nested config');
    await writeFile(join(directory, 'dir/00.JSON'), 'invalid ignored extension');
    for (const flags of [['-C', 'dir', '-c', '20.json'], ['-c', '20.json', '-C', 'dir']]) {
      execFileSync(binary, ['merge', 'result.json', ...flags], { cwd: directory, stdio: 'pipe' });
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')), { log: { level: 'info' } });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('merge: readable SSH path resources are inlined without removing the path field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'd06-resource-'));
  try {
    await writeFile(join(directory, 'key.txt'), 'fixture-only\n\nnot-a-real-key\n');
    await writeFile(join(directory, 'config.json'), JSON.stringify({ outbounds: [{ type: 'ssh', tag: 'ssh', server: '192.0.2.1', user: 'fixture', private_key_path: 'key.txt' }] }));
    execFileSync(binary, ['merge', 'result.json', '-c', 'config.json'], { cwd: directory, stdio: 'pipe' });
    const config = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    assert.deepEqual(config.outbounds[0].private_key, ['fixture-only', 'not-a-real-key']);
    assert.equal(config.outbounds[0].private_key_path, 'key.txt');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
