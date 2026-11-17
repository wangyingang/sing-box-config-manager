import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createReportDirectory } from './audit-output.mjs';
import { github, readPullRequest, readIssue, deliveryErrors, requireThat } from './github-delivery.mjs';
import { readPullRequestEvidence } from './spec-delivery.mjs';
import { git, assertClean, assertMain, inspectWorkspace, assertTask, archiveEvidence, verifyArchives, remoteHead } from './closeout-workspace.mjs';

function writeGitHub(...args) {
  // A failed write is never retried: the receipt may be unknown. The report
  // preserves completed steps so the next invocation can inspect actual state.
  execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] });
}
function checkDelivery(snapshot, issues, expected, phase) {
  const errors = deliveryErrors(snapshot, issues, expected, phase);
  requireThat(errors.length === 0, errors.join('; '));
}
function checkEvidence(evidence, head, allowedSkips) {
  const { ci, cloud, reviews, threads } = evidence;
  requireThat(ci.commit === head && ci.state === 'SUCCESS' && ci.checks.length > 0, 'CI 未完成、失败、缺失或未覆盖当前 PR head');
  for (const check of ci.checks) {
    if (check.__typename === 'StatusContext') requireThat(check.state === 'SUCCESS', `CI ${check.context} 未通过`);
    else requireThat(check.status === 'COMPLETED' && (check.conclusion === 'SUCCESS'
      || check.conclusion === 'SKIPPED' && allowedSkips.includes(check.name)), `CI ${check.name} 未通过或跳过未声明`);
  }
  requireThat(cloud.length > 0, '缺少可核对的 Codex 审查摘要；先按仓库流程确认审查结果');
  for (const review of cloud.slice(0, 1)) requireThat(review.status === 'completed' && review.commit_sha === head
    && review.has_unresolved_findings === false, '已触发的 Codex 审查未完成、未覆盖当前 head 或仍有未解决 findings');
  requireThat(threads.every(thread => thread.isResolved), '存在未解决的 review threads');
  requireThat(!reviews.some(review => review.state === 'CHANGES_REQUESTED' && !review.author?.login), '存在无法归属的请求修改 review');
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))) {
    if (review.author?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.author.login, review.state);
  }
  requireThat(![...latest.values()].includes('CHANGES_REQUESTED'), '仍有请求修改的 review');
}

function deliveryMarkdown(report, prefix) {
  const skipped = report.evidence.ci.checks.filter(check => check.conclusion === 'SKIPPED').map(check => check.name);
  const snapshot = report.after ?? report.before;
  return `${prefix ? prefix.trim() + '\n\n' : ''}收尾状态：${report.status}\n\n`
    + `- PR：${snapshot.pullRequest.url}\n- 受核验 head：\`${snapshot.pullRequest.headCommit}\`\n`
    + `- 合并提交：${snapshot.pullRequest.mergeCommit ? '`' + snapshot.pullRequest.mergeCommit + '`' : '尚未合并'}\n`
    + `- 工单：${report.issues.map(issue => `#${issue.number} ${issue.state}/${issue.stateReason ?? ''}`).join('；') || '无待关闭工单'}\n`
    + `- 已完成步骤：${report.steps.filter(step => step.status === 'completed').map(step => step.name).join('、') || (report.status === 'planned' ? '只读预览' : '无需重复执行合并或清理')}\n`
    + `- CI：${report.evidence.ci.state}，覆盖 \`${report.evidence.ci.commit}\`；跳过项：${skipped.join('、') || '无'}\n`
    + report.runs.map(run => `- 额外 CI：[运行](${run.url}) ${run.status}/${run.conclusion}，覆盖 \`${run.headSha}\`\n`).join('')
    + `- Codex 审查：${report.evidence.cloud[0] ? `${report.evidence.cloud[0].status}，覆盖 \`${report.evidence.cloud[0].commit_sha}\`` : '未发现已触发的摘要'}\n`
    + `- 证据归档：${report.archives.length} 份；源码身份、原始审查和 CI 数据见本次本地 report.json\n`;
}

export async function closePullRequest(options) {
  const output = await createReportDirectory(options.out, options.evidence);
  const report = { schemaVersion: 1, status: 'failed', startedAt: new Date().toISOString(), output,
    actions: { merge: options.merge, cleanup: options.cleanup, syncMain: options.syncMain, publishRecord: options.publishRecord },
    steps: [], archives: [], errors: [], acceptance: 'agent-evaluated' };
  let currentStep;
  const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  async function step(name, work) {
    currentStep = { name, status: 'running' }; report.steps.push(currentStep); await save();
    const value = await work(); currentStep.status = 'completed'; await save(); return value;
  }
  try {
    const repository = options.repo ?? github('repo', 'view', '--json', 'nameWithOwner').nameWithOwner;
    const initial = readPullRequest(repository, options.pr, { includeHead: true });
    requireThat(!options.expectedHead || initial.pullRequest.headCommit === options.expectedHead, 'PR head 不同于获准提交');
    report.before = initial;
    report.issues = options.issues.map(number => readIssue(repository, number));
    const phase = initial.pullRequest.state === 'MERGED' ? 'after-merge' : 'before-merge';
    checkDelivery(initial, report.issues, options.issues, phase);
    report.evidence = readPullRequestEvidence(initial);
    checkEvidence(report.evidence, initial.pullRequest.headCommit, options.allowedSkips);
    report.runs = options.ciRuns.map(id => {
      const run = github('run', 'view', id, '--repo', repository, '--json', 'headSha,status,conclusion,jobs,url');
      requireThat(run.headSha === initial.pullRequest.headCommit && run.status === 'completed' && run.conclusion === 'success'
        && run.jobs.length > 0 && run.jobs.every(job => job.status === 'completed' && (job.conclusion === 'success'
          || job.conclusion === 'skipped' && options.allowedSkips.includes(job.name))), `指定 CI run ${id} 未通过或身份不符`);
      return run;
    });
    requireThat(phase === 'after-merge' || options.merge || !options.apply, 'PR 尚未合并；清理或同步不能代替合并授权');
    const workspace = await inspectWorkspace(options, initial, output);
    report.workspace = workspace;
    const prefix = options.record ? await readFile(options.record, 'utf8') : '';
    const bodies = await Promise.all(options.issueBodies.map(async item => ({ ...item, body: await readFile(item.path, 'utf8') })));
    if (!options.apply) {
      report.status = 'planned';
      await writeFile(join(output, 'delivery.md'), deliveryMarkdown(report, prefix), { flag: 'wx', mode: 0o600 });
      return report;
    }
    if (options.cleanup) report.archives = await step('archive-evidence', () => archiveEvidence(workspace, output));
    let snapshot = initial;
    if (options.merge && phase === 'before-merge') {
      requireThat(isDeepStrictEqual(initial, readPullRequest(repository, options.pr, { includeHead: true })), '合并前 PR 或关闭关联发生变化');
      await step('merge', () => writeGitHub('pr', 'merge', String(options.pr), '--repo', repository, '--squash',
        '--match-head-commit', options.expectedHead, '--subject', options.subject));
      snapshot = readPullRequest(repository, options.pr, { includeHead: true });
      requireThat(snapshot.pullRequest.headCommit === options.expectedHead, '合并后的 PR head 身份变化');
      requireThat(snapshot.pullRequest.state === 'MERGED' && snapshot.pullRequest.mergeCommit, '未确认实际合并，停止工单收尾');
      report.issues = options.issues.map(number => readIssue(repository, number));
      for (const issue of report.issues.filter(issue => issue.state === 'OPEN')) {
        await step(`close-issue-${issue.number}`, () => writeGitHub('issue', 'close', String(issue.number), '--repo', repository, '--reason', 'completed'));
        Object.assign(issue, readIssue(repository, issue.number));
      }
    }
    checkDelivery(snapshot, report.issues, options.issues, 'after-merge'); report.after = snapshot;
    for (const item of bodies) {
      const path = join(output, `issue-${item.number}.md`); await writeFile(path, item.body, { flag: 'wx', mode: 0o600 });
      await step(`update-issue-${item.number}`, () => writeGitHub('issue', 'edit', String(item.number), '--repo', repository, '--body-file', path));
    }
    if (workspace) {
      assertMain(workspace);
      await step('fetch-main', () => git(workspace.main, 'fetch', 'origin', `refs/heads/${snapshot.defaultBranch}:refs/remotes/origin/${snapshot.defaultBranch}`));
      git(workspace.main, 'merge-base', '--is-ancestor', snapshot.pullRequest.mergeCommit, `refs/remotes/origin/${snapshot.defaultBranch}`);
      if (options.syncMain) {
        await step('sync-main', () => {
          assertClean(workspace.main);
          requireThat(git(workspace.main, 'branch', '--show-current') === snapshot.defaultBranch, '同步前保留工作区分支变化');
          git(workspace.main, 'merge-base', '--is-ancestor', 'HEAD', `refs/remotes/origin/${snapshot.defaultBranch}`);
          git(workspace.main, 'merge', '--ff-only', `refs/remotes/origin/${snapshot.defaultBranch}`);
          requireThat(git(workspace.main, 'rev-parse', 'HEAD') === git(workspace.main, 'rev-parse', `refs/remotes/origin/${snapshot.defaultBranch}`), 'main 同步结果不符');
        });
      }
      if (options.cleanup) {
        await assertTask(workspace, options.expectedHead); await verifyArchives(report.archives);
        const remote = remoteHead(workspace.main, workspace.branch);
        requireThat(remote === undefined || remote === options.expectedHead, '远端任务分支已移动，停止清理');
        if (remote) await step('delete-remote-branch', () => git(workspace.main, 'push', 'origin', '--delete', workspace.branch,
          `--force-with-lease=refs/heads/${workspace.branch}:${options.expectedHead}`));
        await assertTask(workspace, options.expectedHead); await verifyArchives(report.archives);
        await step('remove-task-worktree', () => git(workspace.main, 'worktree', 'remove', '--force', workspace.task));
        await step('delete-local-branch', () => git(workspace.main, 'branch', '--delete', '--force', workspace.branch));
        requireThat(!remoteHead(workspace.main, workspace.branch), '远端任务分支仍存在');
        requireThat(git(workspace.main, 'branch', '--list', workspace.branch) === '', '本地任务分支仍存在');
        requireThat(!existsSync(workspace.task), '任务 worktree 仍存在');

      }
    }
    report.status = 'completed';
    const recordPath = join(output, 'delivery.md');
    await writeFile(recordPath, deliveryMarkdown(report, prefix), { flag: 'wx', mode: 0o600 });
    if (options.publishRecord) {
      await step('publish-pr-record', () => writeGitHub('pr', 'comment', String(options.pr), '--repo', repository, '--body-file', recordPath));
      for (const issue of report.issues) await step(`publish-issue-${issue.number}-record`, () => writeGitHub('issue', 'comment', String(issue.number), '--repo', repository, '--body-file', recordPath));
    }
    return report;
  } catch (error) {
    report.status = 'failed'; report.errors.push(error.message);
    if (currentStep?.status === 'running') currentStep.status = 'failed-result-may-be-unknown';
    return report;
  } finally {
    report.finishedAt = new Date().toISOString(); await save();
  }
}
