import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { github, repositoryName, issueNumber, requireThat } from './lib/github-delivery.mjs';
import { createReportDirectory } from './lib/audit-output.mjs';
import { auditSpec } from './lib/spec-delivery.mjs';
import { inspectEvidence } from './lib/verification-evidence.mjs';

async function main() {
  const { values } = parseArgs({ options: { spec: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' },
    link: { type: 'string', multiple: true }, evidence: { type: 'string', multiple: true }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/check-spec-delivery.mjs --spec <number> --out <new-directory> [--repo owner/name] [--link <issue>:<pr>] [--evidence <verification-directory>]');
    console.log('只读核对子工单、关联 PR、CI、云端审查及本地证据；--link 和 --evidence 可重复。完整报告落盘，不判断验收语义或关闭工单。');
    return;
  }
  const number = issueNumber(values.spec, '--spec');
  requireThat(values.out?.trim(), '--out 需要新证据目录');
  requireThat(values.repo === undefined || repositoryName(values.repo), '--repo 需要 owner/name');
  const links = (values.link ?? []).map(value => {
    const parts = value.split(':'); requireThat(parts.length === 2, '--link 使用 issue:pr');
    return { issue: issueNumber(parts[0], '--link issue'), pr: issueNumber(parts[1], '--link pr') };
  });
  requireThat(new Set((values.link ?? [])).size === links.length, '--link 不能重复');
  const output = await createReportDirectory(values.out, values.evidence ?? []);
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'failed', errors: [], evidence: [], acceptance: 'not-evaluated' };
  try {
    const repo = github('repo', 'view', ...(values.repo ? [values.repo] : []), '--json', 'nameWithOwner');
    requireThat(repositoryName(repo?.nameWithOwner), '无法确认目标仓库');
    Object.assign(report, auditSpec(repo.nameWithOwner, number, links));
    for (const directory of values.evidence ?? []) report.evidence.push(await inspectEvidence(directory));
    for (const evidence of report.evidence) if (evidence.status !== 'passed') report.warnings.push(`本地证据未通过：${evidence.directory}`);
    if (!report.evidence.length) report.warnings.push('未提供本地验收证据；这里只核对 GitHub 交付状态');
    report.status = report.warnings.length ? 'attention' : 'passed';
  } catch (error) { report.errors.push(error.message); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`${report.status}: 子工单 ${report.issues?.length ?? 0}，PR ${report.pullRequests?.length ?? 0}，证据 ${report.evidence.length}，待核对 ${report.warnings?.length ?? 0}，读取错误 ${report.errors.length}。验收语义未判断。报告：${join(output, 'report.json')}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

main().catch(error => { console.error(`failed: ${error.message}`); process.exitCode = 1; });
