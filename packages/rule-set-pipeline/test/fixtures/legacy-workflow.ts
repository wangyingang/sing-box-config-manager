// Historical maintenance/check regression harness; not a runtime entry point.
import { configuredSubscriptions, parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';
import type { MaintenanceRequest, MaintenanceSchedule } from '../../src/maintenance.js';

export interface WorkflowOptions {
  operation: 'daily' | 'check' | 'cleanup';
  target: string;
  updateEnabled: boolean;
  cleanupEnabled: boolean;
  schedule?: MaintenanceSchedule;
}

interface MaintenanceOutcome {
  status: string;
  error?: string;
  maintenance?: 'open' | 'maintenance';
  run?: { id: string; phase: string };
  blockers?: { status: string }[];
}

export interface WorkflowOperations {
  check(): Promise<{ exitCode: number }>;
  maintenance(request: MaintenanceRequest): Promise<MaintenanceOutcome>;
}

function maintenanceFailed(result: MaintenanceOutcome | undefined) {
  return !result || result.status === 'failed' || result.error !== undefined
    || (result.maintenance === 'maintenance' && !result.run)
    || result.blockers?.some(({ status }) => /(?:^|-)verification-pending$|-commit-pending$|-readback-pending$/.test(status)
      || status === 'current-evidence-mismatch' || status === 'candidate-completion-unverified');
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
  if (!entered || maintenanceFailed(entered)) return 1;
  if (entered.status !== 'isolated') return failed ? 1 : 0;
  if (!entered.run || entered.run.phase !== 'ready') throw new Error('Maintenance retention plan is missing');
  const maintenanceId = entered.run.id;
  const prepared = await attempt('准备基线', () => operations.maintenance({ action: 'prepare', maintenanceId }));
  if (!prepared || maintenanceFailed(prepared)) return 1;
  if (prepared.status !== 'prepared') return failed ? 1 : 0;
  const switched = await attempt('切换基线', () => operations.maintenance({ action: 'switch', maintenanceId }));
  return maintenanceFailed(switched) || failed ? 1 : 0;
}

export function workflowRules(target: string) {
  const base = parseBuildConfiguration(readOfficialConfiguration());
  const configuration = parseBuildConfiguration(JSON.stringify({ ...base, target: { ...base.target, branch: target } }));
  return { configuration: JSON.stringify(configuration), subscriptions: configuredSubscriptions(configuration) };
}
