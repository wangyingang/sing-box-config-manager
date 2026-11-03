import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyActivationCandidate } from '../../src/activation.js';
import { rebuildRules, updateRules, readUpdateState } from '../../src/update.js';
import { sha256 } from '../../src/release.js';
import type { PublicationTransport } from '../../src/publication.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const tag = '20261102130044';
function environment() {
  let input = JSON.stringify({ lists: [{ name: 'category-ai-!cn', length: 2, rules: ['domain:example.com', 'full:other.test'] }] });
  let assetId = 11, commitCount = 0, fail = '';
  const requests: string[] = [];
  const stored = new Map<string, Buffer>();
  const release = () => ({ id: 42, tag_name: tag, assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, i) => ({
    id: i === 0 ? assetId : 12, name, browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}`,
  })) });
  const fetcher: typeof fetch = async url => {
    const path = String(url); requests.push(path);
    if (path.endsWith('/latest') || path.endsWith('/releases/42')) return Response.json(release());
    if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (fail === 'download') throw new Error('download failed');
    if (path.endsWith(`/assets/${assetId}`)) return new Response(input);
    if (path.endsWith('/assets/12')) return new Response(`${sha256(input)}  dlc.dat_plain.yml\n`);
    throw new Error(`Unexpected request ${path}`);
  };
  const publication: PublicationTransport = {
    async commit(files) {
      if (fail === 'upload') throw new Error('upload failed');
      const commit = (++commitCount).toString(16).padStart(40, '0');
      for (const [path, bytes] of Object.entries(files)) stored.set(`${commit}/${path}`, Buffer.from(bytes));
      return commit;
    },
    async download(url) {
      const bytes = stored.get(new URL(url).pathname.split('/').slice(3).join('/'));
      assert.ok(bytes);
      return fail === 'readback' ? Buffer.from('corrupt') : Buffer.from(bytes);
    },
  };
  return { fetcher, publication, requests, stored, setFailure(value: string) { fail = value; },
    changeId() { assetId++; }, changeInput() { input = input.replace('example.com', 'changed.com'); } };
}
async function isolated(run: (directory: string, env: ReturnType<typeof environment>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'issue-22-rebuild-'));
  try { await run(directory, environment()); } finally { await rm(directory, { recursive: true, force: true }); }
}
const options = (directory: string, env: ReturnType<typeof environment>) => ({ stateDirectory: directory, binary: binary!, fetch: env.fetcher, publication: env.publication });

test('同一 Release 重建复验固定 ID、保留历史与成功处理记录、字节确定且不激活', async () => isolated(async (directory, env) => {
  const initial = await updateRules(options(directory, env));
  assert.equal(initial.status, 'processed');
  if (initial.status !== 'processed') return;
  const before = (await readUpdateState(directory)).state;
  const history = new Map(env.stored);
  const active = '{"revision":"issue-22-isolated-active"}\n';
  await writeFile(join(directory, 'active-version.json'), active);
  const start = env.requests.length;
  const rebuilt = await rebuildRules({ ...options(directory, env), release: tag });
  assert.equal(rebuilt.status, 'processed');
  if (rebuilt.status !== 'processed') return;
  assert.equal(env.requests[start].split('/').at(-1), '42');
  assert.ok(!env.requests.slice(start).some(url => url.endsWith('/latest')));
  assert.notEqual(rebuilt.candidate.id, initial.candidate.id);
  assert.equal(rebuilt.candidate.previousCandidateId, initial.candidate.id);
  assert.equal(rebuilt.candidate.buildId, initial.candidate.buildId);
  const file = (candidate: typeof initial.candidate, name: string) => env.stored.get(`${candidate.filesCommit}/candidates/${candidate.id}/${name}`)!;
  for (const name of ['domains.json', 'domains.srs']) assert.deepEqual(file(initial.candidate, name), file(rebuilt.candidate, name));
  const build = JSON.parse(env.stored.get(`${rebuilt.candidate.metadataCommit}/candidates/${rebuilt.candidate.id}/build.json`)!.toString());
  assert.equal(build.operation, 'rebuild');
  assert.match(build.tools.implementationSha256, /^[a-f0-9]{64}$/);
  assert.equal(build.contracts.artifactManifest, 1);
  assert.equal(build.tool.version, '1.14.4');
  assert.ok(build.tool.sha256);
  for (const [path, bytes] of history) assert.deepEqual(env.stored.get(path), bytes);
  const after = (await readUpdateState(directory)).state;
  assert.deepEqual(after.processed, before.processed);
  assert.deepEqual(after.pinned, before.pinned);
  assert.deepEqual(after.candidates[initial.candidate.id], before.candidates[initial.candidate.id]);
  assert.equal(after.candidates[rebuilt.candidate.id].status, 'verified');
  const activationTransport = { branch: 'acceptance-issue-22-test', download: env.publication.download,
    async head(): Promise<string> { throw new Error('must not access stable head'); },
    async commit(): Promise<string> { throw new Error('must not activate'); } };
  for (const candidate of [initial.candidate, rebuilt.candidate]) {
    const verified = await verifyActivationCandidate({ candidateEvidenceUrl: candidate.evidenceUrl!, binary: binary! }, activationTransport);
    assert.equal(verified.candidateId, candidate.id);
  }
  // Re-seal transport digests so unsupported contracts reach the version gate.
  const buildKey = `${rebuilt.candidate.metadataCommit}/candidates/${rebuilt.candidate.id}/build.json`;
  const evidenceKey = `${rebuilt.candidate.evidenceCommit}/candidates/${rebuilt.candidate.id}/readback.json`;
  const originalBuild = env.stored.get(buildKey)!, originalEvidence = env.stored.get(evidenceKey)!;
  for (const contracts of [null, { artifactManifest: 2, sourceFormat: 4, buildRecord: 1 },
    { artifactManifest: 1, sourceFormat: 4 }, { artifactManifest: 1, sourceFormat: 4, buildRecord: 2 }]) {
    const changedBuild = Buffer.from(JSON.stringify({ ...JSON.parse(originalBuild.toString()), contracts }));
    const changedEvidence = JSON.parse(originalEvidence.toString());
    const receipt = changedEvidence.readback.find((item: { url: string }) => item.url.endsWith('/build.json'));
    receipt.sha256 = sha256(changedBuild); receipt.byteLength = changedBuild.length;
    env.stored.set(buildKey, changedBuild);
    env.stored.set(evidenceKey, Buffer.from(JSON.stringify(changedEvidence)));
    await assert.rejects(verifyActivationCandidate({ candidateEvidenceUrl: rebuilt.candidate.evidenceUrl!, binary: binary! }, activationTransport), /Unsupported build contracts/);
  }
  env.stored.set(buildKey, originalBuild); env.stored.set(evidenceKey, originalEvidence);
  assert.equal(await readFile(join(directory, 'active-version.json'), 'utf8'), active);
  const count = env.requests.length;
  const remoteCount = env.stored.size;
  assert.equal((await updateRules({ ...options(directory, env), binary: '/must-not-run' })).status, 'skipped');
  assert.equal(env.requests.length, count + 1);
  assert.equal(env.stored.size, remoteCount);
}));

for (const failure of ['download', 'native', 'upload', 'readback', 'identity', 'content']) {
  test(`重建 ${failure} 失败保留已通过候选和成功记录，允许再次重试`, async () => isolated(async (directory, env) => {
    await updateRules(options(directory, env));
    const before = (await readUpdateState(directory)).state;
    const history = new Map(env.stored);
    env.setFailure(failure);
    if (failure === 'identity') env.changeId();
    if (failure === 'content') env.changeInput();
    await assert.rejects(rebuildRules({ ...options(directory, env), release: tag,
      binary: failure === 'native' ? '/missing-issue-22-binary' : binary! }),
      ['identity', 'content'].includes(failure) ? /SOURCE_CHANGED/ : /failed|mismatch|validation/i);
    const after = (await readUpdateState(directory)).state;
    assert.deepEqual(after.processed, before.processed);
    assert.deepEqual(after.pinned, before.pinned);
    assert.equal(Object.values(after.candidates).filter(c => c.status === 'failed').length, 1);
    assert.deepEqual(after.candidates[before.processed['42'].candidateId], before.candidates[before.processed['42'].candidateId]);
    for (const [path, bytes] of history) assert.deepEqual(env.stored.get(path), bytes);
    if (['identity', 'content'].includes(failure)) return;
    env.setFailure('');
    assert.equal((await rebuildRules({ ...options(directory, env), release: tag })).status, 'processed');
    assert.deepEqual((await readUpdateState(directory)).state.processed, before.processed);
  }));
}

test('目标 binary 字节变化记录新的构建身份，原历史不被改写', async () => isolated(async (directory, env) => {
  const first = await updateRules(options(directory, env));
  if (first.status !== 'processed') assert.fail('initial build');
  const copied = join(directory, 'sing-box-issue-22');
  await copyFile(binary!, copied);
  // Executable trailing bytes change tool identity without changing supported version or rule semantics.
  await appendFile(copied, '\nissue-22-tool-identity\n');
  const next = await rebuildRules({ ...options(directory, env), release: tag, binary: copied });
  if (next.status !== 'processed') assert.fail('rebuilt');
  assert.notEqual(next.candidate.buildId, first.candidate.buildId);
  assert.equal((await readUpdateState(directory)).state.candidates[first.candidate.id].buildId, first.candidate.buildId);
}));
