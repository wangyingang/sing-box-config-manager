import assert from 'node:assert/strict';
import test from 'node:test';
import contract from '../../contracts/rule-subscription.example.json' with { type: 'json' };
import { activateRules } from '../../src/activation.js';
import { ActivationWriteError, type ActivationTransport } from '../../src/activation-transport.js';
import { immutableUrl } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';
import { syntheticCandidate } from './activation-client-fixture.js';
const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function environment() {
  let sequence = 0, head = 'a'.repeat(40), writes = 0, failure = '', headReads = 0;
  const stored = new Map<string, Buffer>();
  const publish = async (files: Record<string, Buffer>) => {
    const commit = (++sequence).toString(16).padStart(40, '0');
    for (const [path, bytes] of Object.entries(files)) stored.set(immutableUrl(commit, path), bytes);
    return commit;
  };
  const candidate = await syntheticCandidate(binary!, 'A', 'alpha.invalid', publish);
  const subscription = JSON.parse(JSON.stringify(contract).replaceAll('/main/', '/acceptance-issue-19/'));
  const transport: ActivationTransport = {
    branch: 'acceptance-issue-19',
    async head() { if (++headReads > 1 && failure === 'unknown') throw new Error('head offline'); return head; },
    async download(url) { const bytes = stored.get(url); if (!bytes) throw new Error(`Readback HTTP 404: ${url}`); return bytes; },
    async commit(expected, files) {
      if (expected !== head) throw new Error('ACTIVATION_CONFLICT');
      writes++;
      const commit = await publish(files);
      if (['not-applied', 'unknown'].includes(failure)) throw new ActivationWriteError(commit, 'lost PATCH reply');
      head = failure === 'conflict' ? 'f'.repeat(40) : commit;
      if (['applied', 'conflict'].includes(failure)) throw new ActivationWriteError(commit, 'lost PATCH reply');
      if (failure === 'readback') stored.delete(immutableUrl(commit, 'stable/activation.json'));
      return commit;
    },
  };
  const evidence = () => JSON.parse(stored.get(candidate.candidateEvidenceUrl)!.toString());
  const url = (file: string) => immutableUrl(['domains.json', 'domains.srs'].includes(file) ? candidate.filesCommit : candidate.metadataCommit, `candidates/${candidate.id}/${file}`);
  const alter = (file: string, modify: (value: any) => any) => stored.set(url(file), encode(modify(JSON.parse(stored.get(url(file))!.toString()))));
  const seal = () => {
    alter('manifest.json', value => { for (const a of value.artifacts) { const bytes = stored.get(a.url)!; a.sha256 = sha256(bytes); a.byteLength = bytes.length; } return value; });
    alter('build.json', value => { for (const a of value.artifacts) { const bytes = stored.get(url(a.file))!; a.sha256 = sha256(bytes); a.bytes = bytes.length; } return value; });
    const e = evidence();
    for (const r of e.readback) { const bytes = stored.get(r.url)!; r.sha256 = sha256(bytes); r.byteLength = bytes.length; }
    stored.set(candidate.candidateEvidenceUrl, encode(e));
  };
  return { transport, candidate, subscription, stored, url, alter, seal,
    options: () => ({ candidateEvidenceUrl: candidate.candidateEvidenceUrl, binary: binary!, expectedHead: head, subscription, transport }),
    writes: () => writes, fail(mode: string) { failure = mode; }, head: () => head };
}

test('激活一次提交稳定 SRS、JSON 和激活记录；失败后重试已有候选', async () => {
  const env = await environment(), old = env.head(), originalEvidence = env.stored.get(env.candidate.candidateEvidenceUrl)!;
  env.fail('not-applied');
  await assert.rejects(activateRules(env.options()), /ACTIVATION_NOT_APPLIED/);
  assert.equal(env.head(), old);
  env.fail('');
  const result = await activateRules(env.options());
  assert.equal(result.status, 'activated'); assert.equal(env.writes(), 2);
  assert.equal(result.activation.expectedHead, old); assert.equal(result.activation.candidateId, env.candidate.id);
  assert.equal(Object.keys(result.activation.files).length, 2);
  assert.equal(env.stored.get(env.candidate.candidateEvidenceUrl), originalEvidence);
  assert.ok(Object.keys(result.activation.files).some(path => path.endsWith('.srs')));
});
for (const failure of ['missing-source', 'missing-evidence', 'digest', 'bad-srs', 'empty', 'false-pass', 'report', 'source', 'target', 'projection', 'term-count', 'capability']) {
  test(`${failure} 拒绝激活，稳定入口保持原版本`, async () => {
    const env = await environment();
    if (failure === 'missing-source') env.stored.delete(env.url('source.json'));
    if (failure === 'missing-evidence') env.stored.set(env.candidate.candidateEvidenceUrl, encode({ status: 'remote-verified' }));
    if (failure === 'digest') env.stored.set(env.url('domains.srs'), Buffer.from('wrong digest'));
    if (failure === 'bad-srs') { env.stored.set(env.url('domains.srs'), Buffer.from('not a loadable SRS')); env.seal(); }
    if (failure === 'empty') { env.alter('domains.json', () => ({ version: 4, rules: [] })); env.seal(); }
    if (failure === 'false-pass') { env.alter('build.json', b => ({ ...b, validation: { status: 'passed', semanticRoundTrip: true, steps: [] } })); env.seal(); }
    if (failure === 'report') { env.alter('conversion-report.json', r => ({ ...r, outputTermCount: 0 })); env.seal(); }
    if (failure === 'source') { env.alter('source.json', () => ({ repository: 'v2fly/domain-list-community' })); env.seal(); }
    if (failure === 'target') { env.alter('manifest.json', m => ({ ...m, targetVersion: '1.13.0' })); env.seal(); }
    if (failure === 'projection') { env.alter('manifest.json', m => ({ ...m, projections: { ...m.projections, 'dns-query': { unavailable: 'empty' } } })); env.seal(); }
    if (failure === 'term-count') { env.alter('manifest.json', m => { m.artifacts[0].termCount = 2; return m; }); env.seal(); }
    if (failure === 'capability') { env.alter('manifest.json', m => { m.artifacts[0].requiredCapabilities = ['processMatching']; return m; }); env.seal(); }
    const old = env.head(); await assert.rejects(activateRules(env.options()));
    assert.equal(env.head(), old); assert.equal(env.writes(), 0);
  });
}
for (const incompatible of ['version', 'usage', 'identity', 'endpoint', 'format-conflict', 'production-synthetic']) {
  test(`订阅 ${incompatible} 失配拒绝激活`, async () => {
    const env = await environment();
    if (incompatible === 'version') env.subscription.sourceFormatVersion = 3;
    if (incompatible === 'usage') env.subscription.projections['dns-response'] = env.subscription.projections.route;
    if (incompatible === 'identity') env.subscription.systemRuleSetId = 'other';
    if (incompatible === 'endpoint') env.subscription.projections.route.formats.binary.url = 'https://example.com/stable/domains.srs';
    if (incompatible === 'format-conflict') env.subscription.projections.route.formats.source.url = env.subscription.projections.route.formats.binary.url;
    if (incompatible === 'production-synthetic') (env.transport as any).branch = 'main';
    await assert.rejects(activateRules(env.options())); assert.equal(env.writes(), 0);
  });
}

test('同一预期旧状态并发激活仅一项成功；旧 expected-head 无法覆盖', async () => {
  const env = await environment(), options = env.options();
  const results = await Promise.allSettled([activateRules(options), activateRules(options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const current = env.head(); await assert.rejects(activateRules(options), /ACTIVATION_CONFLICT/);
  assert.equal(env.head(), current); assert.equal(env.writes(), 1);
});
for (const mode of ['applied', 'unknown', 'conflict', 'readback']) {
  test(`激活回复 ${mode} 通过远端核实，不重复写入或误报旧版本不变`, async () => {
    const env = await environment(); env.fail(mode);
    if (mode === 'applied') assert.equal((await activateRules(env.options())).commit, env.head());
    else await assert.rejects(activateRules(env.options()), new RegExp(({ unknown: 'ACTIVATION_UNKNOWN', conflict: 'ACTIVATION_CONFLICT_OR_SUPERSEDED', readback: 'ACTIVATION_APPLIED_READBACK_PENDING' } as Record<string, string>)[mode]));
    assert.equal(env.writes(), 1);
  });
}
test('已激活订阅契约不能随下次激活改变，避免旧配置指向不兼容入口', async () => {
  const env = await environment(); await activateRules(env.options());
  env.subscription.projections.route.formats.binary.requiredCapabilities = ['processMatching'];
  await assert.rejects(activateRules(env.options()), /contract cannot change|Conflicting/); assert.equal(env.writes(), 1);
});
