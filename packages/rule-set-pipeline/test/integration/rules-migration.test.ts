import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRules } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';
import { baselineV4Configuration } from '../fixtures/formal-configuration.js';
import { historicalEnvironment } from '../fixtures/historical-environment.js';

for (const name of ['shared', 'split', 'srs-only', 'incomplete'] as const) {
  test(`${name}: v4 requires an empty target and preserves previously captured state`, async () => {
    const env = await historicalEnvironment(name);
    const { context } = env;
    const heads = new Map(env.heads);
    const oldConfig = await syncRules({ context });
    assert.equal(oldConfig.status, 'failed');
    assert.match(oldConfig.error!, /schemaVersion.*expected 4/);

    env.configure(baselineV4Configuration(false));
    for (const result of await Promise.all([
      syncRules({ context }), syncRules({ context, dryRun: true }),
      getRulesStatus({ context }), cleanupRuleHistory({ context }),
    ])) {
      assert.equal(result.status, 'failed');
      assert.match(result.error!, /RULE_STATE_MIGRATION_REQUIRED.*empty artifact target/);
    }
    assert.deepEqual(env.heads, heads);
    assert.equal(env.writes.length, 0);
  });
}
