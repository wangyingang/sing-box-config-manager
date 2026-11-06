import assert from 'node:assert/strict';
import test from 'node:test';
import { ARTIFACT_REPOSITORY, type ghJson } from '../src/publication.js';
import { githubPublicationRepository, PublicationWriteError } from '../src/publication-repository.js';

const oldHead = 'a'.repeat(40), newHead = 'e'.repeat(40), treeSha = 'b'.repeat(40), blobSha = 'c'.repeat(40);
function github(options: { private?: boolean; truncated?: boolean; changedHead?: boolean; lostReply?: boolean;
  existing?: string; blobError?: boolean; malformedBlob?: boolean; invalidEntry?: boolean; missingBranch?: boolean;
  invalidHead?: boolean; invalidTreeSha?: boolean } = {}) {
  const calls: { args: string[]; input: any }[] = [];
  const content = Buffer.from('{"generation":1}\n');
  const request: typeof ghJson = async (args, input) => {
    calls.push({ args, input });
    const path = args[1], root = `repos/${ARTIFACT_REPOSITORY}`;
    if (path === root) return { private: !!options.private };
    if (path === `${root}/git/ref/heads/candidates` || path === `${root}/git/ref/heads/main`) {
      if (options.missingBranch) throw new Error('HTTP 404 branch missing');
      return { object: { sha: options.invalidHead ? 'latest' : options.changedHead ? 'f'.repeat(40) : oldHead } };
    }
    if (path === `${root}/git/commits/${oldHead}` || path === `${root}/git/commits/${'f'.repeat(40)}`) return { tree: { sha: options.invalidTreeSha ? 'invalid' : treeSha } };
    if (path === `${root}/git/trees/${treeSha}?recursive=1`) return { truncated: !!options.truncated,
      tree: options.existing ? [{ path: options.existing, type: 'blob', mode: options.invalidEntry ? '120000' : '100644', sha: blobSha }] : [] };
    if (path === `${root}/git/blobs/${blobSha}`) {
      if (options.blobError) throw new Error('HTTP 503 temporary');
      return { encoding: 'base64', content: content.toString('base64'), size: options.malformedBlob ? 999 : content.length };
    }
    if (path === `${root}/git/blobs`) return { sha: blobSha };
    if (path === `${root}/git/trees`) return { sha: 'd'.repeat(40) };
    if (path === `${root}/git/commits`) return { sha: newHead };
    if (path === `${root}/git/refs/heads/candidates`) {
      if (options.lostReply) throw new Error('connection lost after write');
      return {};
    }
    throw new Error(`Unexpected API ${path}`);
  };
  return { calls, content, repository: githubPublicationRepository('candidates', request) };
}

test('远端快照固定 head，并区分缺失记录与读取失败', async () => {
  const remote = github({ existing: 'pipeline/state.json' });
  const snapshot = await remote.repository.snapshot();
  assert.equal(snapshot.head, oldHead);
  assert.deepEqual(snapshot.paths, ['pipeline/state.json']);
  assert.deepEqual(await snapshot.read('pipeline/state.json'), remote.content);
  assert.equal(await snapshot.read('pipeline/identity.json'), undefined);
  const unavailable = await github({ existing: 'pipeline/state.json', blobError: true }).repository.snapshot();
  await assert.rejects(unavailable.read('pipeline/state.json'), /503/);
});

test('候选字节和进度在同一预期 head 提交，状态可更新且历史候选不可覆盖', async () => {
  const remote = github({ existing: 'pipeline/state.json' });
  const files = { 'pipeline/state.json': Buffer.from('{"generation":1,"stage":"files"}'),
    'candidates/abc-123/domains.srs': Buffer.from([0, 255, 1]) };
  assert.equal(await remote.repository.commit(oldHead, files, '候选与进度'), newHead);
  const writtenTree = remote.calls.find(call => call.args[1].endsWith('/git/trees'))!.input;
  assert.equal(writtenTree.base_tree, treeSha);
  assert.deepEqual(writtenTree.tree.map((entry: { path: string }) => entry.path), Object.keys(files));
  const commit = remote.calls.find(call => call.args[1].endsWith('/git/commits'))!.input;
  assert.deepEqual(commit.parents, [oldHead]);
  assert.deepEqual(remote.calls.at(-1)?.input, { sha: newHead, force: false });
  const duplicate = github({ existing: 'candidates/abc-123/domains.srs' });
  await assert.rejects(duplicate.repository.commit(oldHead, files, 'duplicate'), /historical candidate/);
  assert.ok(duplicate.calls.every(call => call.input === undefined), '拒绝覆盖时不得产生外部写入');
});

test('并发 head 改变不上传内容，提交回复丢失保留可核实的 commit 身份', async () => {
  const files = { 'pipeline/state.json': Buffer.from('{}') };
  const conflict = github({ changedHead: true });
  await assert.rejects(conflict.repository.commit(oldHead, files, 'stale operation'), /PUBLICATION_CONFLICT/);
  assert.ok(conflict.calls.every(call => call.input === undefined));
  const lost = github({ lostReply: true });
  await assert.rejects(lost.repository.commit(oldHead, files, 'pending operation'), error => {
    assert.ok(error instanceof PublicationWriteError);
    assert.equal(error.attemptedCommit, newHead);
    assert.match(error.message, /connection lost/);
    return true;
  });
  assert.equal(lost.calls.filter(call => call.args.includes('PATCH')).length, 1);
  assert.ok(lost.calls.every(call => !call.input?.force));
});

for (const [name, option, message] of [
  ['private repository', { private: true }, /public/],
  ['truncated tree', { truncated: true }, /incomplete tree/],
  ['missing branch', { missingBranch: true }, /404/],
  ['invalid head', { invalidHead: true }, /remote head/],
  ['invalid tree SHA', { invalidTreeSha: true }, /remote tree/],
] as const) {
  test(`远端 ${name} 不能伪装成空状态或自动创建分支`, async () => {
    const remote = github(option);
    await assert.rejects(remote.repository.snapshot(), message);
    assert.ok(remote.calls.every(call => call.input === undefined));
  });
}

test('控制记录不是普通文件或 blob 长度损坏时读取失败', async () => {
  for (const option of [{ invalidEntry: true }, { malformedBlob: true }]) {
    const snapshot = await github({ existing: 'pipeline/state.json', ...option }).repository.snapshot();
    await assert.rejects(snapshot.read('pipeline/state.json'), /record type|size mismatch/);
  }
});

test('仅允许恢复状态和候选路径，不得更新 stable 或通过路径穿越写入', async () => {
  for (const path of ['stable/ai-openai/domains.json', 'pipeline/other.json', 'candidates/abc/../state.json',
    'candidates/abc/../../stable/domains.srs', 'candidates/abc/.']) {
    const remote = github();
    await assert.rejects(remote.repository.commit(oldHead, { [path]: Buffer.from('invalid') }, 'invalid path'), /Invalid publication path/);
    assert.ok(remote.calls.every(call => call.input === undefined));
  }
  const remote = github({ existing: 'pipeline/state.json', invalidEntry: true });
  await assert.rejects(remote.repository.commit(oldHead, { 'pipeline/state.json': Buffer.from('{}') }, 'symlink'), /record type/);
  assert.ok(remote.calls.every(call => call.input === undefined));
});

test('可以按指定稳定分支读取，不改变候选仓库的写入目标', async () => {
  const remote = github();
  assert.equal((await remote.repository.snapshot('main')).head, oldHead);
  assert.equal(remote.repository.branch, 'candidates');
  await remote.repository.commit(oldHead, { 'pipeline/identity.json': Buffer.from('{}') }, 'initialize');
  assert.ok(remote.calls.at(-1)!.args[1].endsWith('/heads/candidates'));
});
