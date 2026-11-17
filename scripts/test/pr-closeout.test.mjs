import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../close-pr.mjs', import.meta.url));
const ghFixture = fileURLToPath(new URL('./fixtures/closeout-github.cjs', import.meta.url));
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pr-closeout-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'), main = join(root, 'main'), task = join(root, 'task'), evidence = join(task, '.verification');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', origin, main);
  git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.com');
  writeFileSync(join(main, '.gitignore'), '.verification/\nnode_modules/\n.env\n');
  writeFileSync(join(main, 'tracked.txt'), 'base\n');
  git(main, 'add', '.'); git(main, 'commit', '-m', 'base'); git(main, 'push', 'origin', 'main');
  const base = git(main, 'rev-parse', 'HEAD');
  git(main, 'worktree', 'add', task, '-b', 'codex/test');
  writeFileSync(join(task, 'tracked.txt'), 'task\n');
  git(task, 'add', '.'); git(task, 'commit', '-m', 'task'); git(task, 'push', 'origin', 'codex/test');
  const head = git(task, 'rev-parse', 'HEAD');
  // Real Git transport remains local; the configured origin still identifies
  // the same GitHub repository as the fake external API.
  git(main, 'config', `url.${origin}.insteadOf`, 'https://github.com/example/project.git');
  git(main, 'config', 'remote.origin.url', 'https://github.com/example/project.git');
  mkdirSync(evidence); writeFileSync(join(evidence, 'result.json'), '{"passed":true}\n');
  const bin = join(root, 'bin'); mkdirSync(bin);
  copyFileSync(ghFixture, join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755);
  const dataPath = join(root, 'github.json'), callsPath = join(root, 'calls.jsonl');
  const data = { origin, head, base };
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  let run = 0;
  return { root, origin, main, task, evidence, head, data, git,
    raceAtRemoval(mode) {
      writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const cp = require('node:child_process'), fs = require('node:fs');
const args = process.argv.slice(2);
const removing = args.includes('worktree') && args.includes('remove');
if (removing && ${JSON.stringify(mode)} === 'new-file') fs.writeFileSync(${JSON.stringify(join(task, 'late-user.txt'))}, 'preserve me');
const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (removing && result.status === 0 && ${JSON.stringify(mode)} === 'new-head') {
  const state = JSON.parse(fs.readFileSync(process.env.CLOSEOUT_DATA));
  cp.execFileSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(main)}, 'update-ref', 'refs/heads/codex/test', state.merge]);
}
if (removing && result.status === 0 && ${JSON.stringify(mode)} === 'new-worktree') {
  cp.execFileSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(main)}, 'worktree', 'add', ${JSON.stringify(join(root, 'other-task'))}, 'codex/test']);
}
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    },
    commands: () => readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    run(extra = [], { actions = true, issues = [48] } = {}) {
      const output = join(root, `report-${++run}`);
      writeFileSync(dataPath, JSON.stringify(data)); writeFileSync(callsPath, '');
      const args = ['--pr', '56', ...(issues.length ? issues.flatMap(number => ['--issue', String(number)]) : ['--no-issues']), '--repo', 'example/project', '--out', output,
        '--expected-head', head, ...(actions ? ['--merge', '--subject', 'test: 合并样本', '--cleanup', '--main-worktree', main,
          '--task-worktree', task, '--evidence', evidence, '--sync-main', '--publish-record'] : []), ...extra];
      const result = spawnSync(process.execPath, [script, ...args], { cwd: main, encoding: 'utf8', env: {
        ...process.env, PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
        CLOSEOUT_DATA: dataPath, CLOSEOUT_CALLS: callsPath,
      } });
      const report = existsSync(join(output, 'report.json')) ? JSON.parse(readFileSync(join(output, 'report.json'))) : undefined;
      const remote = JSON.parse(readFileSync(dataPath)); Object.assign(data, remote);
      return { code: result.status, stderr: result.stderr, stdout: result.stdout, report, output,
        remote, calls: this.commands() };
    },
  };
}
const mutations = calls => calls.filter(args => ['pr merge', 'pr comment', 'issue close', 'issue edit', 'issue comment'].includes(args.slice(0, 2).join(' ')));

test('默认预览保存快照，保留所有本地和远端状态', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.report.status, 'planned');
  assert.deepEqual(mutations(result.calls), []);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.data.base);
  assert.equal(f.git(f.task, 'rev-parse', 'HEAD'), f.data.head);
  assert.equal(f.git(f.origin, 'rev-parse', 'refs/heads/codex/test'), f.data.head);
  assert.equal(result.report.evidence.cloud[0].commit_sha, f.data.head);
});

test('显式执行完成合并、归档、清理、同步及一次交付记录', t => {
  const f = fixture(t);
  const body = join(f.root, 'issue.md'); writeFileSync(body, '- [x] 已由 Agent 验收\n');
  const result = f.run(['--apply', '--issue-body', `48=${body}`, '--ci-run', '123']);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.report.status, 'completed');
  assert.equal(result.report.after.pullRequest.state, 'MERGED');
  assert.equal(result.report.issues[0].stateReason, 'COMPLETED');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), result.remote.merge);
  assert.equal(f.git(f.main, 'status', '--porcelain'), '');
  assert.equal(existsSync(f.task), false);
  assert.equal(f.git(f.main, 'branch', '--list', 'codex/test'), '');
  assert.equal(f.git(f.main, 'ls-remote', '--heads', 'origin', 'refs/heads/codex/test'), '');
  assert.equal(readFileSync(join(result.output, 'evidence-1/result.json'), 'utf8'), '{"passed":true}\n');
  assert.equal(result.remote.edited, '- [x] 已由 Agent 验收\n');
  assert.deepEqual(result.remote.records.map(record => record.kind), ['pr comment', 'issue comment']);
  assert.equal(result.remote.records[0].body, result.remote.records[1].body);
  assert.equal(result.calls.filter(args => args[0] === 'api' && args.some(arg => arg.includes('statusCheckRollup'))).length, 1);
  assert.ok(result.calls.find(args => args[0] === 'pr' && args[1] === 'merge').includes('--match-head-commit'));
});

for (const [fault, setup, expected] of [
  ['错误 head', f => { f.data.head = 'a'.repeat(40); }, /获准提交/],
  ['关闭关联缺失', f => { f.data.references = []; }, /缺少自动关闭/],
  ['关闭关联多余', f => { f.data.references = [48, 49]; }, /意外/],
  ['draft', f => { f.data.draft = true; }, /草稿/],
  ['CI 未完成', f => { f.data.ciState = 'PENDING'; }, /CI/],
  ['CI 身份错误', f => { f.data.ciHead = 'b'.repeat(40); }, /CI/],
  ['额外 CI 身份错误', f => { f.data.runHead = 'b'.repeat(40); }, /CI run/],
  ['Codex 摘要缺失', f => { f.data.noCloud = true; }, /Codex/],
  ['Codex 仍运行', f => { f.data.reviewStatus = 'running'; }, /Codex/],
  ['Codex 覆盖旧 head', f => { f.data.reviewHead = 'c'.repeat(40); }, /Codex/],
  ['Codex 未解决 finding', f => { f.data.findings = true; }, /Codex/],
  ['未解决 thread', f => { f.data.threads = [{ id: 'thread1', isResolved: false, isOutdated: false }]; }, /threads/],
  ['任务工作区有修改', f => { writeFileSync(join(f.task, 'tracked.txt'), 'dirty'); }, /未提交/],
  ['任务有未跟踪文件', f => { writeFileSync(join(f.task, 'user.txt'), 'keep'); }, /未跟踪/],
  ['未归档 ignored 文件', f => { writeFileSync(join(f.task, '.env'), 'keep'); }, /ignored/],
  ['main 有修改', f => { writeFileSync(join(f.main, 'tracked.txt'), 'dirty'); }, /未提交/],
  ['任务本地 head 移动', f => { f.git(f.task, 'commit', '--allow-empty', '-m', 'other task'); }, /偏离/],
  ['任务锁定', f => { f.git(f.main, 'worktree', 'lock', f.task); }, /锁定/],
  ['不同来源仓库', f => { f.data.fork = 'other/project'; }, /fork/],
  ['证据符号链接', f => { symlinkSync(join(f.evidence, 'result.json'), join(f.evidence, 'alias')); }, /符号链接/],
  ['读取失败', f => { f.data.failRead = true; }, /GitHub/],
]) test(`${fault} 阻止所有远端写入和清理`, t => {
  const f = fixture(t); setup(f);
  const result = f.run(['--apply', '--ci-run', '123']);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.report.errors.join('\n'), expected);
  assert.deepEqual(mutations(result.calls), []);
  assert.ok(existsSync(f.task));
  assert.equal(f.git(f.origin, 'rev-parse', 'refs/heads/codex/test'), f.head);
});

for (const fault of ['拒绝合并', '合并回复丢失', '只排队未合并', '合并前 head 移动']) test(`${fault} 后不关闭工单、不清理、不发布记录`, t => {
  const f = fixture(t);
  if (fault === '拒绝合并') f.data.failWrite = 'pr merge';
  if (fault === '合并回复丢失') f.data.lostMergeResponse = true;
  if (fault === '只排队未合并') { f.data.queueOnly = true; f.data.noAutoClose = true; }
  if (fault === '合并前 head 移动') f.data.moveOnGuard = true;
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.ok(existsSync(f.task));
  assert.ok(mutations(result.calls).every(args => args[0] === 'pr' && args[1] === 'merge'));
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.data.base);
});

for (const fault of ['新 ignored 文件', '证据变化', '归档损坏', '远端 head 移动']) test(`合并后${fault} 阻止删除`, t => {
  const f = fixture(t);
  if (fault === '新 ignored 文件') f.data.injectAfterMerge = { path: join(f.task, '.env'), content: 'user change' };
  if (fault === '证据变化') f.data.injectAfterMerge = { path: join(f.evidence, 'result.json'), content: 'changed' };
  if (fault === '归档损坏') f.data.injectAfterMerge = { path: join(f.root, 'report-1/evidence-1/result.json'), content: 'corrupt archive' };
  if (fault === '远端 head 移动') f.data.moveRemote = true;
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.ok(result.remote.merged);
  assert.ok(existsSync(f.task));
  assert.equal(f.git(f.main, 'branch', '--list', 'codex/test').includes('codex/test'), true);
  assert.ok(!result.remote.records);
});

test('工单未自动关闭时按显式合并授权补做 completed', t => {
  const f = fixture(t); f.data.noAutoClose = true;
  const result = f.run(['--apply']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.issues[0].stateReason, 'COMPLETED');
  assert.equal(result.calls.filter(args => args[0] === 'issue' && args[1] === 'close').length, 1);
});

test('允许的 CI 跳过仍按 skipped 保存，未声明时阻止执行', t => {
  const f = fixture(t); f.data.checks = [
    { id: 'ci1', __typename: 'CheckRun', name: 'Workspace checks', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { id: 'ci2', __typename: 'CheckRun', name: 'Native sing-box', status: 'COMPLETED', conclusion: 'SKIPPED' },
  ];
  assert.equal(f.run().code, 1);
  const result = f.run(['--allow-skipped-check', 'Native sing-box']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.evidence.ci.checks[1].conclusion, 'SKIPPED');
});

test('仅合并不隐含清理、同步或发布授权', t => {
  const f = fixture(t), result = f.run(['--apply', '--merge', '--subject', 'test: 仅合并'], { actions: false });
  assert.equal(result.code, 0, result.stdout);
  assert.ok(existsSync(f.task));
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.data.base);
  assert.deepEqual(mutations(result.calls).map(args => args.slice(0, 2).join(' ')), ['pr merge']);
});

test('评论发布失败后立即停止后续工单评论，保留实际完成记录', t => {
  const f = fixture(t); f.data.failWrite = 'pr comment';
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.equal(existsSync(f.task), false);
  assert.equal(result.report.steps.find(step => step.name === 'remove-task-worktree').status, 'completed');
  assert.ok(!result.calls.some(args => args[0] === 'issue' && args[1] === 'comment'));
  assert.equal(result.report.steps.at(-1).status, 'failed-result-may-be-unknown');
});


test('fetch 失败后不再同步、删除或发布', t => {
  const f = fixture(t);
  const fetchHead = join(f.main, '.git/FETCH_HEAD');
  rmSync(fetchHead, { force: true }); mkdirSync(fetchHead);
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.equal(result.report.steps.at(-1).name, 'fetch-main');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.data.base);
  assert.ok(existsSync(f.task));
  assert.ok(!result.remote.records);
});

test('远端拒绝删除后保留本地分支与 worktree，立即停止', t => {
  const f = fixture(t);
  writeFileSync(join(f.origin, 'hooks/update'), '#!/bin/sh\nif [ "$1" = "refs/heads/codex/test" ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.equal(result.report.steps.at(-1).name, 'delete-remote-branch');
  assert.ok(existsSync(f.task));
  assert.equal(f.git(f.origin, 'rev-parse', 'refs/heads/codex/test'), f.head);
  assert.equal(f.git(f.main, 'branch', '--list', 'codex/test').includes('codex/test'), true);
  assert.ok(!result.remote.records);
});


test('帮助和无明确授权的参数在 GitHub 读取之前退出', t => {
  const f = fixture(t);
  for (const args of [['--help'], ['--apply'], ['--apply', '--merge', '--expected-head', f.head],
    ['--pr', '56', '--no-issues', '--out', join(f.root, 'invalid'), '--apply', '--cleanup'],
    ['--pr', '56', '--no-issues', '--out', join(f.root, 'invalid'), '--expected-head', 'short']]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: f.main, encoding: 'utf8' });
    assert.equal(result.status, args[0] === '--help' ? 0 : 1);
  }
});

test('清理不能删除保留工作区，任务和默认分支都保持原状', t => {
  const f = fixture(t), result = f.run(['--apply', '--task-worktree', f.main]);
  assert.equal(result.code, 1);
  assert.deepEqual(mutations(result.calls), []);
  assert.ok(existsSync(f.main)); assert.ok(existsSync(f.task));
});

test('不带合并授权时，打开的 PR 不能触发清理或同步', t => {
  const f = fixture(t), result = f.run(['--apply', '--cleanup', '--main-worktree', f.main, '--task-worktree', f.task,
    '--evidence', f.evidence], { actions: false });
  assert.equal(result.code, 1);
  assert.match(result.report.errors.join('\n'), /合并授权/);
  assert.deepEqual(mutations(result.calls), []); assert.ok(existsSync(f.task));
});


test('合并完成后可仅执行剩余的清理和同步，不再次合并或发布', t => {
  const f = fixture(t);
  const merged = f.run(['--apply', '--merge', '--subject', 'test: 先合并'], { actions: false });
  assert.equal(merged.code, 0, merged.stdout);
  const cleaned = f.run(['--apply', '--cleanup', '--sync-main', '--main-worktree', f.main, '--task-worktree', f.task,
    '--evidence', f.evidence], { actions: false });
  assert.equal(cleaned.code, 0, cleaned.stdout);
  assert.deepEqual(mutations(cleaned.calls), []);
  assert.equal(existsSync(f.task), false);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), merged.remote.merge);
});

test('显式无关联工单时只发布 PR 记录，不修改其他工单', t => {
  const f = fixture(t); f.data.references = [];
  const result = f.run(['--apply'], { issues: [] });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.report.issues, []);
  assert.ok(!result.calls.some(args => args[0] === 'issue'));
  assert.deepEqual(result.remote.records.map(record => record.kind), ['pr comment']);
});


test('worktree 移除后本地分支被并发推进时，CAS 保留新 head', t => {
  const f = fixture(t); f.raceAtRemoval('new-head');
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.equal(result.report.steps.at(-1).name, 'delete-local-branch');
  assert.equal(f.git(f.main, 'rev-parse', 'refs/heads/codex/test'), result.remote.merge);
  assert.ok(!result.remote.records);
});

test('最终移除前出现未跟踪文件时，Git 自身检查保留文件及 worktree', t => {
  const f = fixture(t); f.raceAtRemoval('new-file');
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.equal(result.report.steps.at(-1).name, 'remove-task-worktree');
  assert.equal(readFileSync(join(f.task, 'late-user.txt'), 'utf8'), 'preserve me');
  assert.equal(f.git(f.main, 'rev-parse', 'refs/heads/codex/test'), f.head);
  assert.ok(!result.remote.records);
});


test('移除后任务分支被新的 worktree 占用时拒绝删除 ref', t => {
  const f = fixture(t); f.raceAtRemoval('new-worktree');
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.equal(result.report.steps.at(-1).name, 'delete-local-branch');
  assert.equal(f.git(f.main, 'rev-parse', 'refs/heads/codex/test'), f.head);
  assert.ok(existsSync(join(f.root, 'other-task')));
});

for (const mode of ['独立 pushurl', '多 pushurl', '合并后 pushurl 变化']) test(`${mode} 不得删除另一仓库分支`, t => {
  const f = fixture(t), other = join(f.root, 'other.git');
  f.git(f.root, 'clone', '--bare', f.origin, other);
  if (mode === '合并后 pushurl 变化') {
    const path = join(f.main, '.git/config');
    f.data.injectAfterMerge = { path, content: readFileSync(path, 'utf8')+'\n[remote "origin"]\n  pushurl = '+other+'\n' };
  } else {
    f.git(f.main, 'config', '--add', 'remote.origin.pushurl', other);
    if (mode === '多 pushurl') f.git(f.main, 'config', '--add', 'remote.origin.pushurl', f.origin);
  }
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.match(result.report.errors.join('\n'), /fetch\/push/);
  assert.equal(f.git(other, 'rev-parse', 'refs/heads/codex/test'), f.head);
  assert.ok(existsSync(f.task));
  assert.equal(f.git(f.main, 'rev-parse', 'refs/heads/codex/test'), f.head);
  if (mode !== '合并后 pushurl 变化') assert.deepEqual(mutations(result.calls), []);
});


for (const fault of ['lost-merge-response', 'issue-close-failure']) test(`${fault} 后显式 --merge 补关已合并 PR 的工单`, t => {
  const f = fixture(t); f.data.noAutoClose = true;
  if (fault === 'lost-merge-response') f.data.lostMergeResponse = true;
  else f.data.failWrite = 'issue close';
  const first = f.run(['--apply']);
  assert.equal(first.code, 1);
  assert.ok(first.remote.merged); assert.ok(existsSync(f.task));
  delete f.data.failWrite; delete f.data.lostMergeResponse;
  const second = f.run(['--apply']);
  assert.equal(second.code, 0, second.stdout);
  assert.equal(second.report.issues[0].stateReason, 'COMPLETED');
  assert.equal(existsSync(f.task), false);
  assert.equal(second.calls.filter(args => args[0] === 'pr' && args[1] === 'merge').length, 0);
  assert.equal(second.calls.filter(args => args[0] === 'issue' && args[1] === 'close').length, 1);
  assert.deepEqual(second.remote.records.map(record => record.kind), ['pr comment', 'issue comment']);
});

test('已合并 PR 的工单仍 open 时，清理授权不隐含关单授权', t => {
  const f = fixture(t); f.data.noAutoClose = true; f.data.lostMergeResponse = true;
  assert.equal(f.run(['--apply']).code, 1);
  const result = f.run(['--apply', '--cleanup', '--main-worktree', f.main, '--task-worktree', f.task,
    '--evidence', f.evidence], { actions: false });
  assert.equal(result.code, 1);
  assert.deepEqual(mutations(result.calls), []);
  assert.ok(existsSync(f.task));
});

test('显式恢复不会将 NOT_PLANNED 冒充 completed', t => {
  const f = fixture(t);
  assert.equal(f.run(['--apply', '--merge', '--subject', 'test: 先合并'], { actions: false }).code, 0);
  f.data.closeReason = 'NOT_PLANNED';
  const result = f.run(['--apply']);
  assert.equal(result.code, 1);
  assert.match(result.report.errors.join('\n'), /NOT_PLANNED/);
  assert.deepEqual(mutations(result.calls), []);
  assert.ok(existsSync(f.task));
});
