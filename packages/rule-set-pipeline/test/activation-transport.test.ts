import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivationWriteError, githubActivation } from '../src/activation-transport.js';
import { ARTIFACT_REPOSITORY, type ghJson } from '../src/publication.js';

const oldHead = 'a'.repeat(40), newCommit = 'e'.repeat(40);
function github(options: { branch?: string; head?: string; private?: boolean; missing?: boolean; patchError?: Error } = {}) {
  const branch = options.branch ?? 'main';
  const calls: { args: string[]; input: any }[] = [];
  const root = `repos/${ARTIFACT_REPOSITORY}`;
  const request: typeof ghJson = async (args, input) => {
    calls.push({ args, input });
    const path = args[1];
    if (path === root) return { private: options.private ?? false };
    if (path === `${root}/git/ref/heads/${branch}`) {
      if (options.missing) throw new Error('HTTP 404: branch missing');
      return { object: { sha: options.head ?? oldHead } };
    }
    if (path === `${root}/git/commits/${oldHead}`) return { tree: { sha: 'b'.repeat(40) } };
    if (path === `${root}/git/blobs`) return { sha: 'c'.repeat(40) };
    if (path === `${root}/git/trees`) return { sha: 'd'.repeat(40) };
    if (path === `${root}/git/commits`) return { sha: newCommit };
    if (path === `${root}/git/refs/heads/${branch}` && args.includes('PATCH')) {
      if (options.patchError) throw options.patchError;
      return { object: { sha: newCommit } };
    }
    throw new Error(`Unexpected API ${path}`);
  };
  return { transport: githubActivation(branch, request), calls };
}

for (const branch of ['main', 'acceptance-issue-19']) {
  test(`${branch} 使用既有分支的预期旧 head，一次提交稳定文件及记录且非强制更新`, async () => {
    const remote = github({ branch });
    const files = { 'stable/domains.srs': Buffer.from([0, 255, 1]), 'stable/activation.json': Buffer.from('{"candidate":"B"}\n') };
    assert.equal(await remote.transport.head(), oldHead);
    assert.equal(await remote.transport.commit(oldHead, files, '激活候选 B'), newCommit);
    const blobs = remote.calls.filter(c => c.args[1].endsWith('/git/blobs'));
    assert.deepEqual(blobs.map(c => Buffer.from(c.input.content, 'base64')), Object.values(files));
    assert.ok(blobs.every(c => c.input.encoding === 'base64'));
    const tree = remote.calls.find(c => c.args[1].endsWith('/git/trees'))!;
    assert.equal(tree.input.base_tree, 'b'.repeat(40));
    assert.deepEqual(tree.input.tree.map((entry: any) => entry.path), Object.keys(files));
    const commit = remote.calls.filter(c => c.args[1].endsWith('/git/commits'));
    assert.equal(commit.length, 1);
    assert.deepEqual(commit[0].input, { message: '激活候选 B', tree: 'd'.repeat(40), parents: [oldHead] });
    const patches = remote.calls.filter(c => c.args.includes('PATCH'));
    assert.equal(patches.length, 1);
    assert.equal(patches[0].args[1], `repos/${ARTIFACT_REPOSITORY}/git/refs/heads/${branch}`);
    assert.deepEqual(patches[0].input, { sha: newCommit, force: false });
    assert.ok(!remote.calls.some(c => c.args[1].endsWith('/git/refs')), 'Activation must not create missing branches');
  });
}

for (const path of ['candidates/abc/domains.srs', 'README.md', '/stable/domains.srs', 'stable/../candidate.srs',
  'stable/./domains.srs', 'stable//domains.srs', 'stable/domains.srs?x=1', 'stable/']) {
  test(`非法稳定路径 ${path} 不更新远端引用`, async () => {
    const remote = github();
    await assert.rejects(remote.transport.commit(oldHead, { [path]: Buffer.from('rules') }, '激活候选'), /Invalid stable path/);
    assert.ok(!remote.calls.some(c => c.args.includes('PATCH')));
    assert.ok(!remote.calls.some(c => c.args[1].endsWith('/git/commits') && c.input));
  });
}

test('预期旧 head 已被其他激活改变时直接冲突，不创建提交或 PATCH', async () => {
  const remote = github({ head: 'f'.repeat(40) });
  await assert.rejects(remote.transport.commit(oldHead, { 'stable/domains.srs': Buffer.from('rules') }, '激活候选'), /ACTIVATION_CONFLICT/);
  assert.ok(remote.calls.every(c => c.input === undefined));
  assert.ok(!remote.calls.some(c => c.args.includes('PATCH')));
});

test('PATCH 回复失败携带准确 attemptedCommit，保留 cause 且不重试覆盖', async () => {
  const failure = new Error('lost response');
  const remote = github({ patchError: failure });
  await assert.rejects(remote.transport.commit(oldHead, { 'stable/domains.srs': Buffer.from('rules') }, '激活候选'), error => {
    assert.ok(error instanceof ActivationWriteError);
    assert.equal(error.attemptedCommit, newCommit);
    assert.equal(error.cause, failure);
    return true;
  });
  const patches = remote.calls.filter(c => c.args.includes('PATCH'));
  assert.equal(patches.length, 1);
  assert.equal(patches[0].input.force, false);
});

for (const options of [{ missing: true }, { private: true }, { head: 'short-sha' }]) {
  test(`分支缺失、仓库私有或 head 非法时拒绝激活 ${JSON.stringify(options)}`, async () => {
    const remote = github(options);
    await assert.rejects(remote.transport.commit(oldHead, { 'stable/domains.srs': Buffer.from('rules') }, '激活候选'));
    assert.ok(remote.calls.every(c => c.input === undefined));
  });
}

test('非法 expectedHead 在访问远端前拒绝；候选分支和路径型分支不能作为激活分支', async () => {
  const remote = github();
  await assert.rejects(remote.transport.commit('short', { 'stable/domains.srs': Buffer.from('rules') }, '激活候选'), /Expected full old commit/);
  assert.equal(remote.calls.length, 0);
  for (const branch of ['candidates', 'acceptance/issue-19', '../main', 'main?x=1']) assert.throws(() => githubActivation(branch), /Invalid activation branch/);
});
