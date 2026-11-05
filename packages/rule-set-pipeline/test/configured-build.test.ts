import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../src/release.js';
import { buildConfiguredRelease, parseBuildConfiguration } from '../src/configured-build.js';

const tag = '20261104112839';
const configuration = `schemaVersion: 1
source: v2fly/domain-list-community
target:
  repository: wangyingang/sing-box-rule-artifacts
  branch: main
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
const yaml = JSON.stringify({ lists: [
  { name: 'openai', length: 1, rules: ['domain:openai.com'] },
  { name: 'anthropic', length: 1, rules: ['domain:anthropic.com'] },
  { name: 'google-deepmind', length: 1, rules: ['domain:deepmind.google'] },
] });
function upstream(input = yaml, checksum = sha256(input)) {
  const requests: string[] = [];
  const assets = ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, index) => ({
    id: index + 11, name, browser_download_url: `https://github.com/v2fly/domain-list-community/releases/download/${tag}/${name}`,
  }));
  const fetcher: typeof fetch = async url => {
    const path = String(url); requests.push(path);
    if (path.endsWith(`/releases/tags/${tag}`)) return Response.json({ id: 42, tag_name: tag, assets });
    if (path.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (path.endsWith('/assets/11')) return new Response(input);
    if (path.endsWith('/assets/12')) return new Response(`${checksum}  dlc.dat_plain.yml\n`);
    throw new Error(`unexpected ${path}`);
  };
  return { fetcher, requests };
}

test('配置在写入前拒绝重复 ID、路径冲突和越界目标', () => {
  for (const invalid of [
    configuration.replace('id: ai-anthropic', 'id: ai-openai'),
    configuration.replace('stable/ai-anthropic', 'stable/ai-openai'),
    configuration.replace('stable/ai-anthropic', 'stable/../outside'),
    configuration.replace('stable/ai-anthropic', 'stable/activation.json'),
    configuration.replace('branch: main', 'branch: other'),
    configuration.replace('wangyingang/sing-box-rule-artifacts', 'other/repository'),
  ]) assert.throws(() => parseBuildConfiguration(invalid));
});

test('一份固定来源构建三集，单选只构建目标集；同内容定义保持独立身份', { skip: !process.env.SING_BOX_TEST_BINARY }, async () => {
  const remote = upstream();
  const options = { configuration, release: { tag, fetch: remote.fetcher }, binary: process.env.SING_BOX_TEST_BINARY! };
  const built = await buildConfiguredRelease(options);
  assert.deepEqual(built.results.map(result => result.id), ['ai-openai', 'ai-anthropic', 'ai-google-deepmind']);
  assert.equal(remote.requests.filter(path => path.endsWith('/assets/11')).length, 1);
  assert.equal(remote.requests.filter(path => path.endsWith('/assets/12')).length, 1);
  for (const result of built.results) {
    assert.equal(result.status, 'built-validated');
    if (result.status !== 'built-validated') continue;
    assert.equal(result.report.inputCount, 1);
    assert.deepEqual(result.native.usages.route, result.native.usages['dns-query']);
    assert.deepEqual(result.native.usages['dns-response'], { status: 'unavailable', reason: 'empty' });
    assert.deepEqual(result.native.artifacts.map(artifact => artifact.file), ['domains.json', 'domains.srs']);
    assert.ok(result.native.artifacts.every(artifact => artifact.requiredCapabilities.length === 0));
  }
  const selected = await buildConfiguredRelease({ ...options, selectedIds: ['ai-anthropic'] });
  assert.deepEqual(selected.results.map(result => result.id), ['ai-anthropic']);
  const repeated = await buildConfiguredRelease(options);
  const ids = (results: typeof built.results) => results.map(result => result.status === 'built-validated' ? result.buildId : assert.fail(result.error));
  assert.deepEqual(ids(built.results), ids(repeated.results));
  const sameContent = configuration.replace('list: anthropic', 'list: openai');
  const duplicate = await buildConfiguredRelease({ ...options, configuration: sameContent });
  assert.notEqual(ids(duplicate.results)[0], ids(duplicate.results)[1]);
  const alternateTarget = await buildConfiguredRelease({ ...options,
    configuration: configuration.replace('branch: main', 'branch: acceptance-issue-36') });
  assert.equal(alternateTarget.configuration.target.branch, 'acceptance-issue-36');
  assert.notDeepEqual(ids(built.results), ids(alternateTarget.results));
});

test('共同摘要错误或 YAML 无法解析时整批失败', async () => {
  for (const remote of [upstream(yaml, '0'.repeat(64)), upstream('lists: [')]) {
    await assert.rejects(buildConfiguredRelease({ configuration, release: { tag, fetch: remote.fetcher }, binary: '/unused' }));
  }
});

test('单集缺失只使该集失败，兄弟集继续构建', { skip: !process.env.SING_BOX_TEST_BINARY }, async () => {
  const missing = JSON.stringify({ lists: [
    { name: 'openai', length: 1, rules: ['domain:openai.com'] },
    { name: 'google-deepmind', length: 1, rules: ['domain:deepmind.google'] },
  ] });
  const remote = upstream(missing);
  const built = await buildConfiguredRelease({ configuration, release: { tag, fetch: remote.fetcher },
    binary: process.env.SING_BOX_TEST_BINARY! });
  assert.deepEqual(built.results.map(result => result.status), ['built-validated', 'failed', 'built-validated']);
  assert.deepEqual(built.results[1].report.diagnostics.map(entry => entry.list), ['anthropic']);
});
