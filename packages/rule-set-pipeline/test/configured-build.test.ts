import { readOfficialConfiguration } from '../src/configuration.js';
import { releaseConfiguration } from './fixtures/release-configuration.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../src/release.js';
import { buildConfiguredCommit, buildConfiguredRelease, parseBuildConfiguration } from '../src/configured-build.js';

const tag = '20261104112839';
const configuration = releaseConfiguration();
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

test('配置在写入前拒绝旧格式、无效来源、用途、身份和目标', () => {
  const configuration = readOfficialConfiguration();
  assert.throws(() => parseBuildConfiguration('schemaVersion: 1\nsource: v2fly/domain-list-community\ntarget: {}\nruleSets: []'));
  for (const invalid of [
    configuration.replace('format: plain-yaml', 'format: unknown'),
    configuration.replace('source: dlc', 'source: missing'),
    configuration.replace('usages:', 'projections:'),
    configuration.replace('dns-query: { artifact: domains }', 'dns-query: { unavailable: empty }'),
    configuration.replace('id: anthropic', 'id: openai'),
    configuration.replace('stable/anthropic', 'stable/openai'),
    configuration.replace('stable/anthropic', 'stable/../outside'),
    configuration.replace('branch: main', 'branch: other'),
    configuration.replace('wangyingang/sing-box-rule-artifacts', 'other/repository'),
  ]) assert.throws(() => parseBuildConfiguration(invalid));
});

test('一份固定来源构建三集，单选只构建目标集；同内容定义保持独立身份', { skip: !process.env.SING_BOX_TEST_BINARY }, async () => {
  const remote = upstream();
  const options = { configuration, release: { tag, fetch: remote.fetcher }, binary: process.env.SING_BOX_TEST_BINARY! };
  const built = await buildConfiguredRelease(options);
  assert.deepEqual(built.results.map(result => result.id), ['openai', 'anthropic', 'google-deepmind']);
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
  const aliases = parseBuildConfiguration(configuration);
  aliases.sources['dlc-alias'] = aliases.sources.dlc;
  aliases.ruleSets[1].source = 'dlc-alias';
  const shared = upstream();
  const withAlias = await buildConfiguredRelease({ ...options, configuration: JSON.stringify(aliases), release: { tag, fetch: shared.fetcher } });
  assert.ok(withAlias.results.every(result => result.status === 'built-validated'));
  assert.equal(shared.requests.filter(path => path.endsWith('/assets/11')).length, 1);
  const selected = await buildConfiguredRelease({ ...options, selectedIds: ['anthropic'] });
  assert.deepEqual(selected.results.map(result => result.id), ['anthropic']);
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

test('新增列表缺失或非法时报告列表位置，共用来源的兄弟集继续构建', { skip: !process.env.SING_BOX_TEST_BINARY }, async () => {
  const remote = upstream(JSON.stringify({ lists: [
    { name: 'geolocation-cn', length: 1, rules: ['domain:domestic.example'] },
    { name: 'google', length: 1, rules: ['full:bad..example'] },
    { name: 'youtube', length: 1, rules: ['domain:youtube.example'] },
  ] }));
  const built = await buildConfiguredRelease({ configuration: readOfficialConfiguration(),
    selectedIds: ['china-domains', 'global', 'google', 'youtube'], release: { tag, fetch: remote.fetcher },
    binary: process.env.SING_BOX_TEST_BINARY! });
  assert.deepEqual(built.results.map(({ id, status }) => [id, status]), [
    ['china-domains', 'built-validated'], ['global', 'failed'], ['google', 'failed'], ['youtube', 'built-validated'],
  ]);
  assert.deepEqual(built.results.slice(1, 3).flatMap(result => result.report.diagnostics.map(({ code, file, list, index }) =>
    [code, file, list, index])), [
    ['TARGET_LIST_COUNT', 'dlc.dat_plain.yml', 'geolocation-!cn', undefined],
    ['INVALID_RULE', 'dlc.dat_plain.yml', 'google', 0],
  ]);
});

test('gfw 用途错误在获取输入前定位到规则集和文件', async () => {
  const config = parseBuildConfiguration(readOfficialConfiguration());
  const gfw = config.ruleSets.find(rule => rule.id === 'gfw')!;
  gfw.usages['dns-query'] = { unavailable: 'empty' };
  await assert.rejects(buildConfiguredCommit({
    configuration: JSON.stringify(config), selectedIds: ['gfw'], binary: '/unused',
    github: { fetch: async () => assert.fail('Invalid usages must fail before source access') },
  }), /gfw.*gfw\.txt.*dns-query/);
});

test('gfw 缺失、非法或空输入的诊断包含固定文件', async () => {
  const commit = 'a'.repeat(40);
  const build = (input: Response) => buildConfiguredCommit({
    configuration: readOfficialConfiguration(), selectedIds: ['gfw'], binary: '/unused',
    github: { commit, fetch: async url => String(url).includes('/branches/')
      ? Response.json({ name: 'release', commit: { sha: commit } }) : input },
  });
  await assert.rejects(build(new Response(null, { status: 404 })), {
    code: 'DOWNLOAD_FAILED', message: /gfw.*\/gfw\.txt/,
  });
  const tooLong = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(62)].join('.');
  const invalid = await build(new Response(
    `example.test\n*.example.test\nhttps://example.test\n192.0.2.1\nexample.test:@tag\n${tooLong}\n`));
  assert.deepEqual(invalid.results.map(({ id, status, report }) => [id, status, report.diagnostics.map(d => [d.code, d.file, d.line])]), [
    ['gfw', 'failed', [2, 3, 4, 5, 6].map(line => ['INVALID_RULE', 'gfw.txt', line])],
  ]);
  const empty = await build(new Response('\n \t\r\n'));
  assert.deepEqual(empty.results.map(({ id, status, report }) => [id, status, report.diagnostics.map(d => [d.code, d.file])]), [
    ['gfw', 'failed', [['EMPTY_INPUT', 'gfw.txt']]],
  ]);
});
