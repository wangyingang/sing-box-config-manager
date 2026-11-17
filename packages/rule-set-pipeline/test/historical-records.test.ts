import assert from 'node:assert/strict';
import test from 'node:test';
import { activationRecord, verifyStableFiles } from '../src/remote-status.js';
import { historicalEnvironment } from './fixtures/historical-environment.js';

const path = 'stable/openai/activation.json';
for (const fault of ['missing', 'schema', 'identity', 'repository', 'branch', 'path', 'file-set', 'mapping', 'history']) {
  test(`历史激活记录读取拒绝 ${fault}，不要求旧 status 返回字段`, async () => {
    const env = await historicalEnvironment('shared');
    const stable = await env.context.repository.snapshot(env.context.targetBranch);
    const record = JSON.parse((await stable.read(path))!.toString());
    const projection = record.subscription.projections;
    if (fault === 'missing') delete record.subscription;
    if (fault === 'schema') record.subscription.schemaVersion = 1;
    if (fault === 'identity') record.subscription.systemRuleSetId = 'another-rule-set';
    if (fault === 'repository') projection.route.formats.binary.url = projection.route.formats.binary.url.replace('sing-box-rule-artifacts', 'untrusted-artifacts');
    if (fault === 'branch') projection.route.formats.binary.url = projection.route.formats.binary.url.replace('/acceptance-issue-99-history/', '/other/');
    if (fault === 'path') projection.route.formats.binary.url = projection.route.formats.binary.url.replace('/stable/', '/stable/../');
    if (fault === 'file-set') delete record.files['stable/openai/domains.srs'];
    if (fault === 'mapping') delete projection['dns-query'].formats.source;
    if (fault === 'history') record.history.push({ commit: 'short', id: 'old', candidateId: 'b2' });
    assert.throws(() => activationRecord(record, path, env.context.targetBranch),
      fault === 'history' ? /Invalid activation history/ : /subscription|Subscription|activation file set/);
    assert.equal(env.writes.length, 0);
  });
}

test('历史记录稳定文件缺失或字节损坏被拒绝', async () => {
  for (const bytes of [undefined, Buffer.from('corrupted')]) {
    const env = await historicalEnvironment('shared');
    const stable = await env.context.repository.snapshot(env.context.targetBranch);
    const { record } = activationRecord(JSON.parse((await stable.read(path))!.toString()), path, env.context.targetBranch);
    await assert.rejects(verifyStableFiles(record, file => file.endsWith('.srs') ? Promise.resolve(bytes) : stable.read(file)), /Stable file integrity/);
    assert.equal(env.writes.length, 0);
  }
});
