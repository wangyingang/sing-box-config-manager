import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rebuildRules, updateRules } from '../../src/update.js';
import { initializeRemoteState, readRemoteState } from '../../src/remote-state.js';
import { sha256 } from '../../src/release.js';
import { memoryRepository } from '../fixtures/publication-repository.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const tag = '20261104112839';
function source() {
  const requests: string[] = [];
  const input = JSON.stringify({ lists: [{ name: 'category-ai-!cn', length: 1, rules: ['domain:example.com'] }] });
  let advanced = false;
  const fetcher: typeof fetch = async url => {
    const path = String(url); requests.push(path);
    if (path.endsWith('/latest') && advanced) throw new Error('Must resume the fixed Release before latest');
    if (path.endsWith('/latest') || path.endsWith('/releases/42')) return Response.json({ id: 42, tag_name: tag,
      assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, i) => ({ id: 11 + i, name,
        browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}` })) });
    if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (path.endsWith('/assets/11')) return new Response(input);
    if (path.endsWith('/assets/12')) return new Response(`${sha256(input)}  dlc.dat_plain.yml\n`);
    throw new Error(`Unexpected ${path}`);
  };
  return { fetcher, requests, advance() { advanced = true; }, current() { advanced = false; } };
}

test('旧单集规则文件提交后中断，全新目录使用原 Release 和同一候选继续', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-remote-recovery-'));
  try {
    const remote = memoryRepository('candidates'), upstream = source();
    await initializeRemoteState(remote.repository, 'main');
    remote.fault((files, applied) => {
      if (!applied && Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('connection interrupted');
    });
    const common = { binary: binary!, publication: remote.publication, fetch: upstream.fetcher };
    await assert.rejects(updateRules({ ...common, stateDirectory: join(directory, 'first') }), /connection interrupted/);
    const before = (await readRemoteState(remote.repository)).journal.state;
    const id = Object.keys(before.candidates)[0];
    assert.ok(id);
    assert.equal(before.candidates[id].phase, 'files');
    remote.fault(undefined); upstream.advance();
    const recovered = await updateRules({ ...common, stateDirectory: join(directory, 'new-machine') });
    assert.equal(recovered.status, 'processed');
    if (recovered.status === 'processed') assert.equal(recovered.candidate.id, id);
    assert.equal(remote.writes.filter(files => Object.keys(files).some(path => path.endsWith('/domains.json'))).length, 1);
    const after = (await readRemoteState(remote.repository)).journal.state;
    assert.equal(Object.keys(after.candidates).length, 1);
    assert.equal(after.pendingOperation?.status, 'complete');
    assert.equal(after.candidates[id].phase, 'complete');
    upstream.current();
    const skipped = await updateRules({ ...common, stateDirectory: join(directory, 'third-machine') });
    assert.equal(skipped.status, 'skipped');
    if (skipped.status === 'skipped') assert.equal(skipped.candidateId, id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const stage of ['domains.json', 'manifest.json', 'readback.json']) {
  test(`旧单集 ${stage} 回复丢失且暂时无法核实，新目录不重复发布成功阶段`, { skip: !binary }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'legacy-remote-uncertain-'));
    try {
      const remote = memoryRepository('candidates'), upstream = source();
      await initializeRemoteState(remote.repository, 'main');
      let unavailable = false;
      const snapshot = remote.repository.snapshot.bind(remote.repository);
      remote.repository.snapshot = async (...args) => {
        if (unavailable) throw new Error('remote state temporarily unavailable');
        return snapshot(...args);
      };
      remote.fault((files, applied) => {
        if (applied && Object.keys(files).some(path => path.endsWith(`/${stage}`))) {
          unavailable = true;
          throw new Error('write response lost');
        }
      });
      const common = { binary: binary!, publication: remote.publication, fetch: upstream.fetcher };
      await assert.rejects(updateRules({ ...common, stateDirectory: join(directory, 'first') }), /PUBLICATION_PENDING/);
      unavailable = false; remote.fault(undefined); upstream.advance();
      const before = (await readRemoteState(remote.repository)).journal.state;
      const id = Object.keys(before.candidates)[0];
      const recovered = await updateRules({ ...common, stateDirectory: join(directory, 'new-machine') });
      assert.equal(recovered.status, 'processed');
      if (recovered.status === 'processed') assert.equal(recovered.candidate.id, id);
      for (const file of ['domains.json', 'manifest.json', 'readback.json']) {
        assert.equal(remote.writes.filter(files => Object.keys(files).some(path => path.endsWith(`/${file}`))).length, 1);
      }
      assert.equal((await readRemoteState(remote.repository)).journal.state.pendingOperation?.status, 'complete');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('旧单集 rebuild 在新目录恢复原候选，保留原 update 成功记录', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-remote-rebuild-'));
  try {
    const remote = memoryRepository('candidates'), upstream = source();
    await initializeRemoteState(remote.repository, 'main');
    const common = { binary: binary!, publication: remote.publication, fetch: upstream.fetcher };
    await updateRules({ ...common, stateDirectory: join(directory, 'initial') });
    const original = (await readRemoteState(remote.repository)).journal.state.processed['42'];
    remote.fault((files, applied) => {
      if (!applied && Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('connection interrupted');
    });
    await assert.rejects(rebuildRules({ ...common, stateDirectory: join(directory, 'rebuild'), release: tag }), /connection interrupted/);
    const pending = (await readRemoteState(remote.repository)).journal.state;
    const id = Object.values(pending.candidates).find(candidate => candidate.operation === 'rebuild')!.id;
    await assert.rejects(updateRules({ ...common, stateDirectory: join(directory, 'wrong-operation') }), /RECOVERY_REQUEST_MISMATCH/);
    remote.fault(undefined); upstream.advance();
    const recovered = await rebuildRules({ ...common, stateDirectory: join(directory, 'new-machine'), release: tag });
    assert.equal(recovered.status, 'processed');
    if (recovered.status === 'processed') assert.equal(recovered.candidate.id, id);
    const after = (await readRemoteState(remote.repository)).journal.state;
    assert.deepEqual(after.processed['42'], original);
    assert.equal(Object.keys(after.candidates).length, 2);
    assert.equal(remote.writes.filter(files => Object.keys(files).some(path => path.endsWith('/domains.json'))).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('旧单集在固定身份后下载失败，全新目录仍从原 Release 恢复', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-remote-pin-'));
  try {
    const remote = memoryRepository('candidates'), upstream = source();
    await initializeRemoteState(remote.repository, 'main');
    let offline = true;
    const fetcher: typeof fetch = async (url, init) => {
      if (offline && String(url).endsWith('/assets/11')) throw new Error('asset temporarily offline');
      return upstream.fetcher(url, init);
    };
    const common = { binary: binary!, publication: remote.publication, fetch: fetcher };
    await assert.rejects(updateRules({ ...common, stateDirectory: join(directory, 'first') }), /asset temporarily offline/);
    const before = (await readRemoteState(remote.repository)).journal.state;
    assert.ok(before.pinned['42'].identity);
    assert.equal(before.pinned['42'].source, undefined);
    const id = Object.keys(before.candidates)[0];
    offline = false; upstream.advance();
    const recovered = await updateRules({ ...common, stateDirectory: join(directory, 'new-machine') });
    assert.equal(recovered.status, 'processed');
    if (recovered.status === 'processed') assert.equal(recovered.candidate.id, id);
    assert.equal(upstream.requests.filter(url => url.endsWith('/latest')).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('旧单集已处理但当前树不再保留完整候选时，不返回旧成功地址或重新发布', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-remote-retained-'));
  try {
    const remote = memoryRepository('candidates'), upstream = source();
    await initializeRemoteState(remote.repository, 'main');
    const common = { binary: binary!, publication: remote.publication, fetch: upstream.fetcher };
    const initial = await updateRules({ ...common, stateDirectory: join(directory, 'first') });
    assert.equal(initial.status, 'processed');
    if (initial.status !== 'processed') return;
    remote.remove(`candidates/${initial.candidate.id}/domains.json`);
    // Old immutable objects still exist; retention is determined by current state.
    assert.ok((await remote.publication.download(initial.candidate.evidenceUrl!)).length > 0);
    const writes = remote.writes.length;
    await assert.rejects(updateRules({ ...common, stateDirectory: join(directory, 'new-machine') }), /CANDIDATE_UNAVAILABLE/);
    await assert.rejects(rebuildRules({ ...common, stateDirectory: join(directory, 'rebuild'), release: tag }), /CANDIDATE_UNAVAILABLE/);
    assert.equal(remote.writes.length, writes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('旧单集证据已提交但最后回读失败，新目录仅核验候选即可恢复且不访问上游', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-remote-evidence-'));
  try {
    const remote = memoryRepository('candidates'), upstream = source();
    await initializeRemoteState(remote.repository, 'main');
    let failEvidence = true;
    const publication = { ...remote.publication, async download(url: string) {
      if (failEvidence && url.endsWith('/readback.json')) throw new Error('final readback unavailable');
      return remote.publication.download(url);
    } };
    const common = { binary: binary!, publication, fetch: upstream.fetcher };
    await assert.rejects(updateRules({ ...common, stateDirectory: join(directory, 'first') }), /final readback unavailable/);
    const id = Object.keys((await readRemoteState(remote.repository)).journal.state.candidates)[0];
    const candidateWrites = remote.writes.filter(files => Object.keys(files).some(path => path.startsWith('candidates/'))).length;
    failEvidence = false;
    const recovered = await updateRules({ ...common, stateDirectory: join(directory, 'new-machine'),
      fetch: async () => { throw new Error('completed candidate recovery must not read upstream'); } });
    assert.equal(recovered.status, 'processed');
    if (recovered.status === 'processed') assert.equal(recovered.candidate.id, id);
    assert.equal(remote.writes.filter(files => Object.keys(files).some(path => path.startsWith('candidates/'))).length, candidateWrites);
    assert.equal((await readRemoteState(remote.repository)).journal.state.processed['42'].candidateId, id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
