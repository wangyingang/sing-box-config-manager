import { appendFileSync, readFileSync } from 'node:fs';
import { checkRules } from './check-rules.js';
import { parseBuildConfiguration } from './configured-build.js';
import { manageMaintenance, type MaintenanceRequest, type MaintenanceSchedule } from './maintenance.js';
import { ARTIFACT_REPOSITORY, githubPublication } from './publication.js';

export interface WorkflowOptions {
  operation: 'daily' | 'check' | 'cleanup';
  target: string;
  updateEnabled: boolean;
  cleanupEnabled: boolean;
  schedule?: MaintenanceSchedule;
}

interface MaintenanceOutcome {
  status: string;
  maintenance?: 'open' | 'maintenance';
  run?: { id: string; phase: string };
}

export interface WorkflowOperations {
  check(): Promise<{ exitCode: number }>;
  maintenance(request: MaintenanceRequest): Promise<MaintenanceOutcome>;
}

export async function runRuleWorkflow(options: WorkflowOptions, operations: WorkflowOperations,
  report: (name: string, value: unknown) => void) {
  const { operation, target, updateEnabled, cleanupEnabled, schedule } = options;
  if (!['daily', 'check', 'cleanup'].includes(operation)) throw new Error('Invalid workflow operation');
  if (target !== 'main' && !/^acceptance-[a-zA-Z0-9._-]+$/.test(target)) throw new Error('Invalid workflow target');
  const isolated = target !== 'main';

  async function attempt<T>(name: string, action: () => Promise<T>) {
    let result;
    try { result = await action(); }
    catch (error) {
      report(name, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    report(name, result);
    return result;
  }

  let failed = false;
  if (operation !== 'cleanup') {
    if (isolated || updateEnabled) {
      const result = await attempt('检查规则', operations.check);
      failed = result?.exitCode !== 0;
    } else {
      report('检查规则', { status: 'disabled' });
    }
  }
  if (operation === 'check') return failed ? 1 : 0;
  if (!isolated && !cleanupEnabled) {
    report('进入维护', { status: 'disabled', schedule: { enabled: false } });
    return failed ? 1 : 0;
  }

  const entered = await attempt('进入维护', () => operations.maintenance({
    action: 'enter', ...(operation === 'cleanup' ? { manual: true } : schedule ? { schedule } : {}),
  }));
  if (!entered || entered.status === 'failed'
    || (entered.maintenance === 'maintenance' && !entered.run)) return 1;
  if (entered.status !== 'isolated') return failed ? 1 : 0;
  if (!entered.run || entered.run.phase !== 'ready') throw new Error('Maintenance retention plan is missing');
  const maintenanceId = entered.run.id;
  const prepared = await attempt('准备基线', () => operations.maintenance({ action: 'prepare', maintenanceId }));
  if (!prepared || prepared.status === 'failed') return 1;
  if (prepared.status !== 'prepared') return failed ? 1 : 0;
  const switched = await attempt('切换基线', () => operations.maintenance({ action: 'switch', maintenanceId }));
  return !switched || switched.status === 'failed'
    || (switched.maintenance === 'maintenance' && !switched.run) || failed ? 1 : 0;
}

function reportMaintenance(result: Awaited<ReturnType<typeof manageMaintenance>>) {
  const plan = 'plan' in result ? result.plan : result.run?.plan;
  return {
    status: result.status, schedule: result.schedule, generation: result.generation, maintenance: result.maintenance,
    run: result.run && { id: result.run.id, phase: result.run.phase },
    maintenanceId: 'maintenanceId' in result ? result.maintenanceId : undefined,
    phase: 'phase' in result ? result.phase : undefined,
    reason: 'reason' in result ? result.reason : undefined,
    error: 'error' in result ? result.error : undefined,
    blockers: 'blockers' in result ? result.blockers : undefined,
    completedAt: 'completedAt' in result ? result.completedAt : undefined,
    retained: plan?.retain.active.map(({ recordPath, record, control }) => ({
      recordPath, candidateId: record.candidateId, activationId: record.id, source: record.source, control,
    })),
    discard: plan && {
      candidates: plan.discard.candidateIds.length,
      activations: Object.fromEntries(Object.entries(plan.discard.activations).map(([id, versions]) => [id, versions.length])),
      operations: plan.discard.completedOperationIds.length,
    },
    otherRefs: 'otherRefs' in result ? result.otherRefs : plan?.otherRefs,
  };
}

export function workflowRules(target: string) {
  const base = parseBuildConfiguration(readFileSync(new URL('../samples/three-ai-rule-sets.yml', import.meta.url), 'utf8'));
  const configuration = JSON.stringify({ ...base, target: { ...base.target, branch: target } });
  const subscriptions = Object.fromEntries(base.ruleSets.map(({ id, stablePath }) => {
    const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target}/${stablePath}`;
    const formats = {
      binary: { url: `${prefix}/domains.srs`, requiredCapabilities: [] },
      source: { url: `${prefix}/domains.json`, requiredCapabilities: [] },
    };
    return [id, {
      schemaVersion: 2, systemRuleSetId: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
      projections: { route: { formats }, 'dns-query': { formats }, 'dns-response': { unavailable: 'empty' } },
    }];
  }));
  return { configuration, subscriptions };
}

async function main() {
  const env = process.env;
  const token = env.GH_TOKEN;
  const credentials = [token, env.GITHUB_TOKEN].filter((value): value is string => !!value);
  const summary = env.GITHUB_STEP_SUMMARY;
  if (!summary) throw new Error('Missing GITHUB_STEP_SUMMARY');
  const report = (name: string, value: unknown) => {
    const json = JSON.stringify(value, null, 2);
    const safe = credentials.reduce((text, credential) => text.replaceAll(credential, '[redacted]'), json);
    appendFileSync(summary, `### ${name}\n\n\`\`\`json\n${safe.replaceAll('\`', '\\u0060')}\n\`\`\`\n\n`);
  };
  try {
    const target = env.RULE_TARGET ?? '';
    const operation = env.RULE_OPERATION as WorkflowOptions['operation'];
    if (target === 'main' && env.GITHUB_REF !== 'refs/heads/main') throw new Error('Production requires the main workflow ref');
    const binary = env.SING_BOX_BINARY ?? '';
    const period = env.RULE_CLEANUP_PERIOD_DAYS;
    const startAt = env.RULE_CLEANUP_START_AT;
    const schedule = period || startAt ? { periodDays: Number(period), startAt: startAt ?? '' } : undefined;
    const requireToken = () => {
      if (!token) throw new Error('Missing RULE_ARTIFACT_TOKEN');
    };
    const requireSchedule = () => {
      if (schedule && !/^[1-9][0-9]*$/.test(period ?? '')) throw new Error('Invalid cleanup period in RULE_CLEANUP_PERIOD_DAYS');
    };
    report('运行', { target, operation });
    process.exitCode = await runRuleWorkflow({
      operation, target, updateEnabled: env.RULE_UPDATE_ENABLED === 'true',
      cleanupEnabled: env.RULE_CLEANUP_ENABLED === 'true', schedule,
    }, {
      async check() {
        requireToken();
        const stateDirectory = env.RULE_STATE_DIRECTORY;
        if (!stateDirectory) throw new Error('Missing RULE_STATE_DIRECTORY');
        return checkRules({ ...workflowRules(target), binary, stateDirectory, token: env.GITHUB_TOKEN });
      },
      async maintenance(request) {
        requireToken();
        if (request.action === 'enter' && !request.manual) requireSchedule();
        const repository = githubPublication(undefined, target === 'main' ? 'candidates' : target).repository!;
        return reportMaintenance(await manageMaintenance({ ...request, repository, binary }));
      },
    }, report);
  } catch (error) {
    report('工作流', { status: 'failed', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
