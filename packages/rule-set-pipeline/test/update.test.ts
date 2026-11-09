import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { updateRules, readUpdateState } from '../src/update.js';

test('无新 Release 只请求 latest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'update-skip-'));
  try {
    await writeFile(join(directory, 'update-state.json'), JSON.stringify({ schemaVersion: 1, pinned: {}, candidates: {},
      processed: { '42': { candidateId: 'prior-candidate', tag: 'fixed', evidenceUrl: 'https://example.invalid/evidence' } } }));
    const requests: string[] = [];
    const result = await updateRules({ stateDirectory: directory, binary: '/must-not-run', fetch: async url => {
      requests.push(String(url));
      return Response.json({ id: 42, tag_name: 'fixed' });
    }, publication: { commit: async () => { throw new Error('must not publish'); }, download: async () => { throw new Error('must not read'); } } });
    assert.equal(result.status, 'skipped');
    assert.deepEqual(requests, ['https://api.github.com/repos/v2fly/domain-list-community/releases/latest']);
    assert.deepEqual((await readUpdateState(directory)).activeRuleVersions, {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('lookup 失败不产生成功记录；并发锁拒绝覆盖；状态损坏不会当作空状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'update-failure-'));
  const publication = { async commit() { throw new Error('must not publish'); }, async download() { throw new Error('must not read'); } };
  try {
    await assert.rejects(updateRules({ stateDirectory: directory, binary: '', publication, fetch: async () => new Response('', { status: 503 }) }), /503/);
    assert.deepEqual((await readUpdateState(directory)).state.processed, {});
    await mkdir(join(directory, 'update.lock'));
    await assert.rejects(updateRules({ stateDirectory: directory, binary: '', fetch: async () => { throw new Error('must not request'); } }), { code: 'EEXIST' });
    await rm(join(directory, 'update.lock'), { recursive: true });
    await writeFile(join(directory, 'update-state.json'), '{broken');
    await assert.rejects(updateRules({ stateDirectory: directory, binary: '', publication }));
    assert.equal(await readFile(join(directory, 'update-state.json'), 'utf8'), '{broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
