import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildRelease, convertRules, readTargetList } from '../src/index.js';

const repository = 'v2fly/domain-list-community';
const tag = '20261102130044';
const commit = 'a'.repeat(40);
const yaml = `lists:
  - name: category-ai-!cn
    length: 3
    rules:
      - 'domain:example.com:@!cn'
      - 'full:api.example.com:@ads,@telemetry'
      - 'regexp:^API\\.example\\.com$'
`;

function upstream(input = yaml, checksum = createHash('sha256').update(input).digest('hex')) {
  const requests: string[] = [];
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const assets = ['dlc.dat_plain.yml', 'dlc.dat_plain.yml.sha256sum'].map((name, index) => ({
    id: index + 11, name, browser_download_url: base + name,
  }));
  const release = { id: 42, tag_name: tag, assets };
  const yamlUrl = `https://api.github.com/repos/${repository}/releases/assets/11`;
  const checksumUrl = `https://api.github.com/repos/${repository}/releases/assets/12`;
  const responses: Record<string, unknown> = {
    [`https://api.github.com/repos/${repository}/releases/tags/${tag}`]: release,
    [`https://api.github.com/repos/${repository}/git/ref/tags/${tag}`]: { object: { type: 'tag', sha: 'b'.repeat(40) } },
    [`https://api.github.com/repos/${repository}/git/tags/${'b'.repeat(40)}`]: { object: { type: 'commit', sha: commit } },
    [base + 'dlc.dat_plain.yml']: input,
    [base + 'dlc.dat_plain.yml.sha256sum']: `${checksum}  dlc.dat_plain.yml\n`,
    [yamlUrl]: input,
    [checksumUrl]: `${checksum}  dlc.dat_plain.yml\n`,
  };
  const fetcher: typeof fetch = async (url) => {
    const key = String(url);
    requests.push(key);
    assert.ok(key in responses, `Unexpected request: ${key}`);
    const value = responses[key];
    return new Response(typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { fetcher, requests, responses, base, yamlUrl, checksumUrl };
}

test('固定 Release 构建保留来源、属性匹配值和独立 OR 谓词，不声明原生验证成功', async () => {
  const remote = upstream();
  const result = await buildRelease({ tag, fetch: remote.fetcher });
  assert.equal(result.ok, true, JSON.stringify(result.report));
  if (!result.ok) return;
  assert.equal(result.status, 'built-unvalidated');
  assert.equal(result.source.repository, repository);
  assert.equal(result.source.releaseId, 42);
  assert.equal(result.source.commit, commit);
  assert.equal(result.source.yaml.id, 11);
  assert.equal(result.source.checksum.id, 12);
  assert.equal(result.source.inputSha256, createHash('sha256').update(yaml).digest('hex'));
  assert.deepEqual(JSON.parse(result.json), { version: 4, rules: [
    { domain_suffix: ['example.com'] },
    { domain: ['api.example.com'] },
    { domain_regex: ['^API\\.example\\.com$'] },
  ] });
  assert.equal(result.report.inputCount, 3);
  assert.equal(result.report.convertedCount, 3);
  assert.equal(result.report.outputTermCount, 3);
  assert.equal(result.report.attributeRecordCount, 2);
  assert.deepEqual(result.report.usageCounts, { route: 3, 'dns-query': 3, 'dns-response': 0 });
  assert.deepEqual(result.usages['dns-response'], { status: 'unavailable', reason: 'empty' });
  assert.deepEqual(result.usages.route, result.usages['dns-query']);
  assert.ok(remote.requests.every((url) => !url.includes('/latest')));
  assert.ok(remote.requests.includes(remote.yamlUrl));
  assert.ok(remote.requests.includes(remote.checksumUrl));
});

function list(rules: unknown[]) {
  // JSON is a YAML subset; this preserves exactly the intended scalar bytes.
  return JSON.stringify({ lists: [{ name: 'category-ai-!cn', length: rules.length, rules }] });
}

test('四种谓词相等去重、固定排序，属性不会触发本地筛选，值只解码一次', async () => {
  const rules = [
    'keyword:Example:@cn', 'full:example.com', 'domain:example.com',
    'domain:example.com:@!cn', 'regexp:^API\\.Example\\d+\\.com$',
    'domain:例子.测试.', 'domain:Example.COM.', 'keyword:Example', 'keyword:example',
  ];
  const first = await buildRelease({ tag, fetch: upstream(list(rules)).fetcher });
  const reversed = await buildRelease({ tag, fetch: upstream(list([...rules].reverse())).fetcher });
  assert.ok(first.ok && reversed.ok);
  assert.equal(first.json, reversed.json);
  assert.equal(first.artifact.sha256, reversed.artifact.sha256);
  assert.deepEqual(JSON.parse(first.json), { version: 4, rules: [
    { domain_suffix: ['Example.COM.', 'example.com', '例子.测试.'] },
    { domain: ['example.com'] },
    { domain_keyword: ['Example', 'example'] },
    { domain_regex: ['^API\\.Example\\d+\\.com$'] },
  ] });
  assert.equal(first.report.inputCount, 9);
  assert.equal(first.report.convertedCount, 9);
  assert.equal(first.report.duplicateCount, 2);
  assert.equal(first.report.outputTermCount, 7);
});

for (const [name, input, code] of [
  ['坏 YAML', 'lists: [', 'INVALID_YAML'],
  ['非目标区域坏 YAML', yaml + '\nother: [', 'INVALID_YAML'],
  ['多个 YAML 文档', yaml + '\n---\na: b', 'INVALID_YAML'],
  ['重复 mapping key', yaml + '\nlists: []', 'INVALID_YAML'],
  ['未知 YAML tag', 'lists: !evil []', 'INVALID_YAML'],
  ['缺失目标', 'lists: []', 'TARGET_LIST_COUNT'],
  ['重复目标', JSON.stringify({ lists: [
    { name: 'category-ai-!cn', length: 1, rules: ['domain:a.com'] },
    { name: 'category-ai-!cn', length: 1, rules: ['domain:b.com'] },
  ] }), 'TARGET_LIST_COUNT'],
  ['空列表', list([]), 'EMPTY_LIST'],
  ['错误长度', yaml.replace('length: 3', 'length: 214'), 'LENGTH_MISMATCH'],
  ['非数值长度', yaml.replace('length: 3', 'length: "3"'), 'LENGTH_MISMATCH'],
  ['未知类型', list(['include:other']), 'UNSUPPORTED_TYPE'],
  ['原型属性名不当作类型', list(['__proto__:example']), 'UNSUPPORTED_TYPE'],
  ['空值', list(['domain:']), 'INVALID_RULE'],
  ['非法域名', list(['domain:https://example.com']), 'INVALID_RULE'],
  ['空 label', list(['domain:a..com']), 'INVALID_RULE'],
  ['非法 label 边界', list(['domain:-a.com']), 'INVALID_RULE'],
  ['超长 label', list([`full:${'a'.repeat(64)}.com`]), 'INVALID_RULE'],
  ['空白', list(['keyword:two words']), 'INVALID_RULE'],
  ['非法 keyword', list(['keyword:https://example.com']), 'INVALID_RULE'],
  ['非字符串', list([42]), 'INVALID_RULE'],
  ['mapping 规则', list([{ domain: 'example.com' }]), 'INVALID_RULE'],
  ['控制字符', list(['full:a\u0000.com']), 'INVALID_RULE'],
  ['空属性', list(['full:a.com:@']), 'INVALID_RULE'],
  ['属性尾部垃圾', list(['full:a.com:@cn:other']), 'INVALID_RULE'],
  ['正则属性', list(['regexp:^a.com$:@cn']), 'INVALID_RULE'],
  ['正则字面歧义', list(['regexp:^a:@b$']), 'INVALID_RULE'],
] as const) {
  test(`${name} 明确失败且没有部分产物`, async () => {
    const result = await buildRelease({ tag, fetch: upstream(input).fetcher });
    assert.equal(result.ok, false);
    assert.equal(result.report.status, 'failed');
    assert.ok(result.report.diagnostics.some((item) => item.code === code), JSON.stringify(result.report));
    assert.ok(!('json' in result));
    assert.ok(!('artifact' in result));
  });
}

test('失败报告保留计数和来源位置，下游转换不依赖 YAML', () => {
  const input = Buffer.from(list(['domain:a.com', 'domain:a.com:@cn', 'include:other', 'full:']));
  const parsed = readTargetList(input);
  assert.ok(parsed.ok);
  const converted = convertRules(parsed.rules);
  assert.equal(converted.ok, false);
  assert.equal(converted.report.inputCount, 4);
  assert.equal(converted.report.convertedCount, 2);
  assert.equal(converted.report.unsupportedCount, 1);
  assert.equal(converted.report.invalidCount, 1);
  assert.equal(converted.report.duplicateCount, 1);
  assert.equal(converted.report.outputTermCount, 1);
  assert.deepEqual(converted.report.diagnostics.map((item) => item.index), [2, 3]);
  assert.ok(converted.report.diagnostics.every((item) => item.line === 1 && item.column! > 0 && item.list === 'category-ai-!cn'));
  assert.ok(!('terms' in converted));
});

for (const [name, change, code] of [
  ['摘要不符', (remote) => { remote.responses[remote.checksumUrl] = `${'0'.repeat(64)}  dlc.dat_plain.yml\n`; }, 'CHECKSUM_MISMATCH'],
  ['摘要文件名错配', (remote) => { remote.responses[remote.checksumUrl] = `${'0'.repeat(64)}  other.yml\n`; }, 'INVALID_CHECKSUM'],
  ['多条摘要', (remote) => { remote.responses[remote.checksumUrl] += '\nextra'; }, 'INVALID_CHECKSUM'],
  ['Release tag 错配', (remote) => { (remote.responses[`https://api.github.com/repos/${repository}/releases/tags/${tag}`] as Record<string, unknown>).tag_name = 'other'; }, 'RELEASE_MISMATCH'],
  ['缺失摘要资产', (remote) => { (remote.responses[`https://api.github.com/repos/${repository}/releases/tags/${tag}`] as Record<string, unknown>).assets = []; }, 'MISSING_ASSET'],
  ['跨 Release 资产', (remote) => {
    const release = remote.responses[`https://api.github.com/repos/${repository}/releases/tags/${tag}`] as { assets: Record<string, unknown>[] };
    release.assets[0].browser_download_url = remote.base.replace(tag, 'other') + 'dlc.dat_plain.yml';
  }, 'ASSET_MISMATCH'],
  ['tag 指向 tree', (remote) => { remote.responses[`https://api.github.com/repos/${repository}/git/ref/tags/${tag}`] = { object: { type: 'tree', sha: commit } }; }, 'INVALID_TAG_REF'],
  ['tag 解引用循环', (remote) => { remote.responses[`https://api.github.com/repos/${repository}/git/tags/${'b'.repeat(40)}`] = { object: { type: 'tag', sha: 'b'.repeat(40) } }; }, 'INVALID_TAG_REF'],
] satisfies [string, (remote: ReturnType<typeof upstream>) => void, string][]) {
  test(`${name} 拒绝构建`, async () => {
    const remote = upstream();
    change(remote);
    const result = await buildRelease({ tag, fetch: remote.fetcher });
    assert.equal(result.ok, false);
    assert.equal(result.report.diagnostics[0].code, code);
    assert.ok(!('json' in result));
  });
}

test('轻量 tag 直接固定 commit，拒绝已固定资产身份或内容的改变', async () => {
  const remote = upstream();
  remote.responses[`https://api.github.com/repos/${repository}/git/ref/tags/${tag}`] = { object: { type: 'commit', sha: commit } };
  const first = await buildRelease({ tag, fetch: remote.fetcher });
  assert.ok(first.ok);
  const repeat = await buildRelease({ tag, fetch: remote.fetcher, expectedSource: first.source });
  assert.ok(repeat.ok);
  assert.equal(repeat.json, first.json);
  const changedIdentity = await buildRelease({ tag, fetch: remote.fetcher, expectedSource: { ...first.source, yaml: { ...first.source.yaml, id: 99 } } });
  assert.equal(changedIdentity.report.diagnostics[0].code, 'SOURCE_CHANGED');
  const changedContent = await buildRelease({ tag, fetch: upstream(list(['domain:other.com'])).fetcher, expectedSource: first.source });
  assert.equal(changedContent.report.diagnostics[0].code, 'SOURCE_CHANGED');
});

test('网络或 HTTP 失败不会输出成功产物，latest 不作为固定 tag 接受', async () => {
  for (const fetcher of [
    async () => new Response('missing', { status: 404 }),
    async () => { throw new Error('offline'); },
  ]) {
    const result = await buildRelease({ tag, fetch: fetcher });
    assert.equal(result.ok, false);
    assert.ok(!('artifact' in result));
  }
  const result = await buildRelease({ tag: 'latest', fetch: async () => { throw new Error('must not request'); } });
  assert.equal(result.report.diagnostics[0].code, 'INVALID_TAG');
});

test('YAML alias 和无效 UTF-8 拒绝读取', () => {
  assert.equal(readTargetList(Buffer.from('lists: &loop [*loop]')).ok, false);
  const result = readTargetList(Uint8Array.from([0xff]));
  assert.ok(!result.ok);
  assert.equal(result.diagnostics[0].code, 'INVALID_UTF8');
});
