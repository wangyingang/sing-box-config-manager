import assert from 'node:assert/strict';
import test from 'node:test';
import { cliRulesProgress, reportRulesProgress } from '../src/rules-progress.js';

test('进度显示阶段与耗时，长阶段每 15 秒提示，结束后停止', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const lines: string[] = []; let now = 1000;
  const progress = cliRulesProgress(line => lines.push(line), () => now);
  progress.update({ stage: 'build', logicalId: 'openai' });
  assert.match(lines[0], /\+0.0s.*openai.*构建/);
  now += 15_000; t.mock.timers.tick(15_000);
  assert.match(lines[1], /\+15.0s.*openai/);
  progress.close(); t.mock.timers.tick(30_000); assert.equal(lines.length, 2);
});

test('进度 observer 和输出失败不改变操作结果', async () => {
  assert.doesNotThrow(() => reportRulesProgress(() => { throw new Error('log failed'); }, 'state'));
  reportRulesProgress(async () => { throw new Error('async observer failed'); }, 'state');
  const progress = cliRulesProgress(() => { throw new Error('closed stderr'); });
  assert.doesNotThrow(() => progress.update({ stage: 'readback' })); progress.close();
  await new Promise(resolve => setImmediate(resolve));
});
