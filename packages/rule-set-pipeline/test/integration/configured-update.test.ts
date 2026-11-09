import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rebuildRules, updateRules, readUpdateState } from '../../src/update.js';
import { sha256 } from '../../src/release.js';
import type { PublicationTransport } from '../../src/publication.js';
import { releaseConfiguration } from '../fixtures/release-configuration.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const tag = '20261104112839';
const configuration = releaseConfiguration();

function fixture() {
  let lists = [
    { name: 'openai', length: 1, rules: ['domain:openai.com'] },
    { name: 'anthropic', length: 1, rules: ['domain:anthropic.com'] },
    { name: 'google-deepmind', length: 1, rules: ['domain:deepmind.google'] },
  ];
  let corrupt = '', badChecksum = false, rawInput: string | undefined, latestAdvanced = false;
  const requests: string[] = [];
  const remote = new Map<string, Buffer>();
  const commits: Record<string, Buffer>[] = [];
  const fetcher: typeof fetch = async url => {
    const path = String(url); requests.push(path);
    if (path.endsWith('/latest') && latestAdvanced) return Response.json({ id: 43, tag_name: '20261105120000', assets: [] });
    if (path.endsWith('/latest') || path.endsWith(`/releases/tags/${tag}`) || path.endsWith('/releases/42')) return Response.json({ id: 42, tag_name: tag,
      assets: ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, i) => ({ id: 11 + i, name,
        browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}` })) });
    if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    const input = rawInput ?? JSON.stringify({ lists });
    if (path.endsWith('/assets/11')) return new Response(input);
    if (path.endsWith('/assets/12')) return new Response(`${badChecksum ? '0'.repeat(64) : sha256(input)}  dlc.dat_plain.yml\n`);
    throw new Error(`Unexpected source request: ${path}`);
  };
  const publication: PublicationTransport = {
    async commit(files) {
      commits.push(files);
      const commit = commits.length.toString(16).padStart(40, '0');
      for (const [path, bytes] of Object.entries(files)) remote.set(`${commit}/${path}`, bytes);
      return commit;
    },
    async download(url) {
      const key = new URL(url).pathname.split('/').slice(3).join('/');
      const bytes = remote.get(key);
      assert.ok(bytes, `Missing remote file ${key}`);
      return corrupt && url.includes(corrupt) && Number.parseInt(key.split('/')[0], 16) === 4
        ? Buffer.concat([bytes, Buffer.from('bad')]) : bytes;
    },
  };
  return { requests, remote, commits, fetcher, publication,
    setLists(value: typeof lists) { lists = value; }, corruptReadback(value: string) { corrupt = value; },
    badChecksum(value: boolean) { badChecksum = value; }, rawInput(value: string) { rawInput = value; },
    advanceLatest() { latestAdvanced = true; } };
}

async function isolated(run: (directory: string, env: ReturnType<typeof fixture>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'configured-update-'));
  try { await run(directory, fixture()); } finally { await rm(directory, { recursive: true, force: true }); }
}
const options = (directory: string, env: ReturnType<typeof fixture>) => ({
  stateDirectory: directory, binary: binary!, configuration, fetch: env.fetcher, publication: env.publication,
});

test('单独重建固定 Release 的成功集保留原候选、成功记录与激活回执', { skip: !binary }, async () => isolated(async (directory, env) => {
  const first = await updateRules({ ...options(directory, env), selectedIds: ['openai'] });
  const original = first.results[0];
  assert.ok(original.status === 'processed');
  const receipt = { status: 'activated', commit: 'b'.repeat(40), activation: { logicalId: 'openai', candidateId: original.candidate.id } };
  await mkdir(join(directory, 'active-rule-versions'));
  await writeFile(join(directory, 'active-rule-versions/openai.json'), JSON.stringify(receipt));
  const before = await readUpdateState(directory);
  const requestStart = env.requests.length;
  env.advanceLatest();
  const rebuilt = await rebuildRules({ ...options(directory, env), selectedIds: ['openai'], release: tag });
  assert.equal(rebuilt.status, 'processed');
  const entry = rebuilt.results[0];
  assert.ok(entry.status === 'processed');
  assert.equal(entry.candidate.operation, 'rebuild');
  assert.equal(entry.candidate.previousCandidateId, original.candidate.id);
  assert.notEqual(entry.candidate.id, original.candidate.id);
  assert.equal(entry.candidate.buildId, original.candidate.buildId);
  assert.ok(env.requests.slice(requestStart).some(url => url.endsWith('/releases/42')));
  assert.ok(env.requests.slice(requestStart).every(url => !url.endsWith('/latest')));
  const after = await readUpdateState(directory);
  assert.deepEqual(after.state.configuredProcessed, before.state.configuredProcessed);
  assert.deepEqual(after.state.candidates[original.candidate.id], before.state.candidates[original.candidate.id]);
  assert.deepEqual(after.activeRuleVersions, before.activeRuleVersions);
  for (const candidate of [original, entry]) {
    for (const file of candidate.readback) {
      const actual = await env.publication.download(file.url);
      assert.equal(sha256(actual), file.sha256);
      assert.equal(actual.length, file.byteLength);
    }
  }
  assert.ok(env.commits.every(files => Object.keys(files).every(path => path.startsWith('candidates/'))));
  const status = await readUpdateState(directory);
  assert.equal(status.state.candidates[entry.candidate.id].operation, 'rebuild');
  assert.deepEqual(status.activeRuleVersions.openai, receipt);
  const skipped = await updateRules({ ...options(directory, env), selectedIds: ['openai'], retryRelease: tag, binary: '/must-not-run' });
  assert.ok(skipped.results[0].status === 'skipped');
  assert.equal(skipped.results[0].candidateId, original.candidate.id);
}));

test('重建回读失败仍保留原成功记录，修复后可重试且不影响兄弟集', { skip: !binary }, async () => isolated(async (directory, env) => {
  await updateRules({ ...options(directory, env), selectedIds: ['openai', 'anthropic'] });
  const before = await readUpdateState(directory);
  const publication: PublicationTransport = { ...env.publication, async download(url) {
    const bytes = await env.publication.download(url);
    return url.endsWith('/domains.srs') ? Buffer.concat([bytes, Buffer.from('bad')]) : bytes;
  } };
  const failed = await rebuildRules({ ...options(directory, env), publication, selectedIds: ['openai'], release: tag });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.results[0].status === 'failed');
  assert.match(failed.results[0].error, /Readback content mismatch/);
  const afterFailure = await readUpdateState(directory);
  assert.deepEqual(afterFailure.state.configuredProcessed, before.state.configuredProcessed);
  for (const [id, candidate] of Object.entries(before.state.candidates)) assert.deepEqual(afterFailure.state.candidates[id], candidate);
  const retried = await rebuildRules({ ...options(directory, env), selectedIds: ['openai'], release: tag });
  assert.ok(retried.results[0].status === 'processed');
  assert.notEqual(retried.results[0].candidate.id, failed.results[0].candidateId);
  assert.deepEqual((await readUpdateState(directory)).state.configuredProcessed, before.state.configuredProcessed);
  for (const candidate of Object.values(before.state.candidates)) {
    assert.ok((await env.publication.download(candidate.evidenceUrl!)).length);
  }
}));

test('重建要求所选定义已成功处理，update 会处理同一 Release 下变更的定义', { skip: !binary }, async () => isolated(async (directory, env) => {
  const base = { ...options(directory, env), release: tag };
  await assert.rejects(rebuildRules({ ...base, selectedIds: ['openai'] }), /previously pinned/);
  await updateRules({ ...options(directory, env), selectedIds: ['openai'] });
  const count = env.requests.length, commits = env.commits.length;
  for (const extra of [
    { selectedIds: ['anthropic'] }, { selectedIds: [] }, { selectedIds: ['unknown'] },
    { selectedIds: ['openai', 'openai'] },
    { selectedIds: ['openai'], configuration: configuration.replace('list: openai', 'list: anthropic') },
    { selectedIds: ['openai'], configuration: configuration.replace('stable/openai', 'stable/new-openai') },
  ]) await assert.rejects(rebuildRules({ ...base, ...extra }));
  for (const release of ['', 'latest', 'LATEST']) assert.throws(() => rebuildRules({ ...base, selectedIds: ['openai'], release }), /fixed Release/);
  assert.equal(env.requests.length, count);
  assert.equal(env.commits.length, commits);
  const changed = { ...options(directory, env), selectedIds: ['openai'],
    configuration: configuration.replace('list: openai', 'list: anthropic') };
  const updated = await updateRules(changed);
  assert.ok(updated.results[0].status === 'processed');
  const json = updated.results[0].readback.find(file => file.url.endsWith('/domains.json'))!;
  assert.match((await env.publication.download(json.url)).toString(), /anthropic.com/);
  assert.equal((await updateRules(changed)).status, 'skipped');
}));

for (const changed of ['release', 'asset', 'commit', 'bytes']) {
  test(`重建拒绝固定来源 ${changed} 变化并保留成功记录`, { skip: !binary }, async () => isolated(async (directory, env) => {
    await updateRules({ ...options(directory, env), selectedIds: ['openai'] });
    const before = await readUpdateState(directory), commits = env.commits.length;
    if (changed === 'bytes') env.setLists([{ name: 'openai', length: 1, rules: ['domain:changed.example'] }]);
    const fetcher: typeof fetch = async (url, init) => {
      const response = await env.fetcher(url, init), path = String(url);
      if (path.endsWith('/releases/42') && (changed === 'release' || changed === 'asset')) {
        const metadata = await response.json();
        if (changed === 'release') metadata.id = 43;
        else metadata.assets[0].id = 99;
        return Response.json(metadata);
      }
      if (changed === 'commit' && path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } });
      return response;
    };
    await assert.rejects(rebuildRules({ ...options(directory, env), fetch: fetcher, selectedIds: ['openai'], release: tag }),
      error => (error as { code?: string }).code === 'SOURCE_CHANGED' || /SOURCE_CHANGED/.test(String(error)));
    const after = await readUpdateState(directory);
    assert.deepEqual(after.state.configuredProcessed, before.state.configuredProcessed);
    assert.deepEqual(after.state.pinned, before.state.pinned);
    assert.equal(env.commits.length, commits);
  }));
}

test('一次 update 共享固定输入，逐集发布独立候选并在新读取中保留结果', { skip: !binary }, async () => isolated(async (directory, env) => {
  const result = await updateRules(options(directory, env));
  assert.equal(result.status, 'processed');
  assert.deepEqual(result.results.map(entry => [entry.id, entry.status]), [
    ['openai', 'processed'], ['anthropic', 'processed'], ['google-deepmind', 'processed'],
  ]);
  assert.equal(env.requests.filter(url => url.endsWith('/assets/11')).length, 1);
  assert.equal(env.requests.filter(url => url.endsWith('/assets/12')).length, 1);
  const state = (await readUpdateState(directory)).state;
  for (const entry of result.results) {
    assert.ok(entry.status === 'processed');
    assert.equal(state.candidates[entry.candidate.id].status, 'verified');
    const manifest = JSON.parse([...env.remote.entries()].find(([path]) => path.endsWith(`/candidates/${entry.candidate.id}/manifest.json`))![1].toString());
    assert.equal(manifest.id, entry.id);
    assert.equal(manifest.artifacts.length, 2);
    assert.deepEqual(manifest.projections.route, manifest.projections['dns-query']);
    assert.deepEqual(manifest.projections['dns-response'], { unavailable: 'empty' });
    for (const artifact of manifest.artifacts) {
      const actual = await env.publication.download(artifact.url);
      assert.equal(actual.length, artifact.byteLength);
      assert.equal(sha256(actual), artifact.sha256);
      assert.equal(artifact.termCount, 1);
    }
  }
  assert.equal((await readFile(join(directory, 'update-state.json'), 'utf8')).includes('google-deepmind'), true);
  assert.equal(env.commits.length, 9);
}));

for (const failure of ['missing', 'invalid', 'readback']) {
  test(`Anthropic ${failure} 时保留兄弟候选${failure === 'readback' ? '，修复后可单独重试' : ''}`, { skip: !binary }, async () => isolated(async (directory, env) => {
    if (failure === 'missing') env.setLists([
      { name: 'openai', length: 1, rules: ['domain:openai.com'] },
      { name: 'google-deepmind', length: 1, rules: ['domain:deepmind.google'] },
    ]);
    if (failure === 'invalid') env.setLists([
      { name: 'openai', length: 1, rules: ['domain:openai.com'] },
      { name: 'anthropic', length: 1, rules: ['domain:bad^'] },
      { name: 'google-deepmind', length: 1, rules: ['domain:deepmind.google'] },
    ]);
    if (failure === 'readback') env.corruptReadback('/domains.srs');
    const first = await updateRules(options(directory, env));
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.results.map(entry => [entry.id, entry.status]), [
      ['openai', 'processed'], ['anthropic', 'failed'], ['google-deepmind', 'processed'],
    ]);
    const failed = first.results[1];
    assert.ok(failed.status === 'failed');
    assert.match(failed.error, failure === 'readback' ? /Readback content mismatch/ :
      failure === 'invalid' ? /Rule conversion failed/ : /unavailable or invalid/);
    const before = (await readUpdateState(directory)).state;
    assert.equal(before.candidates[failed.candidateId].status, 'failed');
    const status = await readUpdateState(directory);
    assert.equal(status.state.candidates[failed.candidateId].logicalId, 'anthropic');
    assert.equal(status.state.configuredProcessed!['openai']['42'].candidateId,
      before.configuredProcessed!['openai']['42'].candidateId);
    assert.equal(env.commits.filter(files => Object.keys(files).some(path => path.startsWith('stable/'))).length, 0);
    if (failure === 'readback') {
      env.corruptReadback('');
      const retry = await updateRules({ ...options(directory, env), selectedIds: ['anthropic'] });
      assert.deepEqual(retry.results.map(entry => [entry.id, entry.status]), [['anthropic', 'processed']]);
      const after = (await readUpdateState(directory)).state;
      for (const id of ['openai', 'google-deepmind']) {
        assert.deepEqual(after.configuredProcessed?.[id], before.configuredProcessed?.[id]);
        assert.ok(after.candidates[before.configuredProcessed![id]['42'].candidateId]);
      }
      assert.ok(retry.results[0].status === 'processed');
      assert.ok(after.candidates[retry.results[0].candidate.id]);
    }
  }));
}

test('共同输入摘要损坏时不产生任何候选', { skip: !binary }, async () => isolated(async (directory, env) => {
  env.badChecksum(true);
  await assert.rejects(updateRules(options(directory, env)), { code: 'CHECKSUM_MISMATCH' });
  assert.deepEqual((await readUpdateState(directory)).state.candidates, {});
  assert.equal(env.commits.length, 0);
}));

test('latest 前进后仍可按固定来源单独重试 Anthropic', { skip: !binary }, async () => isolated(async (directory, env) => {
  env.corruptReadback('/domains.srs');
  const first = await updateRules(options(directory, env));
  assert.equal(first.status, 'partial');
  const before = (await readUpdateState(directory)).state;
  env.corruptReadback(''); env.advanceLatest();
  const requestCount = env.requests.length;
  const retry = await updateRules({ ...options(directory, env), selectedIds: ['anthropic'], retryRelease: tag });
  assert.deepEqual(retry.results.map(entry => [entry.id, entry.status]), [['anthropic', 'processed']]);
  assert.equal(retry.releaseId, 42);
  assert.ok(env.requests.slice(requestCount).some(url => url.endsWith('/releases/42')));
  assert.ok(!env.requests.slice(requestCount).some(url => url.endsWith('/latest')));
  const after = (await readUpdateState(directory)).state;
  for (const id of ['openai', 'google-deepmind']) {
    assert.deepEqual(after.configuredProcessed?.[id], before.configuredProcessed?.[id]);
  }
}));

test('共同 YAML 文档无效时不产生任何候选', { skip: !binary }, async () => isolated(async (directory, env) => {
  env.rawInput('lists: [');
  await assert.rejects(updateRules(options(directory, env)), /Flow sequence/);
  assert.deepEqual((await readUpdateState(directory)).state.candidates, {});
  assert.equal(env.commits.length, 0);
}));

test('同一 Release 后续增选只处理新集，来源摘要变化阻止失败集重试', { skip: !binary }, async () => isolated(async (directory, env) => {
  const first = await updateRules({ ...options(directory, env), selectedIds: ['openai'] });
  assert.deepEqual(first.results.map(entry => [entry.id, entry.status]), [['openai', 'processed']]);
  const expanded = await updateRules(options(directory, env));
  assert.deepEqual(expanded.results.map(entry => [entry.id, entry.status]), [
    ['openai', 'skipped'], ['anthropic', 'processed'], ['google-deepmind', 'processed'],
  ]);
  const before = (await readUpdateState(directory)).state;
  env.setLists([{ name: 'anthropic', length: 1, rules: ['domain:changed.example'] }]);
  await assert.rejects(updateRules({ ...options(directory, env), selectedIds: ['anthropic'],
    configuration: configuration.replace('stable/anthropic', 'stable/anthropic-new') }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual((await readUpdateState(directory)).state.configuredProcessed, before.configuredProcessed);
}));

test('合法逻辑 ID constructor 的成功记录可跨进程持久化并跳过', { skip: !binary }, async () => isolated(async (directory, env) => {
  const custom = configuration.replace('id: openai', 'id: constructor').replace('stable/openai', 'stable/constructor');
  const selected = { ...options(directory, env), configuration: custom, selectedIds: ['constructor'] };
  const first = await updateRules(selected);
  assert.deepEqual(first.results.map(entry => [entry.id, entry.status]), [['constructor', 'processed']]);
  const state = (await readUpdateState(directory)).state;
  assert.ok(Object.hasOwn(state.configuredProcessed!, 'constructor'));
  assert.ok(state.configuredProcessed?.['constructor']?.['42'].candidateId);
  const second = await updateRules(selected);
  assert.deepEqual(second.results.map(entry => [entry.id, entry.status]), [['constructor', 'skipped']]);
}));

test('最终状态落盘暂时失败后不留下错误的成功记录', { skip: !binary }, async () => isolated(async (directory, env) => {
  const originalRename = fsPromises.rename;
  let failedOnce = false;
  fsPromises.rename = async (from, to) => {
    if (!failedOnce && String(to) === join(directory, 'update-state.json')) {
      const state = JSON.parse(await readFile(from, 'utf8'));
      if (state.configuredProcessed?.['anthropic']?.['42'] &&
          Object.values(state.candidates).some((candidate: any) => candidate.logicalId === 'anthropic' && candidate.status === 'verified')) {
        failedOnce = true;
        throw new Error('transient final checkpoint');
      }
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const first = await updateRules({ ...options(directory, env), selectedIds: ['anthropic'] });
    assert.equal(failedOnce, true);
    assert.deepEqual(first.results.map(entry => entry.status), ['failed']);
    const state = (await readUpdateState(directory)).state;
    assert.equal(state.configuredProcessed?.['anthropic']?.['42'], undefined);
    assert.equal(Object.values(state.candidates)[0].status, 'failed');
    const retry = await updateRules({ ...options(directory, env), selectedIds: ['anthropic'] });
    assert.deepEqual(retry.results.map(entry => entry.status), ['processed']);
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
}));
