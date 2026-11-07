import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ARTIFACT_REPOSITORY } from '../../src/publication.js';

test('隔离引用支持原子强制更新，陈旧租约不会留下半切换', {
  skip: process.env.RULE_MAINTENANCE_REF_PROBE !== '1', timeout: 180_000,
}, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'rule-maintenance-refs-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await promisify(execFile)('git', [
    '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    '-c', 'user.name=Rule Maintenance Acceptance', '-c', 'user.email=rule-maintenance@users.noreply.github.com',
    ...args,
  ], { cwd, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  await git('init', '--bare');
  const tree = await git('hash-object', '-w', '-t', 'tree', '/dev/null');
  const suffix = randomUUID();
  const before = await git('commit-tree', tree, '-m', `Issue 52 probe before ${suffix}`);
  const after = await git('commit-tree', tree, '-m', `Issue 52 probe after ${suffix}`);
  const refs = ['stable', 'candidates'].map(role => `refs/heads/acceptance-issue-52-${suffix}-${role}`);
  const remote = `https://github.com/${ARTIFACT_REPOSITORY}.git`;
  const heads = async () => new Map((await git('ls-remote', '--refs', remote, ...refs))
    .split('\n').filter(Boolean).map(line => {
      const [head, ref] = line.split('\t');
      return [ref, head];
    }));
  const push = (expected: string[], commit: string) => git('push', '--atomic', '--porcelain',
    ...refs.map((ref, index) => `--force-with-lease=${ref}:${expected[index]}`), remote,
    ...refs.map(ref => `${commit}:${ref}`));
  try {
    await push(['', ''], before);
    assert.deepEqual(await heads(), new Map(refs.map(ref => [ref, before])));
    await assert.rejects(push([before, after], after), (error: Error & { stdout?: string }) =>
      /stale info/.test(error.stdout ?? ''));
    assert.deepEqual(await heads(), new Map(refs.map(ref => [ref, before])));
    await push([before, before], after);
    assert.deepEqual(await heads(), new Map(refs.map(ref => [ref, after])));
    t.diagnostic(JSON.stringify({ refs, before, after, staleLeaseRejected: true }));
  } finally {
    const owned = [...await heads()].filter(([, head]) => head === before || head === after);
    if (owned.length) await git('push', '--atomic', ...owned.map(([ref, head]) => `--force-with-lease=${ref}:${head}`),
      remote, ...owned.map(([ref]) => `:${ref}`));
    assert.equal((await heads()).size, 0);
  }
});
