import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowRules, runRuleWorkflow, type WorkflowOptions, type WorkflowOperations } from '../src/rule-workflow.js';

function run(options: Partial<WorkflowOptions>, operations: Partial<WorkflowOperations> = {}) {
  const reports: Record<string, unknown> = {};
  const result = runRuleWorkflow({
    operation: 'daily', target: 'main', updateEnabled: false, cleanupEnabled: false, ...options,
  }, {
    check: async () => assert.fail('Unexpected update'),
    maintenance: async request => assert.fail(`Unexpected maintenance: ${request.action}`),
    ...operations,
  }, (name, value) => { reports[name] = value; });
  return { result, reports };
}

test('正式配置为三集生成新稳定 URL，并按用途复用规则文件', () => {
  const { subscriptions } = workflowRules('acceptance-issue-67');
  assert.deepEqual(Object.keys(subscriptions), ['openai', 'anthropic', 'google-deepmind']);
  for (const [id, value] of Object.entries(subscriptions)) {
    assert.equal(value.systemRuleSetId, id);
    const route = value.projections.route;
    assert.ok('formats' in route);
    const prefix = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/acceptance-issue-67/stable/${id}`;
    assert.deepEqual(route.formats, {
      binary: { url: `${prefix}/domains.srs`, requiredCapabilities: [] },
      source: { url: `${prefix}/domains.json`, requiredCapabilities: [] },
    });
    assert.deepEqual(value.projections['dns-query'], route);
    assert.deepEqual(value.projections['dns-response'], { unavailable: 'empty' });
  }
});

test('daily and manual operations keep production writes disabled by default', async () => {
  for (const operation of ['daily', 'check', 'cleanup'] as const) {
    const { result, reports } = run({ operation });
    assert.equal(await result, 0);
    assert.ok(Object.values(reports).every(value => (value as { status: string }).status === 'disabled'));
  }
});

test('daily and manual check publish the same per-set result and report pending verification as failure', async () => {
  const update = { exitCode: 1, results: [
    { id: 'openai', status: 'paused', control: { reason: 'manual-rollback' } },
    { id: 'anthropic', status: 'activated', current: { id: 'new-version' } },
    { id: 'google-deepmind', status: 'verification-pending', error: 'Readback pending' },
  ] };
  for (const operation of ['daily', 'check'] as const) {
    const { result, reports } = run({ operation, target: 'acceptance-example' }, {
      check: async () => update,
      maintenance: async request => {
        assert.deepEqual(request, { action: 'enter' });
        return { status: 'disabled' };
      },
    });
    assert.equal(await result, 1);
    assert.deepEqual(reports['检查规则'], update);
    assert.equal('进入维护' in reports, operation === 'daily');
  }
});

test('manual cleanup follows the maintenance run it entered and reports a failed switch', async () => {
  const requests: unknown[] = [];
  const { result, reports } = run({ operation: 'cleanup', cleanupEnabled: true }, {
    async maintenance(request) {
      requests.push(request);
      if (request.action === 'enter') return { status: 'isolated', run: { id: 'maintenance-id', phase: 'ready' } };
      if (request.action === 'prepare') return { status: 'prepared' };
      return { status: 'failed', phase: 'readback', error: 'Stable readback pending' };
    },
  });
  assert.equal(await result, 1);
  assert.deepEqual(requests, [
    { action: 'enter', manual: true },
    { action: 'prepare', maintenanceId: 'maintenance-id' },
    { action: 'switch', maintenanceId: 'maintenance-id' },
  ]);
  assert.deepEqual(reports['切换基线'], { status: 'failed', phase: 'readback', error: 'Stable readback pending' });
});

test('daily cleanup uses the existing schedule decision and stops on normal deferral', async () => {
  const schedule = { periodDays: 14, startAt: '2026-11-01T00:00:00Z' };
  for (const status of ['not-due', 'no-cleanup', 'deferred']) {
    const { result, reports } = run({ cleanupEnabled: true, schedule }, {
      maintenance: async request => {
        assert.deepEqual(request, { action: 'enter', schedule });
        return { status, reason: 'Maintenance decision' };
      },
    });
    assert.equal(await result, 0);
    assert.deepEqual(reports['进入维护'], { status, reason: 'Maintenance decision' });
  }
});

test('a previous switch still awaiting verification fails the workflow', async () => {
  const { result } = run({ operation: 'cleanup', cleanupEnabled: true }, {
    maintenance: async () => ({ status: 'deferred', maintenance: 'maintenance', reason: 'Use maintenance-resume' }),
  });
  assert.equal(await result, 1);
});

test('manual cleanup reports pending remote verification as a failure while deferring writes', async () => {
  const deferred = { status: 'deferred', blockers: [{ id: 'operation', status: 'activated-readback-pending' }] };
  const { result, reports } = run({ operation: 'cleanup', cleanupEnabled: true }, {
    maintenance: async request => {
      assert.equal(request.action, 'enter');
      return deferred;
    },
  });
  assert.equal(await result, 1);
  assert.deepEqual(reports['进入维护'], deferred);
});

test('an inspection error fails the workflow even when maintenance defers writes', async () => {
  const deferred = { status: 'deferred', error: 'Unable to list artifact refs' };
  const { result, reports } = run({ operation: 'cleanup', cleanupEnabled: true }, {
    maintenance: async () => deferred,
  });
  assert.equal(await result, 1);
  assert.deepEqual(reports['进入维护'], deferred);
});
