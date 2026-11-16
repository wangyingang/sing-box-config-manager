#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { getRulesStatus, type RuleStatus } from './rules-status.js';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from './rules-operations.js';
import { cleanupRuleHistory } from './rules-cleanup.js';
import type { RulesContext, RulesRequest } from './rules-context.js';
import type { RulesResult } from './rules-model.js';

const help = `Usage:
  pnpm rules status [id] [--json]
  pnpm rules sync [--dry-run] [--json]
  pnpm rules pin <id> <version> [--dry-run] [--json]
  pnpm rules resume <id> [--dry-run] [--json]
  pnpm rules cleanup [--dry-run] [--json]

写操作默认读取 main 当前已推送的正式配置；隔离宿主读取其受限配置分支的当前修订。
--config <path> 只可与 sync --dry-run 一起预览草稿；相对路径从调用目录解析。
sync 处理全部配置差异；status 不执行恢复或写入。
cleanup 按正式保留期清理历史；中断后重跑同一命令继续，不检查上游或改变当前交付。
环境设置：安装 sing-box 1.14.4，或设置 SING_BOX_BINARY；GitHub 使用 gh 身份。
生产写入：sync/pin/resume 需 RULE_UPDATE_ENABLED=true；cleanup 需 RULE_CLEANUP_ENABLED=true。
两个开关默认关闭，返回 disabled/未应用；status 和 dry-run 保持只读。
`;

function humanResult(result: RulesResult & { rules?: RuleStatus[]; maintenance?: string }, detailed: boolean) {
  const lines = [
    `${result.operation}: ${result.status}${result.dryRun ? ' (dry-run)' : ''}`,
    `Target: ${result.target.repository}@${result.target.branch}`,
    `Configuration: ${result.configurationRevision} (${result.configurationOrigin})`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.maintenance && result.maintenance !== 'open') lines.push(`Maintenance: ${result.maintenance}`);
  if (result.cleanup) {
    const { plan, phase, continueWith, maintenanceId, otherRefs } = result.cleanup;
    lines.push(`Cleanup: ${phase}${maintenanceId ? `; maintenance=${maintenanceId}` : ''}`,
      `Retention: ${plan.candidateRetentionDays} days; observed=${plan.cleanupObservedAt}; cutoff=${plan.cutoff}`,
      `Candidates: retain=${plan.retain.candidateIds.length}; discard=${plan.discard.candidateIds.length}; retained bytes=${plan.retainedBytes}`);
    for (const decision of plan.decisions) {
      lines.push(`  ${decision.action}: ${decision.logicalId ?? 'unknown-owner'} ${decision.versionId ?? decision.candidateId}; published=${decision.publishedAt ?? 'unknown'}; ${decision.reasons.join(', ')}`);
    }
    for (const blocker of plan.blockers) lines.push(`  Blocked: ${blocker}`);
    for (const ref of otherRefs ?? plan.otherRefs) lines.push(`  Other ref retained: ${ref.ref}@${ref.head}`);
    if (result.cleanup.unverified?.length) lines.push(`  Unverified: ${result.cleanup.unverified.join(', ')}`);
    if (continueWith) lines.push(`Continue: pnpm rules ${continueWith}`);
  }
  const rows = result.rules ?? result.results;
  for (const row of rows) {
    const status = result.rules?.find(item => item.id === row.id);
    const version = row.current?.versionId ?? (row.current ? 'migration pending' : 'not delivered');
    lines.push(`${row.id}: ${row.status}; ${row.control?.mode ?? 'unmanaged'}; current=${version}`);
    if (row.changes?.length) lines.push(`  Changes: ${row.changes.join(', ')}`);
    if (row.error) lines.push(`  Error: ${row.error}`);
    if (row.continueWith) lines.push(`  Continue: pnpm rules ${row.continueWith}`);
    if (row.unverified?.length) lines.push(`  Unverified: ${row.unverified.join(', ')}`);
    if (status) {
      lines.push(`  Candidates: ${status.candidateCount}; configuration difference=${status.configurationDifference}`);
      if (status.pendingOperation) lines.push(`  Pending: ${status.pendingOperation}`);
    }
    if (detailed || row.error || row.changes?.includes('change-source')) {
      if (row.expectedSource) lines.push(`  Expected source: ${JSON.stringify(row.expectedSource)}`);
      if (row.current) lines.push(`  Delivered source: ${JSON.stringify(row.current.source)}`);
      if (status) {
        for (const candidate of status.candidates) lines.push(`  ${candidate.versionId ?? candidate.id}: ${candidate.current ? 'current; ' : ''}${candidate.selectable ? 'selectable' : candidate.reason ?? 'unavailable'}; published=${candidate.publishedAt ?? 'unknown'}; source=${JSON.stringify(candidate.source)}`);
        for (const url of status.stableUrls) lines.push(`  ${url}`);
      }
    }
  }
  if (!rows.length && !result.error && !result.cleanup) lines.push('No managed rule sets.');
  return lines.join('\n');
}

/** Only the trusted host/test harness supplies a context; it is never a CLI flag. */
export async function runRulesCli(args: string[], output: (text: string) => void = console.log, context?: RulesContext): Promise<number> {
  let json = args.includes('--json');
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true,
      options: { help: { type: 'boolean' }, json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, config: { type: 'string' } } });
    json = Boolean(values.json);
    if (values.help) { output(help); return 0; }
    const [operation, id, version] = positionals;
    const valid = operation === 'status' ? positionals.length <= 2
      : operation === 'sync' || operation === 'cleanup' ? positionals.length === 1
      : operation === 'pin' ? positionals.length === 3
      : operation === 'resume' ? positionals.length === 2 : false;
    if (!valid) throw new Error('Use status [id], sync, pin <id> <version>, resume <id>, or cleanup; see --help');
    if (operation === 'status' && (values['dry-run'] || values.config !== undefined)) throw new Error('status is read-only and does not accept --dry-run or --config');
    if (values.config !== undefined && !values['dry-run']) throw new Error('--config requires --dry-run; writes always read the current official configuration');
    if (values.config !== undefined && operation !== 'sync') throw new Error('--config is only supported by sync --dry-run');
    const request: RulesRequest = { context, dryRun: values['dry-run'],
      ...(values.config !== undefined ? { draft: await readFile(resolve(process.env.INIT_CWD ?? process.cwd(), values.config), 'utf8') } : {}) };
    const result = operation === 'status' ? await getRulesStatus({ ...request, id })
      : operation === 'sync' ? await syncRules(request)
      : operation === 'cleanup' ? await cleanupRuleHistory(request)
      : operation === 'pin' ? await pinRuleVersion({ ...request, id, version })
      : await resumeRuleUpdates({ ...request, id });
    output(json ? JSON.stringify(result) : humanResult(result, Boolean(id)));
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output(json ? JSON.stringify({ operation: args[0] ?? 'unknown', status: 'failed', exitCode: 1, error: message }) : `Error: ${message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runRulesCli(process.argv.slice(2));
