import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { updateRules, readUpdateState } from '../../src/update.js';
import { sha256 } from '../../src/release.js';
import type { PublicationTransport } from '../../src/publication.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const tag = '20261102130044';
function environment() {
  let input = JSON.stringify({ lists: [{ name: 'category-ai-!cn', length: 1, rules: ['domain:example.com'] }] });
  let assetId = 11;
  let failDownload = false;
  const requests: string[] = [];
  const fetcher: typeof fetch = async url => {
    const path = String(url); requests.push(path);
    if (path.endsWith('/latest')) {
      return Response.json({ id: 42, tag_name: tag, assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, i) => ({
        id: i === 0 ? assetId : 12, name, browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}`,
      })) });
    }
    if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (failDownload) throw new Error('asset offline');
    if (path.endsWith(`/assets/${assetId}`)) return new Response(input);
    if (path.endsWith('/assets/12')) return new Response(`${sha256(input)}  dlc.dat_plain.yml\n`);
    throw new Error(`Unexpected request ${path}`);
  };
  const stored = new Map<string, Buffer>();
  const commits: Record<string, Buffer>[] = [];
  let failCommit = 0, corrupt = '', failRead = false;
  const publication: PublicationTransport = {
    async commit(files) {
      commits.push(files);
      if (commits.length === failCommit) throw new Error('upload failed');
      const commit = commits.length.toString(16).padStart(40, '0');
      for (const [path, bytes] of Object.entries(files)) stored.set(`${commit}/${path}`, bytes);
      return commit;
    },
    async download(url) {
      if (failRead) throw new Error('readback offline');
      const path = new URL(url).pathname.split('/').slice(3).join('/');
      const bytes = stored.get(path);
      assert.ok(bytes, `missing remote ${path}`);
      return url.endsWith(corrupt) && corrupt ? Buffer.concat([bytes, Buffer.from('corrupt')]) : bytes;
    },
  };
  return { fetcher, publication, requests, commits,
    changeInput(value: string) { input = value; }, changeId() { assetId++; }, offline(value: boolean) { failDownload = value; },
    uploadFailure(stage: number) { failCommit = stage; }, readFailure(value: string | boolean) {
      if (typeof value === 'string') corrupt = value; else failRead = value;
    } };
}

async function isolated(run: (directory: string, env: ReturnType<typeof environment>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'update-native-'));
  try { await run(directory, environment()); } finally { await rm(directory, { recursive: true, force: true }); }
}
const options = (directory: string, env: ReturnType<typeof environment>) => ({ stateDirectory: directory, binary: binary!, fetch: env.fetcher, publication: env.publication });

test('正常更新固定一次 latest，分阶段发布后回读真实字节和原生内容，持久成功后跳过', { skip: !binary }, async () => isolated(async (directory, env) => {
  const active = '{"revision":"unchanged"}\n';
  await writeFile(join(directory, 'active-version.json'), active);
  const result = await updateRules(options(directory, env));
  assert.equal(result.status, 'processed');
  assert.equal(env.requests.filter(path => path.endsWith('/latest')).length, 1);
  assert.ok(!env.requests.some(path => path.includes('/releases/tags/')));
  assert.equal(env.commits.length, 3);
  const manifest = JSON.parse(Object.values(env.commits[1])[0].toString());
  assert.equal(manifest.targetVersion, '1.14.4');
  assert.equal(manifest.artifacts.length, 2);
  assert.ok(manifest.artifacts.every((a: { id: string }) => a.id.includes(manifest.revision)));
  assert.deepEqual(manifest.projections.route.artifactIds, manifest.artifacts.map((a: { id: string }) => a.id));
  assert.ok(manifest.artifacts.every((a: { url: string; termCount: number }) => a.url.includes('0'.repeat(39) + '1') && a.termCount === 1));
  assert.deepEqual(manifest.projections['dns-response'], { unavailable: 'empty' });
  const state = await readUpdateState(directory);
  assert.equal(Object.keys(state.state.processed).length, 1);
  assert.equal(Object.values(state.state.candidates)[0].status, 'verified');
  const before = env.requests.length;
  assert.equal((await updateRules(options(directory, env))).status, 'skipped');
  assert.equal(env.requests.length, before + 1);
  assert.equal(env.commits.length, 3);
  assert.equal(await readFile(join(directory, 'active-version.json'), 'utf8'), active);
  env.changeId();
  await assert.rejects(updateRules(options(directory, env)), /SOURCE_CHANGED/);
}));

for (const failure of ['upload1', 'upload2', 'upload3', 'offline', 'domains.json', 'domains.srs', 'manifest.json', 'source.json', 'conversion-report.json', 'build.json', 'readback.json']) {
  test(`${failure} 失败无成功记录，重试创建新候选并重新验证，不复用残留文件`, { skip: !binary }, async () => isolated(async (directory, env) => {
    if (failure.startsWith('upload')) env.uploadFailure(Number(failure.slice(-1)));
    else env.readFailure(failure === 'offline' ? true : failure);
    await assert.rejects(updateRules(options(directory, env)));
    const failed = (await readUpdateState(directory)).state;
    assert.deepEqual(failed.processed, {});
    assert.equal(Object.values(failed.candidates)[0].status, 'failed');
    const oldId = Object.keys(failed.candidates)[0];
    env.uploadFailure(0); env.readFailure(false); env.readFailure('');
    assert.equal((await updateRules(options(directory, env))).status, 'processed');
    const retried = (await readUpdateState(directory)).state;
    assert.notEqual(retried.processed['42'].candidateId, oldId);
    assert.equal(Object.keys(retried.candidates).length, 2);
  }));
}

for (const failure of ['download', 'convert', 'native', 'identity', 'content']) {
  test(`${failure} 失败允许恢复；固定身份及内容改变时保留原记录并拒绝`, { skip: !binary }, async () => isolated(async (directory, env) => {
    if (failure === 'download') env.offline(true);
    if (failure === 'convert') env.changeInput('lists: [');
    const initial = options(directory, env);
    if (failure === 'native' || failure === 'identity' || failure === 'content') initial.binary = '/missing-binary';
    await assert.rejects(updateRules(initial));
    const before = (await readUpdateState(directory)).state;
    assert.deepEqual(before.processed, {});
    assert.equal(env.commits.length, 0);
    if (failure === 'identity') env.changeId();
    if (failure === 'content') env.changeInput(JSON.stringify({ lists: [{ name: 'category-ai-!cn', length: 1, rules: ['domain:changed.com'] }] }));
    if (['identity', 'content'].includes(failure)) {
      await assert.rejects(updateRules(options(directory, env)), /SOURCE_CHANGED/);
      assert.deepEqual((await readUpdateState(directory)).state.pinned, before.pinned);
    } else if (failure === 'convert') {
      // Even a conversion failure pins checksum-verified source, so replacement is rejected.
      env.changeInput('lists: []');
      await assert.rejects(updateRules(options(directory, env)), /SOURCE_CHANGED/);
    } else {
      env.offline(false);
      assert.equal((await updateRules(options(directory, env))).status, 'processed');
    }
  }));
}
