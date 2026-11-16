import { appendFileSync, writeFileSync } from 'node:fs';
import { runRulesCli } from './cli.js';
import { createGitHubRulesContext, type RulesContext } from './rules-context.js';

export interface RuleWorkflowRequest {
  target: string;
  operation: string;
  id?: string;
  version?: string;
  dryRun?: boolean;
}

type WorkflowReport = (text: string) => void;
type WorkflowRunner = (request: RuleWorkflowRequest, report: WorkflowReport, context?: RulesContext) => Promise<number>;
interface WorkflowResult {
  status: string;
  exitCode: number;
  error?: string;
  maintenance?: string;
  rules?: { status: string; pendingOperation?: string; error?: string }[];
  results?: { status: string; error?: string }[];
}

function validTarget(target: string) {
  if (target !== 'main' && !/^acceptance-[a-zA-Z0-9._-]+$/.test(target)) throw new Error('Invalid workflow target');
}

function workflowArguments(request: RuleWorkflowRequest) {
  const { operation, id, version, dryRun } = request;
  const hasId = id !== undefined && id !== '';
  const hasVersion = version !== undefined && version !== '';
  const valid = operation === 'status' ? !hasVersion && !dryRun
    : operation === 'sync' || operation === 'cleanup' ? !hasId && !hasVersion
    : operation === 'pin' ? hasId && hasVersion
    : operation === 'resume' ? hasId && !hasVersion : false;
  if (!valid || id?.startsWith('-') || version?.startsWith('-')) {
    throw new Error('Use status [id], sync, pin <id> <version>, resume <id>, or cleanup; unrelated inputs are not accepted');
  }
  return [operation, ...hasId ? [id!] : [], ...hasVersion ? [version!] : [], ...dryRun ? ['--dry-run'] : [], '--json'];
}

/** Actions adapts inputs only. All five operations use the CLI's application services and write gates. */
export async function runRuleWorkflow(request: RuleWorkflowRequest, report: WorkflowReport, context?: RulesContext): Promise<number> {
  try {
    validTarget(request.target);
    const args = workflowArguments(request);
    const execution = context ?? await createGitHubRulesContext();
    if (execution.targetBranch !== request.target) throw new Error('Workflow context and target disagree');
    return await runRulesCli(args, report, execution);
  } catch (error) {
    report(JSON.stringify({ operation: request.operation, target: request.target, status: 'failed', exitCode: 1,
      error: error instanceof Error ? error.message : String(error) }));
    return 1;
  }
}

function sharedStateException(row: { status: string; error?: string }) {
  return row.status === 'superseded'
    || /RULE_(WRITE_|INTENT_|MAINTENANCE|STATE_|TARGET_|MIGRATION)|PUBLICATION_(PENDING|CONFLICT)/.test(row.error ?? '');
}

function uncertainSharedState(result: WorkflowResult) {
  if (result.status === 'disabled') return false;
  return result.status === 'pending' || Boolean(result.error)
    || result.results?.some(row => row.status === 'pending' || sharedStateException(row));
}

// Status only routes a registered delivery to sync. The service rechecks the
// operation, receipts, intent and CAS before it can make any shared write.
function registeredDeliveryRecovery(result: WorkflowResult) {
  const pending = result.rules?.filter(row => row.status === 'pending') ?? [];
  return result.status === 'pending' && !result.error && pending.length > 0
    && pending.every(row => Boolean(row.pendingOperation))
    && !result.rules?.some(sharedStateException);
}

/** Trigger orchestration is internal; daily is deliberately not a sixth manager operation. */
export async function runRuleAutomation(request: { event: 'push' | 'schedule'; target: string }, report: WorkflowReport,
  context?: RulesContext, execute: WorkflowRunner = runRuleWorkflow): Promise<number> {
  validTarget(request.target);
  const execution = context ?? await createGitHubRulesContext();
  if (execution.targetBranch !== request.target) throw new Error('Workflow context and target disagree');
  async function operation(name: 'status' | 'sync' | 'cleanup') {
    let result: WorkflowResult | undefined;
    const exitCode = await execute({ operation: name, target: request.target }, text => {
      report(text);
      result = JSON.parse(text) as WorkflowResult;
    }, execution);
    if (!result || result.exitCode !== exitCode) throw new Error(`Missing or inconsistent ${name} workflow result`);
    return result;
  }
  if (request.event === 'push') return (await operation('sync')).exitCode;
  if (request.event !== 'schedule') throw new Error('Only push and schedule are automatic rule triggers');

  // Default-off hosts can report the observed configuration without interpreting
  // or migrating old production state. The services still enforce both gates.
  if (!execution.allowWrites && !(execution.allowCleanupWrites ?? execution.allowWrites)) {
    const sync = await operation('sync');
    const cleanup = await operation('cleanup');
    return sync.exitCode || cleanup.exitCode ? 1 : 0;
  }
  const observed = await operation('status');
  if (observed.maintenance === 'maintenance') {
    const resumed = await operation('cleanup');
    // A disabled cleanup is not evidence that maintenance was completed.
    if (resumed.exitCode !== 0 || resumed.status !== 'success') return 1;
  } else if (uncertainSharedState(observed) && !registeredDeliveryRecovery(observed)) {
    return 1;
  }
  const sync = await operation('sync');
  if (registeredDeliveryRecovery(observed) && sync.status === 'disabled') return 1;
  // An ordinary per-rule source failure does not block a safe cleanup. A shared
  // conflict or unknown result must be resolved before another write is attempted.
  if (uncertainSharedState(sync)) return 1;
  const cleanup = await operation('cleanup');
  return sync.exitCode || cleanup.exitCode ? 1 : 0;
}

async function main() {
  const env = process.env;
  const summary = env.GITHUB_STEP_SUMMARY;
  if (!summary) throw new Error('Missing GITHUB_STEP_SUMMARY');
  const credentials = [env.GH_TOKEN, env.GITHUB_TOKEN].filter((value): value is string => Boolean(value));
  const redact = (text: string) => credentials.reduce((value, token) => value.replaceAll(token, '[redacted]'), text);
  const results: unknown[] = [];
  const report = (value: string) => {
    const safe = redact(value);
    results.push(JSON.parse(safe));
    appendFileSync(summary, `\`\`\`json\n${safe.replaceAll('`', '\\u0060')}\n\`\`\`\n`);
  };
  const event = env.RULE_EVENT_NAME ?? 'workflow_dispatch';
  const target = env.RULE_TARGET ?? 'main';
  let exitCode = 1;
  try {
    if (event === 'push' || event === 'schedule') {
      exitCode = await runRuleAutomation({ event, target }, report);
    } else if (event === 'workflow_dispatch') {
      exitCode = await runRuleWorkflow({ target, operation: env.RULE_OPERATION ?? '',
        id: env.RULE_ID, version: env.RULE_VERSION, dryRun: env.RULE_DRY_RUN === 'true' }, report);
    } else throw new Error(`Unsupported workflow event: ${event}`);
  } catch (error) {
    report(JSON.stringify({ status: 'failed', exitCode: 1, error: error instanceof Error ? error.message : String(error) }));
  } finally {
    appendFileSync(summary, `\nOverall result: ${exitCode === 0 ? 'success (see each operation for disabled/unchanged)' : 'failed; completed changes remain in effect'}\n`);
    if (env.RULE_RESULT_PATH) writeFileSync(env.RULE_RESULT_PATH, redact(JSON.stringify({ event, target, exitCode, results }, null, 2)) + '\n');
    process.exitCode = exitCode;
  }
}
if (import.meta.main) await main();
