import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeRemoteState, readRemoteState, STATE_PATH } from '../src/remote-state.js';
import { memoryRepository } from './fixtures/publication-repository.js';

test('远端首次初始化与已初始化记录缺失明确区分，普通读取不会写入', async () => {
  const remote = memoryRepository();
  await assert.rejects(readRemoteState(remote.repository), /NOT_INITIALIZED/);
  assert.equal(remote.writes.length, 0);
  await initializeRemoteState(remote.repository, 'acceptance-recovery');
  assert.equal((await readRemoteState(remote.repository)).journal.generation, 1);
  await assert.rejects(initializeRemoteState(remote.repository, 'acceptance-recovery'), /ALREADY_INITIALIZED/);
  remote.remove('pipeline/state.json');
  await assert.rejects(readRemoteState(remote.repository), /STATE_MISSING/);
});

test('远端读取失败不能作为未初始化状态，初始化和读取均不写入', async () => {
  const remote = memoryRepository();
  const repository = { ...remote.repository, async snapshot() { throw new Error('Remote HTTP 503'); } };
  await assert.rejects(readRemoteState(repository), /Remote HTTP 503/);
  await assert.rejects(initializeRemoteState(repository, 'acceptance-recovery'), /Remote HTTP 503/);
  assert.equal(remote.writes.length, 0);
});

test('已初始化的损坏 JSON 明确失败，不自动修复或覆盖远端状态', async () => {
  const remote = memoryRepository();
  await initializeRemoteState(remote.repository, 'acceptance-recovery');
  remote.replace(STATE_PATH, Buffer.from('{broken-json'));
  const before = remote.writes.length;
  await assert.rejects(readRemoteState(remote.repository), /STATE_CORRUPT/);
  await assert.rejects(initializeRemoteState(remote.repository, 'acceptance-recovery'), /ALREADY_INITIALIZED/);
  assert.equal(remote.writes.length, before);
});

test('来源固定记录缺少实际资产身份时判定记录损坏', async () => {
  const remote = memoryRepository();
  await initializeRemoteState(remote.repository, 'acceptance-recovery');
  const { journal } = await readRemoteState(remote.repository);
  const malformed = structuredClone(journal) as any;
  malformed.state.pinned['42'] = { identity: { repository: 'v2fly/domain-list-community', releaseId: 42,
    tag: '20261104112839', commit: 'a'.repeat(40), yaml: {}, checksum: {} } };
  remote.replace(STATE_PATH, Buffer.from(JSON.stringify(malformed)));
  const before = remote.writes.length;
  await assert.rejects(readRemoteState(remote.repository), /STATE_CORRUPT/);
  assert.equal(remote.writes.length, before);
});
