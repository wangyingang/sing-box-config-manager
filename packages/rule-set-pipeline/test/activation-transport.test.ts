import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivationWriteError, githubActivation } from '../src/activation-transport.js';
import { ARTIFACT_REPOSITORY, GitHubHttpError, immutableUrl, type ghJson } from '../src/publication.js';

import { sha256 } from '../src/release.js';

const oldHead = 'a'.repeat(40), newCommit = 'e'.repeat(40);
const journalHead = 'f'.repeat(40), operationId = 'b53efb87-d1ab-4661-a689-e65a4b327fea';
const recordPath = 'stable/ai-openai/activation.json', rulePath = 'stable/ai-openai/domains.srs';
const candidateId = '1234', candidateEvidenceUrl = immutableUrl('d'.repeat(40), `candidates/${candidateId}/readback.json`);
const statePath = 'pipeline/state.json';
const operation = { id: operationId, kind: 'activate', logicalId: 'ai-openai', recordPath, generation: 1,
  expectedHead: oldHead, candidateId, candidateEvidenceUrl };
const identity = { schemaVersion: 1, id: 'test', targetBranch: 'main' };
const journal = { ...identity, generation: 1, maintenance: 'open',
  state: { schemaVersion: 1, pinned: {}, processed: {}, candidates: {} }, manualOperations: { [operationId]: operation } };
const rule = Buffer.from('rule');
const stableFiles = { [rulePath]: rule, [recordPath]: Buffer.from(JSON.stringify({ schemaVersion: 1, ...operation,
  operation: undefined, files: { [rulePath]: { byteLength: rule.length, sha256: sha256(rule) } },
  control: { revision: operationId, reason: 'manual-activation', pauseAutomaticActivation: true, pauseAutomaticRetry: false } })) };
const reservation = { operationId, journalHead };

function github(options: { branch?: string; head?: string; private?: boolean; missing?: boolean; patchError?: Error;
  managedRecord?: boolean; maintenance?: boolean; onPatch?: () => Promise<void> } = {}) {
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
    if (path === `${root}/git/trees/${'b'.repeat(40)}?recursive=1`) {
      return { tree: options.managedRecord ? [{ path: recordPath, type: 'blob', mode: '100644' }] : [] };
    }
    if (path === `${root}/git/ref/heads/candidates`) return { object: { sha: journalHead } };
    if (path === `${root}/git/commits/${journalHead}`) return { tree: { sha: '2'.repeat(40) } };
    if (path === `${root}/git/trees/${'2'.repeat(40)}?recursive=1`) {
      return { tree: [statePath, 'pipeline/identity.json'].map((path, index) => ({ path, sha: String(index + 3).repeat(40),
        type: 'blob', mode: '100644' })) };
    }
    if ([`${root}/git/blobs/${'3'.repeat(40)}`, `${root}/git/blobs/${'4'.repeat(40)}`].includes(path)) {
      const data = path.endsWith('3'.repeat(40)) ? { ...journal, ...(options.maintenance ? { maintenance: 'maintenance' } : {}) } : identity;
      const bytes = Buffer.from(JSON.stringify(data));
      return { content: bytes.toString('base64'), encoding: 'base64', size: bytes.length };
    }
    if (path === `${root}/git/blobs`) return { sha: 'c'.repeat(40) };
    if (path === `${root}/git/trees`) return { sha: 'd'.repeat(40) };
    if (path === `${root}/git/commits`) return { sha: newCommit };
    if (path === `${root}/git/refs/heads/${branch}` && args.includes('PATCH')) {
      await options.onPatch?.();
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

const recordUrl = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${oldHead}/stable/activation.json`;
function activationRecord(options: { absent?: boolean; truncated?: boolean; pathType?: string; pathMode?: string; blobEncoding?: string; blobContent?: unknown; blobSize?: number; recordPath?: string; failureAt?: 'commit' | 'tree' | 'blob' } = {}) {
  const paths: string[] = [];
  const content = Buffer.from('{"subscription":{"schemaVersion":1},"note":"已激活"}\n');
  const request: typeof ghJson = async (args, input) => {
    assert.equal(input, undefined, 'Record inspection must be read-only');
    const path = args[1].replace(`repos/${ARTIFACT_REPOSITORY}/`, ''); paths.push(path);
    const failurePath = options.failureAt === 'commit' ? `git/commits/${oldHead}`
      : options.failureAt === 'tree' ? `git/trees/${'b'.repeat(40)}?recursive=1`
      : options.failureAt === 'blob' ? `git/blobs/${'c'.repeat(40)}` : undefined;
    if (path === failurePath) throw new Error(`API unavailable: ${options.failureAt}`);
    if (path === `git/commits/${oldHead}`) return { tree: { sha: 'b'.repeat(40) } };
    if (path === `git/trees/${'b'.repeat(40)}?recursive=1`) return { truncated: options.truncated ?? false,
      tree: options.absent ? [{ path: 'README.md', type: 'blob', sha: 'd'.repeat(40) }]
        : [{ path: options.recordPath ?? 'stable/activation.json', type: options.pathType ?? 'blob', mode: options.pathMode ?? '100644', sha: 'c'.repeat(40) }] };
    if (path === `git/blobs/${'c'.repeat(40)}`) return { encoding: options.blobEncoding ?? 'base64', size: options.blobSize ?? content.length, content: options.blobContent ?? content.toString('base64').replace(/.{24}/g, '$&\n') };
    throw new Error(`Unexpected record API ${path}`);
  };
  return { transport: githubActivation('main', request), paths, content };
}

test('固定 commit 的激活记录经 tree 定位并从 Git blob 解码，返回原始 UTF-8 字节', async () => {
  const remote = activationRecord();
  assert.deepEqual(await remote.transport.download(recordUrl), remote.content);
  assert.deepEqual(remote.paths, [`git/commits/${oldHead}`, `git/trees/${'b'.repeat(40)}?recursive=1`, `git/blobs/${'c'.repeat(40)}`]);
});

test('完整 tree 证明激活记录不存在后才报告 404，不请求 blob 或 raw CDN', async () => {
  const remote = activationRecord({ absent: true });
  await assert.rejects(remote.transport.download(recordUrl), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /^Readback HTTP 404:/); return true;
  });
  assert.deepEqual(remote.paths, [`git/commits/${oldHead}`, `git/trees/${'b'.repeat(40)}?recursive=1`]);
});

for (const failureAt of ['commit', 'tree', 'blob'] as const) {
  test(`读取激活记录的 ${failureAt} API 故障不误报记录缺失`, async () => {
    const remote = activationRecord({ failureAt });
    await assert.rejects(remote.transport.download(recordUrl), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /API unavailable/); assert.doesNotMatch(error.message, /Readback HTTP 404:/); return true;
    });
  });
}

for (const options of [{ absent: true, truncated: true }, { pathType: 'tree' }, { pathType: 'commit' }]) {
  test(`tree 不完整或记录不是 blob 时拒绝推断激活状态 ${JSON.stringify(options)}`, async () => {
    const remote = activationRecord(options);
    await assert.rejects(remote.transport.download(recordUrl), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /Readback HTTP 404:/); return true;
    });
    assert.ok(!remote.paths.some(path => path.startsWith('git/blobs/')));
  });
}

for (const options of [{ pathMode: '120000' }, { blobEncoding: 'utf-8' }, { blobContent: 123 }, { blobSize: 999 }]) {
  test(`激活记录为符号链接或 blob 编码与长度不符时拒绝 ${JSON.stringify(options)}`, async () => {
    const remote = activationRecord(options);
    await assert.rejects(remote.transport.download(recordUrl), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /Readback HTTP 404:/); return true;
    });
  });
}

for (const recordPath of ['stable/ai-openai/activation.json', 'stable/providers/ai_openai.v2/activation.json']) {
  test(`多集旧记录 ${recordPath} 从完整 Git tree/blob 读取，不依赖 CDN 404`, async () => {
    const remote = activationRecord({ recordPath });
    assert.deepEqual(await remote.transport.download(recordUrl.replace('stable/activation.json', recordPath)), remote.content);
    assert.equal(remote.paths.length, 3);
  });
}


test('低层激活 transport 拒绝直接修改配置化稳定文件，也拒绝伪造登记', async () => {
  const remote = github();
  await assert.rejects(remote.transport.commit(oldHead, { [rulePath]: rule }, '绕过登记'), /requires a registered write/);
  assert.equal(remote.calls.length, 0);
  await assert.rejects(remote.transport.commit(oldHead, stableFiles, '伪造登记', { ...reservation, operationId: 'unregistered' }),
    /PUBLICATION_CONFLICT/);
  assert.ok(!remote.calls.some(call => call.args.includes('PATCH')));
});

test('允许旧 v1 入口更新既有格式，拒绝它覆盖配置化规则集的稳定文件', async () => {
  const legacy = github();
  await legacy.transport.commit(oldHead, { 'stable/v2fly/category-ai-not-cn/domains.srs': rule, 'stable/activation.json': Buffer.from('{}') }, '旧单集');
  assert.ok(legacy.calls.some(call => call.args.includes('PATCH')));
  const managed = github({ managedRecord: true });
  await assert.rejects(managed.transport.commit(oldHead, { [rulePath]: rule, 'stable/activation.json': Buffer.from('{}') }, '覆盖固定版本'),
    /owned by another rule set/);
  assert.ok(!managed.calls.some(call => call.args.includes('PATCH')));
});

test('配置化提交准备完毕后，维护门禁拒绝就不会发送 ref PATCH', async () => {
  const remote = github({ maintenance: true });
  await assert.rejects(remote.transport.commit(oldHead, stableFiles, '激活候选', reservation), /PUBLICATION_CONFLICT/);
  assert.ok(remote.calls.some(call => call.args[1].endsWith('/git/commits') && call.input));
  assert.ok(!remote.calls.some(call => call.args.includes('PATCH')));
});

test('真实双分支 transport 已通过登记检查后，维护仍须等在途稳定写入完成或失效', async () => {
  const remote = github({ async onPatch() {
    const next = Buffer.from(JSON.stringify({ ...journal, maintenance: 'maintenance', generation: 2 }));
    await assert.rejects(remote.transport.repository!.commit(journalHead, { [statePath]: next }, '尝试开始维护'), /MANUAL_OPERATION_PENDING/);
  } });
  assert.equal(await remote.transport.commit(oldHead, stableFiles, '激活候选', reservation), newCommit);
  assert.equal(remote.calls.filter(call => call.args.includes('PATCH')).length, 1);
});

test('配置化 PATCH 的明确服务端拒绝和超时分别处理', async () => {
  const rejected = new GitHubHttpError(422, 'Update rejected');
  const remote = github({ patchError: rejected });
  await assert.rejects(remote.transport.commit(oldHead, stableFiles, '激活候选', reservation), error => error === rejected);
  const ambiguous = github({ patchError: new GitHubHttpError(504, 'Gateway timeout') });
  await assert.rejects(ambiguous.transport.commit(oldHead, stableFiles, '激活候选', reservation), ActivationWriteError);
});
