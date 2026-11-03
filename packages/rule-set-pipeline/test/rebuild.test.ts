import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { rebuildRules } from '../src/update.js';

test('重建拒绝 latest、空 tag、未处理 Release，且不会查询 latest 或发布', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-22-guards-'));
  try {
    const options = { stateDirectory: directory, binary: '/must-not-run', fetch: async () => { throw new Error('must not request'); } };
    for (const release of ['', 'latest', 'LATEST']) assert.throws(() => rebuildRules({ ...options, release }), /fixed Release/);
    await assert.rejects(rebuildRules({ ...options, release: 'unknown' }), /previously pinned/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI rebuild 必须显式提供固定 Release、状态目录及 binary；update 仍拒绝 tag', async () => {
  for (const args of [
    ['rebuild'], ['rebuild', '--state', '/unused', '--binary', '/unused'],
    ['rebuild', '--state', '/unused', '--release', 'latest', '--binary', '/unused'],
    ['rebuild', '--state', '/unused', '--release', 'fixed'], ['update', '--state', '/unused', '--release', 'fixed'],
  ]) await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args]),
    (error: { code?: number; stderr?: string }) => error.code === 1 && !!error.stderr?.includes('requires'));
});
