import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { updateRules } from '../../src/update.js';
import { initializeRemoteState, readRemoteState } from '../../src/remote-state.js';
import { sha256 } from '../../src/release.js';
import { memoryRepository } from '../fixtures/publication-repository.js';
import { readRemoteStatus } from '../../src/remote-status.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const tag = '20261104112839';
const configuration = JSON.stringify({ schemaVersion: 1, source: 'v2fly/domain-list-community',
  target: { repository: 'wangyingang/sing-box-rule-artifacts', branch: 'acceptance-recovery' },
  ruleSets: [{ id: 'ai-openai', list: 'openai', stablePath: 'stable/ai-openai' }] });
function source(lists = [{ name: 'openai', length: 1, rules: ['domain:openai.com'] }]) {
  const requests: string[] = [];
  const input = JSON.stringify({ lists });
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
  return { fetcher, requests, advance() { advanced = true; } };
}

test('规则文件提交后中断，全新目录恢复同一候选和固定 Release', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-recovery-'));
  try {
    const remote = memoryRepository(), upstream = source();
    await initializeRemoteState(remote.repository, 'acceptance-recovery');
    remote.fault((files, applied) => {
      if (!applied && Object.keys(files).some(path => path.endsWith('/manifest.json'))) throw new Error('connection interrupted');
    });
    const common = { binary: binary!, configuration, publication: remote.publication, fetch: upstream.fetcher };
    const first = await updateRules({ ...common, stateDirectory: join(directory, 'first') });
    assert.equal(first.status, 'failed');
    const id = Object.keys((await readRemoteState(remote.repository)).journal.state.candidates)[0];
    remote.fault(undefined); upstream.advance();
    const recovered = await updateRules({ ...common, stateDirectory: join(directory, 'new-machine') });
    assert.equal(recovered.status, 'processed');
    assert.equal(recovered.results[0].status, 'processed');
    if (recovered.results[0].status === 'processed') assert.equal(recovered.results[0].candidate.id, id);
    assert.equal(remote.writes.filter(files => Object.keys(files).some(path => path.endsWith('/domains.json'))).length, 1);
    assert.equal(Object.keys((await readRemoteState(remote.repository)).journal.state.candidates).length, 1);
    const status = await readRemoteStatus({ repository: remote.repository, publication: remote.publication, binary });
    assert.equal(status.candidateAvailability[id].verification, 'native');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('同批成功兄弟候选不重发，可从新目录选择失败集按固定 Release 重试', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-selected-retry-'));
  try {
    const remote = memoryRepository(), upstream = source([
      { name: 'openai', length: 1, rules: ['domain:openai.com'] },
      { name: 'anthropic', length: 1, rules: ['domain:anthropic.com'] },
    ]);
    const config = JSON.parse(configuration);
    config.ruleSets.push({ id: 'ai-anthropic', list: 'anthropic', stablePath: 'stable/ai-anthropic' });
    await initializeRemoteState(remote.repository, 'acceptance-recovery');
    remote.fault((files, applied) => {
      if (!applied && Object.entries(files).some(([path, bytes]) => path.endsWith('/manifest.json')
        && JSON.parse(bytes.toString()).id === 'ai-anthropic')) throw new Error('Anthropic publication interrupted');
    });
    const common = { binary: binary!, configuration: JSON.stringify(config), publication: remote.publication, fetch: upstream.fetcher };
    assert.equal((await updateRules({ ...common, stateDirectory: join(directory, 'first') })).status, 'partial');
    const before = (await readRemoteState(remote.repository)).journal.state;
    const original = before.configuredProcessed!['ai-openai']['42'].candidateId;
    remote.fault(undefined); upstream.advance();
    const retry = await updateRules({ ...common, stateDirectory: join(directory, 'new'), selectedIds: ['ai-anthropic'], retryRelease: tag });
    assert.equal(retry.status, 'processed');
    const after = (await readRemoteState(remote.repository)).journal.state;
    assert.equal(after.configuredProcessed!['ai-openai']['42'].candidateId, original);
    assert.equal(Object.keys(after.candidates).length, 2);
    assert.equal(after.pendingOperation!.status, 'complete');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('完整证据提交后未完成回读，新机器不依赖上游重新构建即可核验复用', { skip: !binary }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-evidence-'));
  try {
    const remote = memoryRepository(), upstream = source();
    await initializeRemoteState(remote.repository, 'acceptance-recovery');
    let failReadback = true;
    const publication = { ...remote.publication, async download(url: string) {
      if (failReadback && url.endsWith('/readback.json')) throw new Error('readback unavailable');
      return remote.publication.download(url);
    } };
    const common = { binary: binary!, configuration, publication, fetch: upstream.fetcher };
    assert.equal((await updateRules({ ...common, stateDirectory: join(directory, 'first') })).status, 'failed');
    const before = await readRemoteState(remote.repository);
    const candidate = Object.values(before.journal.state.candidates)[0];
    assert.equal(candidate.phase, 'evidence');
    failReadback = false;
    const recovered = await updateRules({ ...common, stateDirectory: join(directory, 'new'), fetch: async () => {
      throw new Error('Complete candidate recovery must not redownload upstream');
    } });
    assert.equal(recovered.status, 'processed');
    assert.equal(remote.writes.filter(files => Object.keys(files).some(path => path.endsWith('/readback.json'))).length, 1);
    assert.equal(Object.keys((await readRemoteState(remote.repository)).journal.state.candidates).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
