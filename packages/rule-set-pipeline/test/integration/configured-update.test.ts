import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { updateRules, readUpdateState } from '../../src/update.js';
import { sha256 } from '../../src/release.js';
import type { PublicationTransport } from '../../src/publication.js';

const binary = process.env.SING_BOX_TEST_BINARY;
const tag = '20261104112839';
const configuration = `schemaVersion: 1
source: v2fly/domain-list-community
target:
  repository: wangyingang/sing-box-rule-artifacts
  branch: acceptance-issue-37
ruleSets:
  - id: ai-openai
    list: openai
    stablePath: stable/ai-openai
  - id: ai-anthropic
    list: anthropic
    stablePath: stable/ai-anthropic
  - id: ai-google-deepmind
    list: google-deepmind
    stablePath: stable/ai-google-deepmind
`;

function fixture() {
  let lists = [
    { name: 'openai', length: 1, rules: ['domain:openai.com'] },
    { name: 'anthropic', length: 1, rules: ['domain:anthropic.com'] },
    { name: 'google-deepmind', length: 1, rules: ['domain:deepmind.google'] },
  ];
  let corrupt = '', badChecksum = false, rawInput: string | undefined;
  const requests: string[] = [];
  const remote = new Map<string, Buffer>();
  const commits: Record<string, Buffer>[] = [];
  const fetcher: typeof fetch = async url => {
    const path = String(url); requests.push(path);
    if (path.endsWith('/latest') || path.endsWith(`/releases/tags/${tag}`)) return Response.json({ id: 42, tag_name: tag,
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
    badChecksum(value: boolean) { badChecksum = value; }, rawInput(value: string) { rawInput = value; } };
}

async function isolated(run: (directory: string, env: ReturnType<typeof fixture>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'configured-update-'));
  try { await run(directory, fixture()); } finally { await rm(directory, { recursive: true, force: true }); }
}
const options = (directory: string, env: ReturnType<typeof fixture>) => ({
  stateDirectory: directory, binary: binary!, configuration, fetch: env.fetcher, publication: env.publication,
});

test('一次 update 共享固定输入，逐集发布独立候选并在新读取中保留结果', { skip: !binary }, async () => isolated(async (directory, env) => {
  const result = await updateRules(options(directory, env));
  assert.equal(result.status, 'processed');
  assert.deepEqual(result.results.map(entry => [entry.id, entry.status]), [
    ['ai-openai', 'processed'], ['ai-anthropic', 'processed'], ['ai-google-deepmind', 'processed'],
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
  assert.equal((await readFile(join(directory, 'update-state.json'), 'utf8')).includes('ai-google-deepmind'), true);
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
      ['ai-openai', 'processed'], ['ai-anthropic', 'failed'], ['ai-google-deepmind', 'processed'],
    ]);
    const failed = first.results[1];
    assert.ok(failed.status === 'failed');
    assert.match(failed.error, failure === 'readback' ? /Readback content mismatch/ :
      failure === 'invalid' ? /Rule conversion failed/ : /unavailable or invalid/);
    const before = (await readUpdateState(directory)).state;
    assert.equal(before.candidates[failed.candidateId].status, 'failed');
    assert.equal(env.commits.filter(files => Object.keys(files).some(path => path.startsWith('stable/'))).length, 0);
    if (failure === 'readback') {
      env.corruptReadback('');
      const retry = await updateRules({ ...options(directory, env), selectedIds: ['ai-anthropic'] });
      assert.deepEqual(retry.results.map(entry => [entry.id, entry.status]), [['ai-anthropic', 'processed']]);
      const after = (await readUpdateState(directory)).state;
      for (const id of ['ai-openai', 'ai-google-deepmind']) {
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

test('共同 YAML 文档无效时不产生任何候选', { skip: !binary }, async () => isolated(async (directory, env) => {
  env.rawInput('lists: [');
  await assert.rejects(updateRules(options(directory, env)), /Flow sequence/);
  assert.deepEqual((await readUpdateState(directory)).state.candidates, {});
  assert.equal(env.commits.length, 0);
}));

test('同一 Release 后续增选只处理新集，来源摘要变化阻止失败集重试', { skip: !binary }, async () => isolated(async (directory, env) => {
  const first = await updateRules({ ...options(directory, env), selectedIds: ['ai-openai'] });
  assert.deepEqual(first.results.map(entry => [entry.id, entry.status]), [['ai-openai', 'processed']]);
  const expanded = await updateRules(options(directory, env));
  assert.deepEqual(expanded.results.map(entry => [entry.id, entry.status]), [
    ['ai-openai', 'skipped'], ['ai-anthropic', 'processed'], ['ai-google-deepmind', 'processed'],
  ]);
  const before = (await readUpdateState(directory)).state;
  env.setLists([{ name: 'anthropic', length: 1, rules: ['domain:changed.example'] }]);
  await assert.rejects(updateRules({ ...options(directory, env), selectedIds: ['ai-anthropic'],
    configuration: configuration.replace('stable/ai-anthropic', 'stable/ai-anthropic-new') }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual((await readUpdateState(directory)).state.configuredProcessed, before.configuredProcessed);
}));
