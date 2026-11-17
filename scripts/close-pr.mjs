import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { commitId, issueNumber, repositoryName, requireThat } from './lib/github-delivery.mjs';
import { closePullRequest } from './lib/pr-closeout.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    pr: { type: 'string' }, issue: { type: 'string', multiple: true }, 'no-issues': { type: 'boolean' },
    repo: { type: 'string' }, out: { type: 'string' }, apply: { type: 'boolean' }, merge: { type: 'boolean' },
    cleanup: { type: 'boolean' }, 'sync-main': { type: 'boolean' }, 'publish-record': { type: 'boolean' },
    'expected-head': { type: 'string' }, subject: { type: 'string' }, 'main-worktree': { type: 'string' },
    'task-worktree': { type: 'string' }, evidence: { type: 'string', multiple: true }, 'no-evidence': { type: 'boolean' },
    record: { type: 'string' }, 'issue-body': { type: 'string', multiple: true },
    'allow-skipped-check': { type: 'string', multiple: true }, 'ci-run': { type: 'string', multiple: true }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(`Usage: node scripts/close-pr.mjs --pr N (--issue N ... | --no-issues) --out <新目录> [动作选项]
默认只读预览 GitHub/Git，保存状态快照；添加 --apply 才执行显式选中的动作。
  --merge --expected-head SHA --subject <commit subject>  squash 合并及关联工单 completed 收尾
  --cleanup --main-worktree PATH --task-worktree PATH (--evidence DIR ... | --no-evidence)
  --sync-main --main-worktree PATH                     只允许干净默认分支快进
  --publish-record [--record FILE]                     向 PR 和关联工单各发布一条最终记录
  --issue-body N=FILE                                  应用 Agent 已审核的工单验收正文
  --ci-run ID ...                                      核对额外指定的同 head CI 运行
  --allow-skipped-check NAME ...                       显式声明允许的跳过；仍按跳过记录
  --repo owner/name                                    默认从当前 GitHub 仓库解析
CI 和 Codex 审查须已完成并覆盖当前 head；工具不会触发或等待新的检查。
动作选项表达调用方已有的用户授权，不授予合并、删除、同步或发布权限。验收由 Agent 判断。
任何失败立即停止后续步骤；失败写入可能已经生效，先查 report.json 和远端事实，再选择剩余动作。
清理仅限同仓库、同 head 的已合并任务；未提交/未跟踪文件和未归档 ignored 文件会阻止清理。
已知可再生产物 node_modules、模块 dist 和生成的 validate.cjs 可随任务清理；其他 ignored 文件须归档。`);
    return;
  }
  const issues = (values.issue ?? []).map(value => issueNumber(value, '--issue'));
  requireThat(Boolean(issues.length) !== Boolean(values['no-issues']), '明确指定 --issue 或 --no-issues');
  requireThat(new Set(issues).size === issues.length, '工单不能重复');
  requireThat(values.out?.trim(), '--out 需要新目录');
  requireThat(!values.repo || repositoryName(values.repo), '--repo 需要 owner/name');
  const actions = ['merge', 'cleanup', 'sync-main', 'publish-record'].some(key => values[key]) || values['issue-body']?.length;
  requireThat(!values.apply || actions, '--apply 须显式选择至少一项已授权动作');
  requireThat(!values['expected-head'] || commitId(values['expected-head']), '--expected-head 需要完整 SHA');
  requireThat(!values.apply || commitId(values['expected-head']), '执行前须提供完整 --expected-head');
  requireThat(!values.merge || values.subject?.trim() && values.subject.length <= 72 && !/[\r\n]/.test(values.subject), '--merge 须提供不超过 72 字符的单行 --subject');
  requireThat(!(values.cleanup || values['sync-main']) || values['main-worktree'], '清理或同步须指定 --main-worktree');
  requireThat(!values.cleanup || values['task-worktree'], '清理须指定 --task-worktree');
  requireThat(!values.cleanup || Boolean(values.evidence?.length) !== Boolean(values['no-evidence']), '清理须明确 --evidence 或 --no-evidence');
  requireThat(values.cleanup || !values.evidence?.length && !values['no-evidence'] && !values['task-worktree'], '证据和 task-worktree 参数只适用于 --cleanup');
  const issueBodies = (values['issue-body'] ?? []).map(value => {
    const index = value.indexOf('='); requireThat(index > 0 && value.slice(index + 1).trim(), '--issue-body 使用 N=FILE');
    const number = issueNumber(value.slice(0, index), '--issue-body'); requireThat(issues.includes(number), '只能更新显式关联工单的正文');
    return { number, path: resolve(value.slice(index + 1)) };
  });
  requireThat(new Set(issueBodies.map(item => item.number)).size === issueBodies.length, '工单正文不能重复');
  for (const id of values['ci-run'] ?? []) issueNumber(id, '--ci-run');
  const report = await closePullRequest({ pr: issueNumber(values.pr, '--pr'), issues, repo: values.repo, out: values.out,
    apply: !!values.apply, merge: !!values.merge, cleanup: !!values.cleanup, syncMain: !!values['sync-main'],
    publishRecord: !!values['publish-record'], expectedHead: values['expected-head'], subject: values.subject,
    mainWorktree: values['main-worktree'], taskWorktree: values['task-worktree'], evidence: (values.evidence ?? []).map(path => resolve(path)),
    record: values.record, issueBodies, allowedSkips: values['allow-skipped-check'] ?? [], ciRuns: values['ci-run'] ?? [] });
  console.log(JSON.stringify({ status: report.status, output: report.output, steps: report.steps, errors: report.errors }));
  if (report.status === 'failed') process.exitCode = 1;
}
main().catch(error => { console.error(`failed: ${error.message}`); process.exitCode = 1; });
