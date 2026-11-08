import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256 } from '../../src/release.js';
import { parseBuildConfiguration } from '../../src/configuration.js';
import { initializeRemoteState, readRemoteState, STATE_PATH } from '../../src/remote-state.js';
import { readRemoteStatus } from '../../src/remote-status.js';
import { rebuildRules, updateRules } from '../../src/update.js';
import { memoryRepository } from '../fixtures/publication-repository.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const commit = 'a'.repeat(40), next = 'b'.repeat(40);
const input = '192.0.2.0/25\n192.0.2.128/25\n2001:db8::/32\n';
const config = parseBuildConfiguration(await readFile(new URL('../../config/china-ip.yml', import.meta.url), 'utf8'));
const configuration = JSON.stringify({ ...config, target: { ...config.target, branch: 'acceptance-recovery' } });

async function fixture(t: Pick<TestContext, 'after'>) {
  const directory = await mkdtemp(join(tmpdir(), 'china-ip-candidate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = memoryRepository();
  await initializeRemoteState(remote.repository, 'acceptance-recovery');
  const requests: string[] = [];
  let head = commit;
  let response = new Response(input);
  const upstream: typeof fetch = async url => {
    const path = String(url);
    requests.push(path);
    if (path.endsWith('/branches/ip-lists')) return Response.json({ name: 'ip-lists', commit: { sha: head } });
    if (path.endsWith(`/${commit}/china46.txt`)) return response.clone();
    throw new Error(`Unexpected source request: ${path}`);
  };
  const options = (machine: string) => ({ stateDirectory: join(directory, machine), binary: binary!,
    configuration, selectedIds: ['china-ip'], publication: remote.publication, fetch: upstream });
  const status = (native?: string) => readRemoteStatus({ repository: remote.repository, publication: remote.publication, binary: native });
  return { remote, options, status, requests, advance() { head = next; }, serve(bytes: string, status = 200) { response = new Response(bytes, { status }); } };
}

test('显式发布及固定 commit 重建经过远端回读，只产生 china-ip 候选', { skip: !binary }, async t => {
  const { remote, options, status, requests, advance } = await fixture(t);
  const result = await updateRules(options('first'));
  const entry = result.results[0];
  assert.equal(entry.status, 'processed');
  if (entry.status !== 'processed') assert.fail('Expected published candidate');
  assert.equal(entry.readback.length, 7);
  const manifest = JSON.parse((await remote.publication.download(entry.candidate.manifestUrl!)).toString());
  assert.deepEqual(manifest.projections.route, manifest.projections['dns-response']);
  assert.deepEqual(manifest.projections['dns-query'], { unavailable: 'empty' });
  assert.deepEqual(manifest.artifacts.map((artifact: {url: string}) => artifact.url.split('/').at(-1)), ['route.json', 'route.srs']);
  assert.deepEqual(manifest.artifacts.map((artifact: { termCount: number }) => artifact.termCount), [3, 2]);
  assert.equal((await status()).candidateAvailability[entry.candidate.id].verification, 'structural');
  assert.equal((await status(binary)).candidateAvailability[entry.candidate.id].verification, 'native');
  const { journal } = await readRemoteState(remote.repository);
  journal.state.configuredProcessed!['china-ip'][entry.candidate.sourceKey!].evidenceUrl = 'https://example.invalid/readback.json';
  remote.replace(STATE_PATH, Buffer.from(JSON.stringify(journal)));
  const repeat = await updateRules(options('repeat'));
  assert.equal(repeat.results[0].status, 'skipped');
  if (repeat.results[0].status === 'skipped') assert.equal(repeat.results[0].evidenceUrl, entry.candidate.evidenceUrl);
  assert.equal(remote.writes.filter(files => Object.keys(files).some(path => path.startsWith('candidates/'))).length, 3);
  requests.length = 0;
  advance();
  const rebuilt = await rebuildRules({ ...options('new'), commit });
  assert.equal(rebuilt.results[0].status, 'processed');
  assert.equal(requests.length, 1);
  assert.match(requests[0], new RegExp(`/${commit}/china46\\.txt$`));
  assert.deepEqual((await status()).activeRuleVersions, {});
  assert.ok((await remote.repository.snapshot()).paths.every(path => !path.startsWith('stable/')));
});

test('固定 commit 后首次下载中断，全新目录仍只读取已登记 commit', { skip: !binary }, async t => {
  const { options, status, requests, advance, serve } = await fixture(t);
  serve('unavailable', 503);
  await assert.rejects(updateRules(options('first')), { code: 'DOWNLOAD_FAILED' });
  const pinned = await status();
  const operation = pinned.state.pendingOperation!;
  assert.equal(operation.status, 'pending');
  assert.equal(pinned.state.commitPins![operation.sourceKey!].identity.commit, commit);
  assert.deepEqual(operation.candidateIds, []);
  advance();
  serve(input);
  requests.length = 0;
  const resumed = await updateRules(options('second'));
  assert.equal(resumed.results[0].status, 'processed');
  assert.deepEqual(requests, [`https://raw.githubusercontent.com/gaoyifan/china-operator-ip/${commit}/china46.txt`]);
  assert.equal((await status()).state.pendingOperation!.id, operation.id);
});

for (const { file, phase } of [
  { file: 'route.json', phase: 'files' }, { file: 'manifest.json', phase: 'metadata' }, { file: 'readback.json', phase: 'evidence' },
]) {
  test(`提交 ${file} 的回复丢失后恢复同一 Git 候选，不重发已提交阶段`, { skip: !binary }, async t => {
    const { remote, options, status, advance, requests } = await fixture(t);
    remote.fault((files, applied) => {
      if (applied && Object.keys(files).some(path => path.endsWith(`/${file}`))) throw new Error('lost reply');
    });
    await assert.rejects(updateRules(options('first')), /PUBLICATION_PENDING/);
    const interrupted = await status();
    const [id] = interrupted.state.pendingOperation!.candidateIds;
    assert.equal(interrupted.state.candidates[id].phase, phase);
    remote.fault(undefined);
    advance();
    requests.length = 0;
    const result = await updateRules(options('second'));
    assert.equal(result.results[0].status, 'processed');
    if (result.results[0].status === 'processed') assert.equal(result.results[0].candidate.id, id);
    assert.equal(remote.writes.filter(files => Object.hasOwn(files, `candidates/${id}/${file}`)).length, 1);
    assert.deepEqual(Object.keys((await status()).state.candidates), [id]);
    assert.equal((await status()).state.pendingOperation!.status, 'complete');
    assert.equal(requests.length, phase === 'evidence' ? 0 : 1);
    assert.ok(requests.every(url => url.endsWith(`/${commit}/china46.txt`)));
  });
}

test('回读提交回复丢失后，远端日志能识别当前树中被替换的证据', { skip: !binary }, async t => {
  const { remote, options, status } = await fixture(t);
  remote.fault((files, applied) => {
    if (applied && Object.keys(files).some(path => path.endsWith('/readback.json'))) throw new Error('lost reply');
  });
  await assert.rejects(updateRules(options('first')), /PUBLICATION_PENDING/);
  remote.fault(undefined);
  const { state } = await status();
  const [id] = state.pendingOperation!.candidateIds;
  assert.equal(state.candidates[id].evidenceCommit, undefined);
  const path = `candidates/${id}/readback.json`;
  const original = await (await remote.repository.snapshot()).read(path);
  // Keep a valid schema and the recorded digests. A newer tree with
  // semantically identical JSON must still match the original evidence bytes.
  remote.replace(path, Buffer.from(JSON.stringify(JSON.parse(original!.toString()))));
  assert.equal((await status()).candidateAvailability[id].status, 'verification-pending');
  await assert.rejects(updateRules(options('second')), /remote readback differs from registered evidence/);
  assert.equal((await status()).state.candidates[id].phase, 'evidence');
});

test('HTTPS 证据回读失败后保留候选进度，全新目录复验时拒绝被改写的 Git 文件', { skip: !binary }, async t => {
  const { remote, options, status, requests } = await fixture(t);
  const first = options('first');
  const originalDownload = first.publication.download;
  first.publication = { ...first.publication, async download(url) {
    if (url.endsWith('/readback.json')) throw new Error('readback unavailable');
    return originalDownload(url);
  } };
  assert.equal((await updateRules(first)).results[0].status, 'failed');
  const state = (await status()).state;
  const [id] = state.pendingOperation!.candidateIds;
  assert.equal(state.candidates[id].phase, 'evidence');
  const path = `candidates/${id}/route.srs`;
  const original = (await remote.repository.snapshot()).read(path);
  remote.replace(path, Buffer.from('corrupt retained bytes'));
  assert.equal((await status()).candidateAvailability[id].status, 'verification-pending');
  await assert.rejects(updateRules(options('damaged')), /CANDIDATE_UNAVAILABLE/);
  remote.replace(path, (await original)!);
  remote.remove(`candidates/${id}/source.json`);
  assert.equal((await status()).candidateAvailability[id].status, 'incomplete');
  await assert.rejects(updateRules(options('missing')), /CANDIDATE_UNAVAILABLE/);
  assert.equal(requests.length, 2);
  assert.equal(remote.writes.filter(files => Object.hasOwn(files, `candidates/${id}/readback.json`)).length, 1);
});

test('恢复元数据阶段时发现已提交规则文件被改写，拒绝完成候选', { skip: !binary }, async t => {
  const { remote, options, status } = await fixture(t);
  remote.fault((files, applied) => {
    if (!applied && Object.keys(files).some(path => path.endsWith('/readback.json'))) throw new Error('interrupted');
  });
  assert.equal((await updateRules(options('first'))).results[0].status, 'failed');
  const before = (await status()).state.pendingOperation!;
  const [id] = before.candidateIds;
  remote.fault(undefined);
  remote.replace(`candidates/${id}/route.srs`, Buffer.from('tampered'));
  assert.equal((await updateRules(options('second'))).results[0].status, 'failed');
  assert.equal((await status()).state.candidates[id].phase, 'metadata');
});

test('固定版本重建缺少输入或历史证据时失败，且不请求分支', { skip: !binary }, async t => {
  const { remote, options, status, requests, serve, advance } = await fixture(t);
  await assert.rejects(rebuildRules({ ...options('unknown'), commit }), /fixed Git commit has no retained source/);
  assert.equal(requests.length, 0);
  await updateRules(options('first'));
  const state = (await status()).state;
  const [id] = state.pendingOperation!.candidateIds;
  const source = state.commitPins![state.candidates[id].sourceKey!].source!;
  assert.equal(source.inputSha256, sha256(input));
  assert.equal(source.inputBytes, Buffer.byteLength(input));
  requests.length = 0;
  advance();
  const path = `candidates/${id}/manifest.json`;
  const manifest = await (await remote.repository.snapshot()).read(path);
  remote.remove(path);
  assert.equal((await status()).candidateAvailability[id].status, 'incomplete');
  await assert.rejects(rebuildRules({ ...options('no-history'), commit }), /CANDIDATE_UNAVAILABLE/);
  assert.equal(requests.length, 0);
  remote.replace(path, manifest!);
  serve('203.0.113.0/24\n');
  await assert.rejects(rebuildRules({ ...options('drift'), commit }), { code: 'SOURCE_CHANGED' });
  assert.equal(requests.length, 1);
  serve('missing', 404);
  await assert.rejects(rebuildRules({ ...options('missing'), commit }), { code: 'DOWNLOAD_FAILED' });
  assert.ok(requests.every(url => url.endsWith(`/${commit}/china46.txt`)));
});

test('同一远端日志同时读取 V2Fly Release 和 Git commit 候选', { skip: !binary }, async t => {
  const { options, status } = await fixture(t);
  const releaseConfig = parseBuildConfiguration(await readFile(new URL('../../config/rulesets.yml', import.meta.url), 'utf8'));
  const release = options('release');
  const tag = '20261104112839';
  const yaml = JSON.stringify({ lists: [{ name: 'openai', length: 1, rules: ['domain:openai.com'] }] });
  const fetchRelease: typeof fetch = async url => {
    const path = String(url);
    if (path.endsWith('/releases/latest')) return Response.json({ id: 42, tag_name: tag,
      assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, index) => ({ id: 11 + index, name,
        browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}` })) });
    if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: commit } });
    if (path.endsWith('/assets/11')) return new Response(yaml);
    if (path.endsWith('/assets/12')) return new Response(`${sha256(yaml)}  dlc.dat_plain.yml\n`);
    throw new Error(`Unexpected source request: ${path}`);
  };
  const domains = await updateRules({ ...release, selectedIds: ['openai'], fetch: fetchRelease,
    configuration: JSON.stringify({ ...releaseConfig, target: { ...releaseConfig.target, branch: 'acceptance-recovery' } }) });
  assert.equal(domains.results[0].status, 'processed');
  assert.equal((await updateRules(options('git'))).results[0].status, 'processed');
  const { state, candidateAvailability } = await status(binary);
  assert.equal(state.pinned['42'].source?.commit, commit);
  const [key] = Object.keys(state.commitPins!);
  assert.equal(state.commitPins![key].source?.commit, commit);
  const releaseId = state.configuredProcessed!.openai['42'].candidateId;
  const gitId = state.configuredProcessed!['china-ip'][key].candidateId;
  assert.notEqual(releaseId, gitId);
  assert.equal(candidateAvailability[releaseId].verification, 'native');
  assert.equal(candidateAvailability[gitId].verification, 'native');
});
