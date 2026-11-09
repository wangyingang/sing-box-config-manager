import { parseArgs } from 'node:util';
import { github, readPullRequest, readIssue, issueNumber, repositoryName, requireThat, deliveryErrors } from './lib/github-delivery.mjs';

function main() {
  const { values } = parseArgs({ options: {
    pr: { type: 'string' }, issue: { type: 'string', multiple: true }, 'no-issues': { type: 'boolean' }, phase: { type: 'string' },
    repo: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/check-pr-delivery.mjs --pr <number> (--issue <number> [--issue <number> ...] | --no-issues) --phase <before-merge|after-merge> [--repo owner/name]');
    console.log('只读校验：合并前检查默认分支、PR 状态和完整自动关闭关联；合并后检查已合并及工单 COMPLETED。不会修改 GitHub，也不判断验收是否完成。');
    return;
  }
  const number = issueNumber(values.pr, '--pr');
  requireThat(Boolean(values.issue?.length) !== Boolean(values['no-issues']), '使用 --issue 列出全部应关闭工单，或用 --no-issues 声明没有待关闭工单；两者互斥');
  const expected = (values.issue ?? []).map(value => issueNumber(value, '--issue'));
  requireThat(new Set(expected).size === expected.length, '--issue 编号不能重复');
  requireThat(['before-merge', 'after-merge'].includes(values.phase), '--phase 必须是 before-merge 或 after-merge');
  requireThat(values.repo === undefined || repositoryName(values.repo), '--repo 需要 owner/name');
  const resolved = github('repo', 'view', ...(values.repo ? [values.repo] : []), '--json', 'nameWithOwner');
  requireThat(repositoryName(resolved?.nameWithOwner), '无法确定目标 GitHub 仓库');
  const snapshot = readPullRequest(resolved.nameWithOwner, number);
  const issues = expected.map(number => readIssue(snapshot.repository, number));
  const errors = deliveryErrors(snapshot, issues, expected, values.phase);
  console.log(JSON.stringify({ status: errors.length ? 'failed' : 'passed', phase: values.phase, ...snapshot, issues, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}

try { main(); }
catch (error) {
  console.log(JSON.stringify({ status: 'failed', errors: [error.message] }, null, 2));
  process.exitCode = 1;
}
