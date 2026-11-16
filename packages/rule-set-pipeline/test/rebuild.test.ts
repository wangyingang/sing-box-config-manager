import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rebuildRules } from '../src/update.js';

test('重建拒绝 latest、空 tag、未处理 Release，且不会查询 latest 或发布', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-22-guards-'));
  try {
    const options = { stateDirectory: directory, binary: '/must-not-run', fetch: async () => { throw new Error('must not request'); },
      publication: { async commit() { throw new Error('must not publish'); }, async download() { throw new Error('must not read'); } } };
    for (const release of ['', 'latest', 'LATEST']) assert.throws(() => rebuildRules({ ...options, release }), /fixed Release/);
    await assert.rejects(rebuildRules({ ...options, release: 'unknown' }), /previously pinned/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
