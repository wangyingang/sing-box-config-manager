import assert from 'node:assert/strict';
import test from 'node:test';
import { runRuleWorkflow } from '../src/rule-workflow.js';
import { getRulesStatus } from '../src/index.js';
import { rulesEnvironment } from './fixtures/rules-environment.js';

test('workflow blocks production before reading or writing any state', async () => {
  const env = rulesEnvironment('/unused', 'main');
  env.context.readConfiguration = async () => assert.fail('Production adapter must not read business state');
  let text = '';
  for (const operation of ['status', 'sync', 'pin', 'resume']) {
    assert.equal(await runRuleWorkflow({ operation, target: 'main' }, output => { text = output; }, env.context), 1);
    assert.match(JSON.parse(text).error, /not enabled/);
  }
  assert.equal(env.writes.length, 0);
});

test('isolated workflow reports the shared service result and rejects retired operations', async () => {
  const env = rulesEnvironment('/unused');
  const expected = await getRulesStatus({ context: env.context });
  let text = '';
  assert.equal(await runRuleWorkflow({ operation: 'status', target: env.context.targetBranch }, output => { text = output; }, env.context), expected.exitCode);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(expected)));
  assert.equal(await runRuleWorkflow({ operation: 'check', target: env.context.targetBranch }, output => { text = output; }, env.context), 1);
  assert.equal(env.writes.length, 0);
});

test('workflow rejects a context that points at another target', async () => {
  const env = rulesEnvironment('/unused', 'main');
  env.context.readConfiguration = async () => assert.fail('A mismatched context cannot read business state');
  let output = '';
  assert.equal(await runRuleWorkflow({ operation: 'sync', target: 'acceptance-different' }, text => { output = text; }, env.context), 1);
  assert.match(JSON.parse(output).error, /disagree/);
  assert.equal(env.writes.length, 0);
});
