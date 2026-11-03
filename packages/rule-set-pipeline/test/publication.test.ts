import assert from 'node:assert/strict';
import test from 'node:test';
import { ARTIFACT_REPOSITORY, githubPublication, type ghJson } from '../src/publication.js';

function github(options: { existing?: string; truncated?: boolean; conflict?: boolean } = {}) {
  const calls: { args: string[]; input: any }[] = [];
  const request: typeof ghJson = async (args, input) => {
    calls.push({ args, input });
    const path = args[1];
    const root = `repos/${ARTIFACT_REPOSITORY}`;
    if (path === root) return { private: false, default_branch: 'main' };
    if (path === root + '/git/matching-refs/heads/candidates') return [];
    if (path === root + '/git/ref/heads/main') return { object: { sha: 'a'.repeat(40) } };
    if (path === root + '/git/refs') return { object: { sha: 'a'.repeat(40) } };
    if (path === root + '/git/commits/' + 'a'.repeat(40)) return { tree: { sha: 'b'.repeat(40) } };
    if (path === root + '/git/trees/' + 'b'.repeat(40) + '?recursive=1') return { truncated: !!options.truncated, tree: options.existing ? [{ path: options.existing }] : [] };
    if (path === root + '/git/blobs') return { sha: 'c'.repeat(40) };
    if (path === root + '/git/trees') return { sha: 'd'.repeat(40) };
    if (path === root + '/git/commits') return { sha: 'e'.repeat(40) };
    if (path === root + '/git/refs/heads/candidates') {
      if (options.conflict) throw new Error('non-fast-forward');
      return {};
    }
    throw new Error(`Unexpected API ${path}`);
  };
  return { transport: githubPublication(request), calls };
}

test('GitHub 发布只追加候选文件，通过非强制 candidates 引用更新，保留历史 tree', async () => {
  const remote = github();
  assert.equal(await remote.transport.commit({ 'candidates/abc-123/domains.srs': Buffer.from([0, 255, 1]) }, 'candidate'), 'e'.repeat(40));
  const blob = remote.calls.find(call => call.args[1].endsWith('/git/blobs'))!;
  assert.deepEqual(Buffer.from(blob.input.content, 'base64'), Buffer.from([0, 255, 1]));
  const tree = remote.calls.find(call => call.args[1].endsWith('/git/trees'))!;
  assert.equal(tree.input.base_tree, 'b'.repeat(40));
  const mutation = remote.calls.at(-1)!;
  assert.ok(mutation.args[1].endsWith('/heads/candidates'));
  assert.equal(mutation.input.force, false);
  assert.ok(!remote.calls.some(call => call.args.includes('PATCH') && !call.args[1].endsWith('/heads/candidates')));
});
for (const [name, options, path] of [
  ['历史路径', { existing: 'candidates/abc/domains.json' }, 'candidates/abc/domains.json'],
  ['tree 截断', { truncated: true }, 'candidates/abc/domains.json'],
  ['并发冲突', { conflict: true }, 'candidates/abc/domains.json'],
  ['稳定路径', {}, 'stable/domains.json'],
] as const) {
  test(`${name} 拒绝发布，不强制覆盖`, async () => {
    const remote = github(options);
    await assert.rejects(remote.transport.commit({ [path]: Buffer.from('content') }, 'candidate'));
    assert.ok(remote.calls.every(call => !call.input?.force));
  });
}
