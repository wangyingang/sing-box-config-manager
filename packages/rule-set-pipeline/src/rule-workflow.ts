import { appendFileSync } from 'node:fs';
import { runRulesCli } from './cli.js';
import { createGitHubRulesContext, type RulesContext } from './rules-context.js';

export interface RuleWorkflowRequest {
  target: string;
  operation: string;
  id?: string;
  version?: string;
  dryRun?: boolean;
}

/** #84 provides an isolated thin adapter. Production triggers belong to #86. */
export async function runRuleWorkflow(request: RuleWorkflowRequest, report: (text: string) => void, context?: RulesContext) {
  if (!/^acceptance-[a-zA-Z0-9._-]+$/.test(request.target)) {
    report(JSON.stringify({ status: 'failed', exitCode: 1, error: 'Production workflow is not enabled; use an isolated acceptance-* target until #86' }));
    return 1;
  }
  const execution = context ?? await createGitHubRulesContext();
  if (execution.targetBranch !== request.target) {
    report(JSON.stringify({ status: 'failed', exitCode: 1, error: 'Workflow context and target disagree' }));
    return 1;
  }
  const args = [request.operation];
  if (request.id) args.push(request.id);
  if (request.version) args.push(request.version);
  if (request.dryRun) args.push('--dry-run');
  args.push('--json');
  return runRulesCli(args, report, execution);
}

async function main() {
  const env = process.env;
  const summary = env.GITHUB_STEP_SUMMARY;
  if (!summary) throw new Error('Missing GITHUB_STEP_SUMMARY');
  const credentials = [env.GH_TOKEN, env.GITHUB_TOKEN].filter((value): value is string => Boolean(value));
  const report = (value: string) => {
    const safe = credentials.reduce((text, token) => text.replaceAll(token, '[redacted]'), value).replaceAll('`', '\\u0060');
    appendFileSync(summary, `\`\`\`json\n${safe}\n\`\`\`\n`);
  };
  process.exitCode = await runRuleWorkflow({ target: env.RULE_TARGET ?? '', operation: env.RULE_OPERATION ?? '',
    id: env.RULE_ID, version: env.RULE_VERSION, dryRun: env.RULE_DRY_RUN === 'true' }, report);
}
if (import.meta.main) await main();
