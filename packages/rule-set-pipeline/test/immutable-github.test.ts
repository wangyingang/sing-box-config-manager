import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheImmutableGitReads } from '../src/immutable-github.js';
import { candidateInputSnapshot } from '../src/rule-source-adapters.js';
import { sha256 } from '../src/release.js';
import { readCurrentRulesConfiguration } from '../src/rules-context.js';
import { githubRulesRepository } from '../src/rules-repository.js';
import type { ghJson } from '../src/publication.js';

test('只复用 SHA 固定内容；并发合并读取、失败可重读、调用方修改不污染缓存', async () => {
  let calls = 0, fail = true;
  const read = cacheImmutableGitReads(async () => {
    calls++; if (fail) throw new Error('HTTP 503'); return { content: { value: 1 } };
  });
  const args = ['api', `repos/owner/repo/git/blobs/${'a'.repeat(40)}`];
  await assert.rejects(read(args), /503/); fail = false;
  const [first, second] = await Promise.all([read(args), read(args)]);
  first.content.value = 99; assert.equal(second.content.value, 1); assert.equal(calls, 2);
  assert.equal((await read(args)).content.value, 1);
  for (const path of ['git/ref/heads/main', 'commits/main', 'releases/latest', '']) {
    const before: number = calls;
    await read(['api', `repos/owner/repo/${path}`]); await read(['api', `repos/owner/repo/${path}`]);
    assert.equal(calls - before, 2);
  }
  const before = calls;
  await read([...args, '--method', 'POST'], {}); await read(args, undefined, 'test-token');
  assert.equal(calls - before, 2);
});

test('每次确认配置均重读分支，只有同修订的配置正文复用', async () => {
  let revision = 'a'.repeat(40), heads = 0, contents = 0;
  const request = cacheImmutableGitReads(async args => {
    if (args[1].endsWith('/commits/main')) { heads++; return { sha: revision }; }
    contents++; assert.ok(args[1].endsWith(`?ref=${revision}`));
    return { encoding: 'base64', content: Buffer.from(revision).toString('base64') };
  });
  assert.equal((await readCurrentRulesConfiguration(request)).revision, revision);
  assert.equal((await readCurrentRulesConfiguration(request)).content, revision);
  assert.deepEqual({ heads, contents }, { heads: 2, contents: 1 });
  revision = 'b'.repeat(40);
  assert.equal((await readCurrentRulesConfiguration(request)).content, revision);
  assert.deepEqual({ heads, contents }, { heads: 3, contents: 2 });
});

function remote(target = 'main') {
  let head = 'a'.repeat(40), privateRepo = false;
  const calls: { path: string; input?: any }[] = [];
  const request: typeof ghJson = async (args, input) => {
    const path = args[1].replace('repos/wangyingang/sing-box-rule-artifacts', ''); calls.push({ path, input });
    if (path === '') return { private: privateRepo };
    if (path.startsWith('/git/ref/heads/')) return { object: { sha: head } };
    if (path.startsWith('/git/commits/')) return { tree: { sha: 'b'.repeat(40) }, parents: [] };
    if (path.startsWith('/git/trees/')) return { tree: [{ path: 'pipeline/state.json', type: 'blob', mode: '100644', sha: 'c'.repeat(40) }] };
    if (path.startsWith('/git/blobs/')) return { encoding: 'base64', content: 'e30=', size: 2 };
    if (path === '/git/blobs') return { sha: 'd'.repeat(40) };
    if (path === '/git/trees') return { sha: 'e'.repeat(40) };
    if (path === '/git/commits') return { sha: 'f'.repeat(40) };
    if (path.startsWith('/git/refs/heads/')) { head = (input as { sha: string }).sha; return {}; }
    throw new Error(`Unexpected ${path}`);
  };
  return { repository: githubRulesRepository(target, request), calls,
    move() { head = '9'.repeat(40); }, makePrivate() { privateRepo = true; } };
}

test('跨快照复用 Git 内容但保持 heads 与公开权限检查；每次写入前后执行 guard', async () => {
  const env = remote();
  const first = await env.repository.snapshot(); await first.read('pipeline/state.json');
  const second = await env.repository.snapshot(); await second.read('pipeline/state.json');
  assert.equal(env.calls.filter(call => call.path.startsWith('/git/blobs/')).length, 1);
  assert.equal(env.calls.filter(call => call.path.startsWith('/git/commits/')).length, 1);
  assert.equal(env.calls.filter(call => call.path.startsWith('/git/ref/heads/')).length, 2);
  let guards = 0;
  await env.repository.commit('candidates', first.head, { 'pipeline/state.json': Buffer.from('{}') }, 'test', async () => { guards++; });
  assert.equal(guards, 2);
  const patch = env.calls.find(call => call.path === '/git/refs/heads/candidates')!;
  assert.deepEqual(patch.input, { sha: 'f'.repeat(40), force: false });
  assert.deepEqual(env.calls.find(call => call.path === '/git/commits')!.input.parents, [first.head]);
  env.makePrivate(); await assert.rejects(env.repository.snapshot(), /public/);
});

test('GitHub 写入按分支保留自定义候选和稳定文件名', async () => {
  const candidate = 'candidates/12345678-1234-4123-8123-123456789abc';
  const stable = 'stable/test/networks';
  const filesFor = (root: string) => ({
    [`${root}/office-networks.srs`]: Buffer.from([0, 255, 1]),
    [`${root}/office-networks.json`]: Buffer.from('{}'),
    [`${root}/custom_domains.srs`]: Buffer.from([255, 0, 1]),
    [`${root}/custom_domains.json`]: Buffer.from('{}'),
  });
  for (const [branch, files] of [
    ['candidates', { ...filesFor(candidate), [`${candidate}/manifest.json`]: Buffer.from('{}') }],
    ['main', { ...filesFor(stable), [`${stable}/activation.json`]: Buffer.from('{}') }],
  ] as const) {
    const env = remote();
    const head = await env.repository.commit(branch, 'a'.repeat(40), files, 'custom filenames', async () => {});
    const tree = env.calls.find(call => call.path === '/git/trees')!.input.tree;
    assert.deepEqual(tree.map((entry: { path: string }) => entry.path), Object.keys(files));
    assert.deepEqual(env.calls.at(-1), { path: `/git/refs/heads/${branch}`, input: { sha: head, force: false } });
  }

  for (const [branch, path] of [
    ['candidates', `${stable}/office-networks.srs`],
    ['main', `${candidate}/custom_domains.json`],
    ['main', `${stable}/../../office-networks.srs`],
    ['main', `${stable}/office-networks.txt`],
    ['main', `${stable}/office.networks.json`],
    ['main', `${stable}/manifest.json`],
  ]) {
    const env = remote();
    await assert.rejects(env.repository.commit(branch, 'a'.repeat(40),
      { [path]: Buffer.from('{}') }, 'invalid file path', async () => {}), /Invalid rules write path/);
    assert.ok(env.calls.every(call => call.input === undefined));
  }
});

test('固定 URL 输入快照能与候选登记一起写入 GitHub 隔离目标', async () => {
  const target = 'acceptance-issue-168';
  const env = remote(target);
  const input = Buffer.from('{"version":4,"rules":[{"ip_cidr":["192.0.2.0/24"]}]}');
  const url = 'https://rules.example.test/mixed.json';
  const snapshot = candidateInputSnapshot({
    id: '12345678-1234-4123-8123-123456789abc',
    sourceInput: { version: 'url', input: { format: 'sing-box-source-json', url } },
    source: { kind: 'fixed-url', url, inputSha256: sha256(input), inputBytes: input.length },
  });
  assert.ok(snapshot);
  const paths = ['pipeline/state.json', snapshot.path];
  await env.repository.commit(target, 'a'.repeat(40), { [paths[0]]: Buffer.from('{}'), [paths[1]]: input },
    'register candidate and snapshot', async () => {});
  const tree = env.calls.find(call => call.path === '/git/trees')!.input.tree;
  assert.deepEqual(tree.map((entry: { path: string }) => entry.path), paths);
  assert.equal(env.calls.at(-1)!.path, `/git/refs/heads/${target}`);
});

for (const at of [1, 2]) test(`第 ${at} 次 guard 拒绝新意图或维护隔离时不移动 ref`, async () => {
  const env = remote(); let guards = 0;
  await assert.rejects(env.repository.commit('main', 'a'.repeat(40), { 'pipeline/state.json': Buffer.from('{}') }, 'test', async () => {
    if (++guards === at) throw new Error('RULE_INTENT_SUPERSEDED');
  }), /SUPERSEDED/);
  assert.ok(!env.calls.some(call => call.path.startsWith('/git/refs/heads/')));
  if (at === 1) assert.ok(!env.calls.some(call => call.input));
});

test('对象上传后目标 head 变化时禁止 PATCH，即使候选 journal 没有变化', async () => {
  const env = remote(); let guards = 0;
  await assert.rejects(env.repository.commit('main', 'a'.repeat(40), { 'pipeline/state.json': Buffer.from('{}') }, 'test', async () => {
    if (++guards === 2) env.move();
  }), /remote head changed/);
  assert.ok(!env.calls.some(call => call.path.startsWith('/git/refs/heads/')));
});
