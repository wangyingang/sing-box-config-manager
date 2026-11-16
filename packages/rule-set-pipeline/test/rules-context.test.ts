import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubRulesContext, guardRulesConfiguration, loadRulesRequest, readCurrentRulesConfiguration } from '../src/rules-context.js';
import { cleanupRuleHistory } from '../src/rules-cleanup.js';
import { syncRules, pinRuleVersion, resumeRuleUpdates } from '../src/rules-operations.js';
import { runRulesCli } from '../src/cli.js';
import { rulesEnvironment } from './fixtures/rules-environment.js';
import { cleanupEnvironment } from './fixtures/cleanup-environment.js';

test('disabled production operations report the current configuration without reading legacy state or upstream', async () => {
  const env = rulesEnvironment('/unused', 'main');
  env.context.allowWrites = false;
  env.context.allowCleanupWrites = false;
  env.context.repository.snapshot = async () => assert.fail('Closed gates must not read the artifact journal');
  const requests = [syncRules({ context: env.context }),
    pinRuleVersion({ context: env.context, id: 'openai', version: 'retained' }),
    resumeRuleUpdates({ context: env.context, id: 'openai' }), cleanupRuleHistory({ context: env.context })];
  for (const result of await Promise.all(requests)) {
    assert.equal(result.status, 'disabled');
    assert.equal(result.exitCode, 0);
    assert.equal(result.configurationRevision, '1'.padStart(40, '0'));
    assert.match(result.error!, /未应用/);
  }
  let output = '';
  assert.equal(await runRulesCli(['sync', '--json'], value => { output = value; }, env.context), 0);
  assert.equal(JSON.parse(output).status, 'disabled');
  assert.equal(await runRulesCli(['pin', '--json'], () => {}, env.context), 1);
  assert.equal(env.writes.length, 0);
  assert.equal(env.requests.length, 0);
});

test('cleanup and update gates are independent and remain checked at write time', async () => {
  const env = cleanupEnvironment('/unused', 'main');
  env.configure({ ...env.config(), sources: {}, ruleSets: [] });
  env.context.allowWrites = false;
  env.context.allowCleanupWrites = true;
  assert.equal((await syncRules({ context: env.context })).status, 'disabled');
  assert.equal((await cleanupRuleHistory({ context: env.context })).status, 'success');
  const cleanup = await loadRulesRequest({ context: env.context }, 'cleanup');
  await guardRulesConfiguration(cleanup);
  env.context.allowCleanupWrites = false;
  await assert.rejects(guardRulesConfiguration(cleanup), /DISABLED/);
  env.context.allowWrites = true;
  assert.equal((await cleanupRuleHistory({ context: env.context })).status, 'disabled');
  assert.equal((await syncRules({ context: env.context })).status, 'success');
});

test('disabled environments still support read-only cleanup previews', async () => {
  const env = cleanupEnvironment('/unused');
  env.context.allowWrites = false;
  env.context.allowCleanupWrites = false;
  const result = await cleanupRuleHistory({ context: env.context, dryRun: true });
  assert.equal(result.status, 'success');
  assert.equal(result.dryRun, true);
  assert.equal(env.writes.length + env.stageWrites.length + env.refWrites.length, 0);
});

test('configuration reads resolve the current branch head on every request, never the triggering SHA', async () => {
  const calls: string[] = [];
  let revision = 'a'.repeat(40);
  const request = async (args: string[]) => {
    const path = args[1]; calls.push(path);
    return path.endsWith('/commits/acceptance-test') ? { sha: revision }
      : { encoding: 'base64', content: Buffer.from(`configuration-${revision}`).toString('base64') };
  };
  const first = await readCurrentRulesConfiguration(request, 'acceptance-test');
  revision = 'b'.repeat(40);
  const second = await readCurrentRulesConfiguration(request, 'acceptance-test');
  assert.notEqual(first.revision, second.revision);
  assert.equal(second.content, `configuration-${revision}`);
  assert.match(second.origin, /@acceptance-test$/);
  assert.ok(calls[3].endsWith(`?ref=${revision}`));
  await assert.rejects(readCurrentRulesConfiguration(request, 'untrusted'), /Invalid/);
});

test('trusted environment rejects test configuration for production and derives two closed gates', async () => {
  const names = ['RULE_TARGET', 'RULE_CONFIG_BRANCH', 'RULE_UPDATE_ENABLED', 'RULE_CLEANUP_ENABLED'] as const;
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    const disabled = await createGitHubRulesContext();
    assert.equal(disabled.allowWrites, false);
    assert.equal(disabled.allowCleanupWrites, false);
    process.env.RULE_CLEANUP_ENABLED = 'true';
    const cleanupOnly = await createGitHubRulesContext();
    assert.equal(cleanupOnly.allowWrites, false);
    assert.equal(cleanupOnly.allowCleanupWrites, true);
    process.env.RULE_CONFIG_BRANCH = 'acceptance-test';
    await assert.rejects(createGitHubRulesContext(), /cannot authorize production/);
    process.env.RULE_TARGET = 'acceptance-other';
    await assert.rejects(createGitHubRulesContext(), /must match/);
    process.env.RULE_TARGET = 'acceptance-test';
    const isolated = await createGitHubRulesContext();
    assert.equal(isolated.allowWrites, true);
    assert.equal(isolated.allowCleanupWrites, true);
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});
