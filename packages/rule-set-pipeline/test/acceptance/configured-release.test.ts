import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildConfiguredRelease } from '../../src/configured-build.js';

const exec = promisify(execFile);

// JSON from the original three definitions at e144fff, using this fixed Release.
const domainIds = ['openai', 'anthropic', 'google-deepmind'];
const baselineJsonSha256 = [
  'a70096077d78af43df6f56dbad775c27e8b0be7c92a81e36baaf8229b04de5d5',
  'c1020bf1d91791e2a886d618b5f0625972fa6077e52621f25b1a29b31ae683b7',
  '1f417b044c3cff900faa62bd5df7f92cb0bfca8c288c9f64689ccd17ffd83322',
];

test('固定官方 Release 一次读取三集，分别原生验证且重复构建字节一致', { timeout: 180_000 }, async () => {
  const configuration = await readFile(new URL('../../config/rulesets.yml', import.meta.url), 'utf8');
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(String(input));
    return fetch(input, init);
  };
  const options = { configuration, selectedIds: domainIds,
    release: { tag: '20261104112839', fetch: fetcher, token: process.env.GITHUB_TOKEN },
    binary: process.env.SING_BOX_TEST_BINARY ?? '' };
  const first = await buildConfiguredRelease(options);
  assert.equal(requests.filter(url => url.endsWith('/assets/' + first.source.yaml.id)).length, 1);
  assert.equal(requests.filter(url => url.endsWith('/assets/' + first.source.checksum.id)).length, 1);
  assert.deepEqual(first.results.map(result => result.id), domainIds);
  for (const [index, result] of first.results.entries()) {
    assert.equal(result.status, 'built-validated', JSON.stringify(result.report));
    if (result.status !== 'built-validated') continue;
    assert.equal(result.report.inputCount, [25, 19, 49][index]);
    assert.equal(result.native.tool.version, '1.14.4');
    assert.equal(result.native.validation.status, 'passed');
    assert.deepEqual(result.native.usages.route, result.native.usages['dns-query']);
    assert.deepEqual(result.native.usages['dns-response'], { status: 'unavailable', reason: 'empty' });
    assert.deepEqual(result.native.artifacts.map(artifact => artifact.file), ['domains.json', 'domains.srs']);
    assert.equal(result.native.artifacts.find(artifact => artifact.format === 'source')?.sha256, baselineJsonSha256[index]);
    assert.ok(result.native.artifacts.every(artifact => artifact.requiredCapabilities.length === 0));
  }
  const second = await buildConfiguredRelease(options);
  for (let index = 0; index < 3; index++) {
    const a = first.results[index], b = second.results[index];
    assert.equal(a.status, 'built-validated'); assert.equal(b.status, 'built-validated');
    if (a.status !== 'built-validated' || b.status !== 'built-validated') continue;
    assert.equal(a.buildId, b.buildId);
    for (let file = 0; file < 2; file++) assert.deepEqual(a.native.artifacts[file].content, b.native.artifacts[file].content);
  }
  const selected = await buildConfiguredRelease({ ...options, selectedIds: ['anthropic'] });
  assert.deepEqual(selected.results.map(result => result.id), ['anthropic']);
  console.log(JSON.stringify({ source: first.source, results: first.results.map(result => {
    assert.equal(result.status, 'built-validated');
    return { id: result.id, inputCount: result.report.inputCount, buildId: result.buildId, tool: result.native.tool,
      usages: result.native.usages, artifacts: result.native.artifacts.map(({ file, sha256, bytes }) => ({ file, sha256, bytes })) };
  }) }));
});

const addedLists = {
  'china-domains': 'geolocation-cn', global: 'geolocation-!cn', apple: 'apple', microsoft: 'microsoft',
  docker: 'docker', github: 'github', google: 'google', youtube: 'youtube',
};
const attributedRegex = {
  'china-domains': String.raw`^.+-mihayo\.akamaized\.net$`,
  global: String.raw`.+\.awsdns-cn-[0-9][0-9]\.(biz|com|net|top)$`,
  google: String.raw`^r+[0-9]+(---|\.)sn-(2x3|ni5|j5o)\w{5}\.googlevideo\.com$`,
};
const matchProbes: Record<string, [domain: string, expected: boolean, predicate?: 'domain_regex'][]> = {
  'china-domains': [
    ['x-mihayo.akamaized.net', true, 'domain_regex'], ['x-mihay0.akamaized.net', false, 'domain_regex'],
  ],
  global: [['x.awsdns-cn-12.biz', true, 'domain_regex'], ['x.awsdns-cn-aa.biz', false, 'domain_regex']],
  github: [
    ['github-api.arkoselabs.com', true], ['sub.github-api.arkoselabs.com', false],
    ['github.com', true], ['sub.github.com', true], ['badgithub.com', false],
  ],
  // Both domains match the googlevideo.com suffix. Assert the regex rule separately.
  google: [
    ['r1---sn-2x3abcde.googlevideo.com', true, 'domain_regex'],
    ['r1---sn-z23abcde.googlevideo.com', false, 'domain_regex'],
  ],
};

test('固定官方 Release 共用一份校验输入构建八个新增域名集，JSON/SRS 保留匹配类型', { timeout: 180_000 }, async t => {
  const configuration = await readFile(new URL('../../config/rulesets.yml', import.meta.url), 'utf8');
  const binary = process.env.SING_BOX_TEST_BINARY ?? '';
  const requests: string[] = [];
  const result = await buildConfiguredRelease({ configuration, binary, selectedIds: Object.keys(addedLists),
    release: { tag: '20261118141523', token: process.env.GITHUB_TOKEN, fetch: (input, init) => {
      requests.push(String(input));
      return fetch(input, init);
    } } });
  const { source } = result;
  assert.equal(source.repository, 'v2fly/domain-list-community');
  assert.equal(source.tag, '20261118141523');
  assert.equal(source.releaseId, 450083966);
  assert.equal(source.commit, 'bc3a8f5e24792303cf82bfff33b1ff164a0e4b3c');
  assert.equal(source.inputSha256, '20352b9263f6e3db420465efb565a7a0345ddde535afedf92515a7bb0ffa4dd8');
  for (const [asset, name, id] of [[source.yaml, 'dlc.dat_plain.yml', 763666587],
    [source.checksum, 'dlc.dat_plain.yml.sha256sum', 763666591]] as const) {
    assert.equal(asset.name, name);
    assert.equal(asset.id, id);
    assert.equal(requests.filter(url => url.endsWith(`/assets/${id}`)).length, 1);
  }
  assert.deepEqual(result.results.map(({ id, definition }) => [id, definition.list]), Object.entries(addedLists));
  const directory = await mkdtemp(join(tmpdir(), 'v2fly-release-match-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const builds = [];
  for (const rule of result.results) {
    const { id, definition, report } = rule;
    assert.equal(definition.source, 'dlc');
    assert.equal(definition.stablePath, `stable/${id}`);
    if (rule.status !== 'built-validated') assert.fail(`${id}: ${JSON.stringify(report)}`);
    const { native, buildId } = rule;
    assert.equal(native.tool.version, '1.14.4');
    assert.equal(native.validation.status, 'passed');
    assert.ok(report.outputTermCount > 0, id);
    assert.deepEqual(native.usages.route, { artifactFiles: ['domains.json', 'domains.srs'] });
    assert.deepEqual(native.usages['dns-query'], native.usages.route);
    assert.deepEqual(native.usages['dns-response'], { status: 'unavailable', reason: 'empty' });
    assert.deepEqual(native.artifacts.map(artifact => artifact.file), ['domains.json', 'domains.srs']);
    const parsed = JSON.parse(native.artifacts[0].content.toString());
    assert.equal(parsed.version, 4);
    const expression = attributedRegex[id as keyof typeof attributedRegex];
    if (expression) {
      assert.ok(parsed.rules.some((item: { domain_regex?: string[] }) => item.domain_regex?.includes(expression)), id);
    }
    for (const artifact of native.artifacts) {
      assert.ok(artifact.bytes > 0 && artifact.content.length > 0, `${id}/${artifact.file}`);
      const file = join(directory, `${id}-${artifact.file}`);
      const probes = matchProbes[id] ?? [];
      if (probes.length) await writeFile(file, artifact.content);
      for (const [domain, expected, predicate] of probes) {
        const { stdout, stderr } = await exec(binary, ['rule-set', 'match', file, domain, '--format', artifact.format]);
        const output = stdout + stderr;
        const matched = output.split('\n').some(line => line.startsWith('match rules.') && (!predicate || line.includes(`: ${predicate}=`)));
        assert.equal(matched, expected, `${id}/${artifact.file}/${domain}: ${output}`);
      }
    }
    builds.push({ id, list: definition.list, buildId, terms: report.outputTermCount, validation: native.validation.status,
      artifacts: native.artifacts.map(({ file, sha256, bytes }) => ({ file, sha256, bytes })) });
  }
  console.log(JSON.stringify({ source, tool: 'sing-box 1.14.4', sourceFormat: 4, publication: 'not-published', builds }));
});
