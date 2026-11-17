import assert from 'node:assert/strict';
import test from 'node:test';
import { readRemoteState, STATE_PATH } from '../src/remote-state.js';
import { historicalEnvironment } from './fixtures/historical-environment.js';

for (const fault of ['none', 'missing-state', 'missing-all', 'read-error', 'json', 'source-identity']) {
  test(`固定旧状态读取 ${fault}：不初始化、修复或覆盖`, async () => {
    const env = await historicalEnvironment('shared');
    const repository = env.legacyRepository;
    const initial = await readRemoteState(repository);
    assert.equal(initial.journal.schemaVersion, 1);
    assert.equal(initial.journal.targetBranch, 'acceptance-issue-99-history');
    let content = await initial.snapshot.read(STATE_PATH);
    if (fault === 'json') content = Buffer.from('{broken-json');
    if (fault === 'source-identity') {
      const journal = structuredClone(initial.journal);
      Reflect.set(Object.values(journal.state.pinned)[0].identity!, 'yaml', {});
      content = Buffer.from(JSON.stringify(journal));
    }
    const reader = { ...repository, async snapshot() {
      if (fault === 'read-error') throw new Error('Remote HTTP 503');
      return { ...initial.snapshot, async read(path: string) {
        if (fault === 'missing-all' || fault === 'missing-state' && path === STATE_PATH) return undefined;
        return path === STATE_PATH ? content : initial.snapshot.read(path);
      } };
    } };
    if (fault === 'none') assert.deepEqual((await readRemoteState(reader)).journal, initial.journal);
    else await assert.rejects(readRemoteState(reader), fault === 'missing-state' ? /STATE_MISSING/
      : fault === 'missing-all' ? /NOT_INITIALIZED/ : fault === 'read-error' ? /Remote HTTP 503/ : /STATE_CORRUPT/);
    assert.equal(env.writes.length, 0);
  });
}
