import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicationWriteError } from '../../src/publication-repository.js';
import { encodeRecord, parseRulesJournal, RULE_STATE_PATH, type RuleCandidate } from '../../src/rules-model.js';
import { syncRules, pinRuleVersion } from '../../src/rules-operations.js';
import { getRulesStatus } from '../../src/rules-status.js';
import { immutableUrl } from '../../src/publication.js';
import { sha256 } from '../../src/release.js';
import { checkpointFixture, rulesEnvironment } from '../fixtures/rules-environment.js';
import { cleanupEnvironment } from '../fixtures/cleanup-environment.js';
import { cleanupRuleHistory } from '../../src/rules-cleanup.js';

const binary = process.env.SING_BOX_TEST_BINARY;
if (!binary) throw new Error('Set SING_BOX_TEST_BINARY to an absolute 1.14.4 binary path');

const versionFixtures = new Map<string, ReturnType<typeof prepareVersions>>();

async function versions(target = 'acceptance-selection') {
  let prepared = versionFixtures.get(target);
  if (!prepared) {
    prepared = prepareVersions(target);
    versionFixtures.set(target, prepared);
  }
  const { checkpoint, results } = await prepared;
  const env = rulesEnvironment(binary!, target, checkpoint());
  const journal = async () => parseRulesJournal((await (await env.context.repository.snapshot()).read(RULE_STATE_PATH))!);
  return { ...env, ...results(), journal };
}

// Prepare two real versions per layout, then re-open the data in each scenario.
async function prepareVersions(target: string) {
  const env = rulesEnvironment(binary!, target);
  const config = env.config();
  config.sources.cidr = { repository: 'gaoyifan/china-operator-ip', version: 'git-branch', branch: 'ip-lists',
    input: { format: 'cidr-text', path: 'china46.txt' } };
  config.ruleSets[1] = { id: 'china-ip', source: 'cidr', list: 'all', stablePath: 'stable/china-ip',
    usages: { route: { artifact: 'route' }, 'dns-query': { unavailable: 'empty' }, 'dns-response': { artifact: 'route' } } };
  env.configure(config);
  const first = await syncRules({ context: env.context });
  assert.equal(first.status, 'success', JSON.stringify(first));
  const original = new Map(await stableBytes(env));
  env.changeCidr('192.0.2.128/25\n2001:db8:2::/48\n');
  env.upstream({ openai: 'domain:new.example' });
  const second = await syncRules({ context: env.context });
  assert.equal(second.status, 'success', JSON.stringify(second));
  return { checkpoint: env.checkpoint(), results: checkpointFixture({ first, second, original }) };
}

async function stableBytes(env: ReturnType<typeof rulesEnvironment>) {
  const snapshot = await env.context.repository.snapshot(env.context.targetBranch);
  return new Map(await Promise.all(snapshot.paths.filter(path => path.startsWith('stable/'))
    .map(async path => [path, await snapshot.read(path)] as const)));
}

// A damaged remote may serve the same replacement at the immutable address and
// in the retained tree. Recompute outer digests to exercise each inner boundary.
async function damage(env: Pick<ReturnType<typeof rulesEnvironment>, 'context' | 'trees' | 'heads'> & { journal(): Promise<ReturnType<typeof parseRulesJournal>> },
  candidate: RuleCandidate) {
  const prefix = `candidates/${candidate.id}/`;
  const read = async (file: string) => (await (await env.context.repository.snapshot()).read(prefix + file))!;
  const replace = (file: string, bytes?: Buffer) => {
    for (const tree of env.trees.values()) if (tree.has(prefix + file)) {
      if (bytes) tree.set(prefix + file, bytes); else tree.delete(prefix + file);
    }
  };
  const evidence = JSON.parse((await read('readback.json')).toString());
  const saveEvidence = () => replace('readback.json', encodeRecord(evidence));
  const change = async (file: string, alter: (value: any) => void) => {
    const value = JSON.parse((await read(file)).toString()); alter(value);
    replace(file, encodeRecord(value));
  };
  const changeCandidate = async (alter: (value: RuleCandidate) => void) => {
    const journal = await env.journal(); alter(journal.candidates[candidate.id]);
    env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(journal));
  };
  const replaceRetained = (file: string, bytes: Buffer) => {
    env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(prefix + file, bytes);
  };
  return { read, replace, replaceRetained, evidence, saveEvidence, change, changeCandidate };
}

async function replaceSrs(env: Parameters<typeof damage>[0], candidate: RuleCandidate, stem: string) {
  const d = await damage(env, candidate), invalid = Buffer.from('not an SRS file');
  d.replace(`${stem}.srs`, invalid);
  const record = d.evidence.readback.find((r: any) => r.url.endsWith(`/${stem}.srs`));
  record.sha256 = sha256(invalid); record.byteLength = invalid.length;
  await d.change('manifest.json', m => { const a = m.artifacts.find((a: any) => a.format === 'binary'); a.sha256 = sha256(invalid); a.byteLength = invalid.length; });
  d.saveEvidence();
}

test('候选证据边界逐项拒绝损坏；status 只读且 pin 保留当前及兄弟集字节', async t => {
  type Corruption = (d: Awaited<ReturnType<typeof damage>>) => Promise<void> | void;
  const cases: [string, RegExp, Corruption][] = [
    ['wrong-rule', /identity mismatch/, d => d.change('manifest.json', m => { m.id = 'china-ip'; })],
    ['duplicate-artifact', /Duplicate artifact identity/, d => d.change('manifest.json', m => { m.artifacts[1].id = m.artifacts[0].id; })],
    ['extra-artifact', /Unsupported candidate projections/, d => d.change('manifest.json', m => { m.artifacts.push({ ...m.artifacts[0], id: 'extra' }); })],
    ...['domains.json', 'domains.srs', 'manifest.json', 'build.json', 'readback.json']
      .map(file => [`missing-${file}`, /Missing retained file/, (d: Awaited<ReturnType<typeof damage>>) => d.replace(file)] as typeof cases[number]),
    ['missing-readback', /Missing complete readback/, async d => { d.evidence.readback.pop(); await d.saveEvidence(); }],
    ['readback-digest', /Readback integrity mismatch/, d => d.replace('domains.srs', Buffer.from('tampered'))],
    ['readback-length', /Readback integrity mismatch/, async d => { d.evidence.readback.find((r: any) => r.url.endsWith('/domains.srs')).byteLength++; await d.saveEvidence(); }],
    ['manifest-digest', /Artifact integrity/, d => d.change('manifest.json', m => { m.artifacts[1].sha256 = 'f'.repeat(64); })],
    ['manifest-length', /Artifact integrity/, d => d.change('manifest.json', m => { m.artifacts[1].byteLength++; })],
    ['usage', /Projection availability/, d => d.change('manifest.json', m => { m.projections['dns-response'] = m.projections.route; })],
    ['capability', /Artifact integrity or capability/, d => d.change('manifest.json', m => { m.artifacts[1].requiredCapabilities = ['processMatching']; })],
    ['projection-mapping', /Projection mapping/, d => d.change('manifest.json', m => { m.projections['dns-query'].artifactIds = ['missing', m.artifacts[0].id]; })],
    ['build-policy', /Incomplete native validation record/, d => d.change('build.json', b => { b.validation.policy = 'old-policy'; })],
    ['binary-term-count', /Invalid Artifact Manifest/, d => d.change('manifest.json', m => { m.artifacts[1].termCount = 1; })],
    ['version', /stage or version differs/, d => d.change('readback.json', r => { r.versionId = 'other'; })],
    ['files-commit', /stage or version differs/, d => d.change('readback.json', r => { r.filesCommit = 'a'.repeat(40); })],
    ['missing-publication-commit', /Git publication stage missing/, d => d.changeCandidate(c => {
      c.evidenceCommit = 'a'.repeat(40);
      c.evidenceUrl = immutableUrl(c.evidenceCommit, `candidates/${c.id}/readback.json`);
    })],
    ['source-binding', /source binding mismatch/, d => d.changeCandidate(c => { c.source.repository = 'other/repo'; })],
    ['tools', /Build identity mismatch/, d => d.change('build.json', b => { b.tools.yaml = 'wrong'; })],
    ['build-identity', /Configured build identity/, d => d.change('build.json', b => { b.id = 'china-ip'; })],
    ['build-target', /Configured build identity/, d => d.change('build.json', b => { b.target.branch = 'other'; })],
    ...[null, { artifactManifest: 2, sourceFormat: 4, buildRecord: 2 },
      { artifactManifest: 1, sourceFormat: 4 }, { artifactManifest: 2, sourceFormat: 4, buildRecord: 4 }]
      .map((contracts, index) => [`build-contracts-${index}`, /Unsupported build contracts/,
        (d: Awaited<ReturnType<typeof damage>>) => d.change('build.json', b => { b.contracts = contracts; })] as typeof cases[number]),
    ['retained-replacement', /Readback integrity mismatch/, d => d.replaceRetained('domains.srs', Buffer.from('replaced retained bytes'))],
  ];
  for (const [fault, expected, corrupt] of cases) await t.test(fault, async () => {
    const env = await versions();
    const candidate = (await env.journal()).candidates[env.first.results[0].current!.candidateId];
    await corrupt(await damage(env, candidate));
    const before = await stableBytes(env), heads = new Map(env.heads), writes = env.writes.length;
    const status = await getRulesStatus({ context: env.context });
    assert.equal(status.status, 'success', JSON.stringify(status));
    const listed = status.rules!.find(rule => rule.id === candidate.logicalId)!.candidates.find(entry => entry.id === candidate.id)!;
    assert.equal(listed.selectable, false); assert.match(listed.reason!, expected);
    // Representative application rejection, without rerunning native builds
    // for every structural variant already proven at the evidence boundary.
    if (['wrong-rule', 'missing-readback.json', 'source-binding', 'retained-replacement', 'missing-publication-commit'].includes(fault)) {
      const result = await pinRuleVersion({ context: env.context, id: candidate.logicalId, version: candidate.versionId! });
      assert.equal(result.status, 'failed'); assert.match(result.results[0].error!, expected);
    }
    assert.equal(env.writes.length, writes); assert.deepEqual(env.heads, heads);
    assert.deepEqual(await stableBytes(env), before);
  });
});

test('纯追溯异常与辅助 JSON 重排不阻断 status、成功输入复用或重新交付', async () => {
  const env = await versions();
  const current = env.second.results[0].current!;
  const previous = env.first.results[0].current!;
  const journal = await env.journal();
  for (const id of [current.candidateId, previous.candidateId]) {
    const d = await damage(env, journal.candidates[id]);
    d.replace('source.json');
    d.replace('conversion-report.json', Buffer.from('incomplete diagnostic output'));
    await d.change('build.json', b => {
      b.source = { diagnostic: 'stale source display' };
      delete b.artifacts;
      b.tool.path = '/some/other/path';
      b.validation.steps = [];
      b.tools = Object.fromEntries(Object.entries(b.tools).reverse());
    });
    for (const file of ['manifest.json', 'readback.json']) {
      d.replace(file, Buffer.from(JSON.stringify(JSON.parse((await d.read(file)).toString()))));
    }
  }

  const repo = env.context.repository;
  const snapshot = repo.snapshot, download = repo.download;
  const gitReads: string[] = [], raw: string[] = [];
  repo.snapshot = async branch => {
    const observed = await snapshot(branch);
    return { ...observed, async read(path) { gitReads.push(path); return observed.read(path); } };
  };
  repo.download = async url => { raw.push(url); return download(url); };
  const request = { context: env.context, id: current.logicalId };
  const status = await getRulesStatus(request);
  const listed = status.rules?.[0].candidates.find(c => c.id === current.candidateId);
  assert.equal(listed?.selectable, true, JSON.stringify(status));
  assert.deepEqual(listed?.missingTraceFiles, ['source.json']);
  const writes = env.writes.length;
  const sync = await syncRules(request);
  assert.equal(sync.status, 'success', JSON.stringify(sync));
  assert.equal(sync.results.find(row => row.id === current.logicalId)?.status, 'unchanged');
  assert.equal(env.writes.length, writes);
  assert.equal(raw.length, 0);
  const pin = await pinRuleVersion({ ...request, version: previous.versionId! });
  assert.equal(pin.status, 'success', JSON.stringify(pin));
  assert.equal(pin.results[0].current?.candidateId, previous.candidateId);
  const stableHead = await repo.lastChange(env.heads.get(env.context.targetBranch)!, `stable/${current.logicalId}/activation.json`);
  assert.deepEqual(raw.map(url => new URL(url).pathname).sort(), ['domains.json', 'domains.srs'].map(file =>
    `/wangyingang/sing-box-rule-artifacts/${stableHead}/stable/${current.logicalId}/${file}`));
  assert.deepEqual(pin.readbackRequests, raw);
  assert.ok(raw.every(url => !url.includes('/candidates/')));
  assert.deepEqual(gitReads.filter(path => /\/(?:source|conversion-report)\.json$/.test(path)), []);
});

test('status 报告悬空交付，重复 pin 修正已固定版本的交付记录', async () => {
  const env = await versions();
  const current = env.first.results[0].current!;
  const request = { context: env.context, id: current.logicalId };
  const pin = () => pinRuleVersion({ ...request, version: current.versionId! });
  assert.equal((await pin()).status, 'success');
  const path = `stable/${current.logicalId}/activation.json`;
  const snapshot = await env.context.repository.snapshot();
  const bytes = (await snapshot.read(path))!;
  const record = JSON.parse(bytes.toString());
  const tree = env.trees.get(snapshot.head)!;
  tree.set(path, encodeRecord({ ...record, candidateId: '1'.repeat(36) }));
  const status = await getRulesStatus(request);
  const reported = status.rules!.find(rule => rule.id === current.logicalId)!;
  assert.equal(status.status, 'success');
  assert.equal(reported.deliveryState, 'delivered');
  assert.match(reported.deliveryIssue!, /no retained candidate/);
  assert.deepEqual(status.readbackRequests, []);

  tree.set(path, encodeRecord({ ...record, versionId: 'wrong-version' }));
  const repaired = await pin();
  assert.equal(repaired.status, 'success', JSON.stringify(repaired));
  assert.equal(repaired.results[0].current?.versionId, current.versionId);
  assert.equal(repaired.readbackRequests?.length, 2);
  const repeated = await pin();
  assert.equal(repeated.status, 'success', JSON.stringify(repeated));
  assert.deepEqual(repeated.readbackRequests, []);
});

test('摘要随 SRS 篡改更新仍过不了真实原生 pin；域名与 CIDR 当前及兄弟集不变', async t => {
  const { first } = await versions();
  for (const current of first.results.map(result => result.current!)) await t.test(current.logicalId, async () => {
    const env = await versions();
    const candidate = (await env.journal()).candidates[current.candidateId];
    await replaceSrs(env, candidate, candidate.logicalId === 'china-ip' ? 'route' : 'domains');
    const status = await getRulesStatus({ context: env.context });
    assert.equal(status.rules!.find(rule => rule.id === current.logicalId)?.candidates.find(entry => entry.id === candidate.id)?.selectable, true);
    const before = await stableBytes(env), writes = env.writes.length, heads = new Map(env.heads);
    const result = await pinRuleVersion({ context: env.context, id: candidate.logicalId, version: candidate.versionId! });
    assert.equal(result.status, 'failed'); assert.match(result.results[0].error!, /Native artifact mismatch/);
    assert.equal(env.writes.length, writes); assert.deepEqual(env.heads, heads); assert.deepEqual(await stableBytes(env), before);
  });
});

test('cleanup 已验证相同 JSON 后，仍拒绝另一保留候选中摘要自洽的无效 SRS', async () => {
  const env = cleanupEnvironment(binary!);
  const request = { context: env.context };
  assert.equal((await syncRules(request)).status, 'success');
  env.clock('2026-12-20T00:00:00.000Z');
  env.upstream({ openai: 'domain:shared.example', anthropic: 'domain:shared.example' });
  const built = await syncRules(request);
  assert.equal(built.status, 'success', JSON.stringify(built));
  const preview = await cleanupRuleHistory({ ...request, dryRun: true });
  assert.equal(preview.status, 'success', JSON.stringify(preview));
  const candidates = preview.cleanup!.plan!.retain.candidateIds;
  assert.equal(candidates.length, 2);
  assert.equal(preview.cleanup?.plan.discard.candidateIds.length, 2);
  await replaceSrs(env, (await env.journal()).candidates[candidates[1]], 'domains');
  const result = await cleanupRuleHistory(request);
  assert.equal(result.status, 'pending', JSON.stringify(result));
  assert.match(result.error!, /Native artifact mismatch: domains\.srs/);
  assert.equal(env.refWrites.length, 0);
});

test('域名与 CIDR 按版本重选只改变目标；重复 pin 幂等且停止全部上游', async () => {
  const env = await versions();
  const immutable = new Map([...env.trees].map(([head, tree]) => [head, new Map(tree)]));
  for (const old of env.first.results.map(result => result.current!)) {
    const before = await stableBytes(env);
    const pin = await pinRuleVersion({ context: env.context, id: old.logicalId, version: old.versionId! });
    assert.equal(pin.status, 'success', JSON.stringify(pin));
    assert.equal(pin.results[0].current?.candidateId, old.candidateId);
    assert.deepEqual(pin.results[0].current?.source, old.source); assert.equal(pin.results[0].control?.mode, 'pinned');
    const after = await stableBytes(env);
    for (const [path, bytes] of after) {
      if (!path.startsWith(`stable/${old.logicalId}/`)) assert.deepEqual(bytes, before.get(path), path);
      else if (!path.endsWith('/activation.json')) { assert.deepEqual(bytes, env.original.get(path), path); assert.notDeepEqual(bytes, before.get(path), path); }
    }
    const writes = env.writes.length, heads = new Map(env.heads);
    assert.deepEqual((await pinRuleVersion({ context: env.context, id: old.logicalId, version: old.versionId! })).results[0].control, pin.results[0].control);
    assert.equal(env.writes.length, writes); assert.deepEqual(env.heads, heads);
  }
  env.requests.length = 0;
  const fetcher = env.context.fetch!; let reads = 0;
  env.context.fetch = async (...args) => { reads++; return fetcher(...args); };
  const writes = env.writes.length;
  assert.deepEqual((await syncRules({ context: env.context })).results.map(result => result.status), ['pinned-skipped', 'pinned-skipped']);
  assert.equal(reads, 0); assert.equal(env.requests.length, 0); assert.equal(env.writes.length, writes);
  for (const [head, tree] of immutable) assert.deepEqual(env.trees.get(head), tree, 'pin must preserve immutable candidate and historical bytes');
});

test('候选不在保留登记中时，旧不可变地址仍能下载也不能查询或 pin', async () => {
  const env = await versions();
  const old = env.first.results[0].current!, journal = await env.journal();
  const candidate = journal.candidates[old.candidateId];
  delete journal.candidates[old.candidateId];
  env.trees.get(env.heads.get(env.context.repository.branch)!)!.set(RULE_STATE_PATH, encodeRecord(journal));
  assert.ok(await env.context.repository.download(candidate.evidenceUrl!));
  const heads = new Map(env.heads), writes = env.writes.length, before = await stableBytes(env);
  const status = await getRulesStatus({ context: env.context });
  assert.ok(!status.rules!.find(rule => rule.id === 'openai')!.candidates.some(entry => entry.id === old.candidateId));
  const result = await pinRuleVersion({ context: env.context, id: 'openai', version: old.versionId! });
  assert.equal(result.status, 'failed'); assert.match(result.results[0].error!, /missing, incomplete, cleared/);
  assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes); assert.deepEqual(await stableBytes(env), before);
});

test('当前订阅或交付损坏时拒绝 pin；订阅字段顺序不改变契约', async t => {
  const path = 'stable/openai/activation.json';
  for (const fault of ['missing', 'schema', 'identity', 'repository', 'branch', 'path', 'file-set', 'mapping', 'usage', 'capability', 'reuse', 'record', 'bytes', 'binary']) {
    await t.test(fault, async () => {
      const env = await versions('main');
      const old = env.first.results[0].current!;
      const tree = env.trees.get(env.heads.get('main')!)!;
      const record = JSON.parse(tree.get(path)!.toString()), p = record.subscription.projections;
      if (fault === 'missing') delete record.subscription;
      if (fault === 'schema') record.subscription.schemaVersion = 1;
      if (fault === 'identity') record.subscription.systemRuleSetId = 'china-ip';
      if (fault === 'repository') p.route.formats.binary.url = p.route.formats.binary.url.replace('sing-box-rule-artifacts', 'untrusted');
      if (fault === 'branch') p.route.formats.binary.url = p.route.formats.binary.url.replace('/main/', '/other/');
      if (fault === 'path') p.route.formats.binary.url = p.route.formats.binary.url.replace('/stable/', '/stable/../');
      if (fault === 'file-set') delete record.files['stable/openai/domains.srs'];
      if (fault === 'mapping') delete p['dns-query'].formats.source;
      if (fault === 'usage') p['dns-response'] = p.route;
      if (fault === 'capability') p.route.formats.binary.requiredCapabilities.push('processMatching');
      if (fault === 'reuse') p['dns-query'].formats.binary.url = p.route.formats.source.url;
      tree.set(path, fault === 'record' ? Buffer.from('{}') : encodeRecord(record));
      if (fault === 'bytes') tree.set('stable/openai/domains.srs', Buffer.from('corrupt current bytes'));
      const before = await stableBytes(env), writes = env.writes.length, heads = new Map(env.heads);
      const status = await getRulesStatus({ context: env.context });
      if (fault === 'record' || fault === 'bytes') assert.equal(status.status, 'failed');
      else if (fault !== 'binary') assert.equal(status.rules!.find(rule => rule.id === 'openai')!.candidateCount, 0);
      const result = await pinRuleVersion({ context: { ...env.context, ...(fault === 'binary' ? { binary: '/missing/sing-box' } : {}) },
        id: 'openai', version: old.versionId! });
      assert.notEqual(result.status, 'success', JSON.stringify(result));
      assert.equal(env.writes.length, writes); assert.deepEqual(env.heads, heads); assert.deepEqual(await stableBytes(env), before);
    });
  }
  const env = await versions('main');
  const old = env.first.results[0].current!;
  const tree = env.trees.get(env.heads.get('main')!)!;
  const record = JSON.parse(tree.get(path)!.toString());
  for (const usage of ['route', 'dns-query']) {
    const formats = record.subscription.projections[usage].formats;
    record.subscription.projections[usage].formats = { source: formats.source, binary: formats.binary };
  }
  tree.set(path, encodeRecord(record));
  assert.equal((await pinRuleVersion({ context: env.context, id: 'openai', version: old.versionId! })).status, 'success');
});

test('status 报告残缺候选但不补证据、不读上游、不推动恢复', async t => {
  for (const file of ['domains.json', 'manifest.json', 'readback.json']) await t.test(file, async () => {
    const env = await versions();
    env.upstream({ openai: `domain:${file}.example` });
    env.beforeWrite(async files => { if (Object.keys(files).some(path => path.endsWith('/' + file))) throw new Error('injected publication interruption'); });
    const interrupted = await syncRules({ context: env.context });
    assert.notEqual(interrupted.status, 'success'); env.beforeWrite();
    const before = await env.journal(), heads = new Map(env.heads), writes = env.writes.length, reads = env.requests.length;
    const pending = Object.values(before.candidates).filter(candidate => candidate.status !== 'verified');
    assert.equal(pending.length, 1);
    const result = await getRulesStatus({ context: env.context });
    const rule = result.rules!.find(rule => rule.id === 'openai')!;
    assert.equal(rule.current?.candidateId, env.second.results[0].current?.candidateId);
    assert.equal(rule.candidates.find(candidate => candidate.id === pending[0].id)?.selectable, false);
    assert.equal(rule.candidateCount, 2);
    assert.equal(env.requests.length, reads); assert.equal(env.writes.length, writes);
    assert.deepEqual(env.heads, heads); assert.deepEqual(await env.journal(), before);
  });
});

test('当前候选证据丢失或损坏时 status 保留真实交付，候选不可选且不写入', async t => {
  const env = await versions('main');
  const current = env.second.results[0].current!;
  const healthy = (await getRulesStatus({ context: env.context })).rules!.find(rule => rule.id === 'openai')!;
  for (const fault of ['missing', 'corrupt']) await t.test(fault, async () => {
    const env = await versions('main');
    const candidate = (await env.journal()).candidates[current.candidateId];
    const d = await damage(env, candidate);
    d.replace('readback.json', fault === 'missing' ? undefined : Buffer.from('corrupt evidence'));
    const heads = new Map(env.heads), writes = env.writes.length, journal = await env.journal();
    const before = await stableBytes(env), reads = env.requests.length;
    const status = await getRulesStatus({ context: { ...env.context } });
    assert.equal(status.status, 'success', JSON.stringify(status));
    assert.ok(status.rules!.find(rule => rule.id === current.logicalId)?.deliveryIssue);
    const rule = status.rules!.find(rule => rule.id === 'openai')!;
    assert.deepEqual(rule.current, current); assert.equal(rule.deliveryState, 'delivered');
    assert.deepEqual(rule.stableUrls, healthy.stableUrls); assert.deepEqual(rule.control, healthy.control);
    assert.equal(rule.candidates.find(candidate => candidate.id === current.candidateId)?.selectable, false);
    assert.equal(rule.candidateCount, 1);
    assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes); assert.equal(env.requests.length, reads);
    assert.deepEqual(await env.journal(), journal); assert.deepEqual(await stableBytes(env), before);
  });
});

test('合格但从未交付的保留候选可以 pin，其他规则的版本不能冒用', async () => {
  const env = await versions('main');
  env.upstream({ openai: 'domain:retained-unselected.example' });
  const repo = env.context.repository, snapshot = repo.snapshot;
  let unavailable = false;
  env.beforeWrite(async files => { if (Object.keys(files).some(path => path.endsWith('/readback.json'))) unavailable = true; });
  repo.snapshot = async branch => {
    if (unavailable && branch === 'main') throw new Error('delivery preparation unavailable');
    return snapshot(branch);
  };
  assert.notEqual((await syncRules({ context: env.context })).status, 'success');
  repo.snapshot = snapshot; env.beforeWrite();
  const candidates = Object.values((await env.journal()).candidates);
  const candidate = candidates.find(candidate => candidate.logicalId === 'openai' && ![env.first.results[0].current!.candidateId, env.second.results[0].current!.candidateId].includes(candidate.id))!;
  assert.equal(candidate.status, 'verified'); assert.ok(candidate.versionId);
  const status = await getRulesStatus({ context: env.context });
  assert.equal(status.rules!.find(rule => rule.id === 'openai')!.candidates.find(entry => entry.id === candidate.id)?.selectable, true);
  assert.ok(!env.writes.some(write => write.branch === 'main' && Object.values(write.files).some(bytes => bytes?.includes(Buffer.from(candidate.id)))));
  const heads = new Map(env.heads), writes = env.writes.length;
  assert.equal((await pinRuleVersion({ context: env.context, id: 'china-ip', version: candidate.versionId! })).status, 'failed');
  assert.equal(env.writes.length, writes); assert.deepEqual(env.heads, heads);
  const before = await stableBytes(env);
  const selected = await pinRuleVersion({ context: env.context, id: 'openai', version: candidate.versionId! });
  assert.equal(selected.status, 'success', JSON.stringify(selected));
  assert.equal(selected.results[0].current?.candidateId, candidate.id);
  for (const [path, bytes] of before) if (path.startsWith('stable/china-ip/')) assert.deepEqual((await stableBytes(env)).get(path), bytes);
});

for (const target of ['acceptance-selection', 'main']) {
  test(`${target}: 不同规则的 pin 竞争同一 head，失败方不覆盖成功方`, async () => {
    const env = await versions(target);
    const before = await stableBytes(env), writes = env.writes.length;
    let arrivals = 0, release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    env.beforeWrite(async files => {
      const pending = files[RULE_STATE_PATH] && parseRulesJournal(files[RULE_STATE_PATH]!).pendingDelivery;
      if (pending?.kind !== 'pin' || Object.keys(files).some(path => path.startsWith('stable/'))) return;
      if (++arrivals === 2) { env.beforeWrite(); release(); }
      await ready;
    });
    const results = await Promise.all(env.first.results.map(result => pinRuleVersion({ context: { ...env.context },
      id: result.id, version: result.current!.versionId! })));
    assert.equal(arrivals, 2); assert.equal(results.filter(result => result.status === 'success').length, 1);
    const winner = results.findIndex(result => result.status === 'success');
    const winning = env.first.results[winner], losing = env.second.results[1 - winner];
    const status = await getRulesStatus({ context: env.context });
    assert.equal(status.rules!.find(rule => rule.id === winning.id)?.current?.candidateId, winning.current!.candidateId);
    assert.equal(status.rules!.find(rule => rule.id === winning.id)?.control?.mode, 'pinned');
    assert.equal(status.rules!.find(rule => rule.id === losing.id)?.current?.candidateId, losing.current!.candidateId);
    assert.equal(status.rules!.find(rule => rule.id === losing.id)?.control?.mode, 'auto');
    assert.equal((await env.journal()).pendingDelivery, undefined);
    assert.equal(env.writes.length - writes, 3, 'only the winning registration, stable delivery and completion may commit');
    const after = await stableBytes(env);
    for (const [path, bytes] of before) if (path.startsWith(`stable/${losing.id}/`)) assert.deepEqual(after.get(path), bytes, path);
  });

  test(`${target}: pin 响应丢失先核实远端，查询不恢复且重试不重复交付`, async t => {
    for (const mode of ['registration', 'applied', 'not-applied', 'unknown', 'readback']) await t.test(mode, async () => {
      const env = await versions(target);
      const repo = env.context.repository, commit = repo.commit, snapshot = repo.snapshot, download = repo.download;
      const old = env.first.results[0].current!;
      let injected = false, offline = false;
      const before = await stableBytes(env), originalTotal = env.writes.length;
      const stableWrites = () => env.writes.filter(write => Object.keys(write.files).some(path => path.startsWith('stable/'))).length;
      const originalWrites = stableWrites();
      repo.snapshot = async branch => {
        if (offline) throw new Error('connection lost while confirming pin');
        return snapshot(branch);
      };
      repo.download = async url => {
        if (mode === 'readback' && injected && url.includes('/stable/')) throw new Error('HTTPS unavailable');
        return download(url);
      };
      repo.commit = async (...args) => {
        const files = args[2], stable = Object.keys(files).some(path => path.startsWith('stable/'));
        const registering = !stable && files[RULE_STATE_PATH] && parseRulesJournal(files[RULE_STATE_PATH]!).pendingDelivery?.kind === 'pin';
        if (injected || !(mode === 'registration' ? registering : stable)) return commit(...args);
        injected = true;
        if (mode === 'not-applied') throw new PublicationWriteError('f'.repeat(40), new Error('response lost before ref update'));
        const head = await commit(...args);
        if (mode === 'unknown') offline = true;
        if (mode !== 'readback') throw new PublicationWriteError(head, new Error('pin response lost'));
        return head;
      };
      try {
        const result = await pinRuleVersion({ context: env.context, id: 'openai', version: old.versionId! });
        assert.ok(injected);
        assert.equal(result.status, ['registration', 'applied'].includes(mode) ? 'success' : 'pending', JSON.stringify(result));
        offline = false;
        const heads = new Map(env.heads), writes = env.writes.length, journal = await env.journal();
        const status = await getRulesStatus({ context: { ...env.context } });
        const observed = status.rules!.find(rule => rule.id === 'openai')!;
        assert.equal(observed.current?.candidateId, mode === 'not-applied' ? env.second.results[0].current!.candidateId : old.candidateId);
        assert.equal(Boolean(observed.pendingOperation), !['registration', 'applied'].includes(mode));
        assert.deepEqual(await env.journal(), journal); assert.deepEqual(env.heads, heads); assert.equal(env.writes.length, writes);
        if (mode === 'not-applied') assert.deepEqual(await stableBytes(env), before);
        assert.equal(stableWrites() - originalWrites, mode === 'not-applied' ? 0 : 1);
        repo.snapshot = snapshot; repo.download = download; repo.commit = commit;
        const recovered = await pinRuleVersion({ context: { ...env.context }, id: 'openai', version: old.versionId! });
        assert.equal(recovered.status, 'success', JSON.stringify(recovered));
        assert.equal(recovered.results[0].current?.candidateId, old.candidateId);
        assert.equal(stableWrites() - originalWrites, 1);
        assert.equal(env.writes.length - originalTotal, 3, 'lost responses must not duplicate registration, stable delivery or completion');
        assert.equal((await env.journal()).pendingDelivery, undefined);
        for (const [path, bytes] of before) if (path.startsWith('stable/china-ip/')) assert.deepEqual((await stableBytes(env)).get(path), bytes, path);
      } finally { repo.snapshot = snapshot; repo.download = download; repo.commit = commit; }
    });
  });

  test(`${target}: 较新的 pin 取代响应未知的旧 pin，迟到会话不能覆盖`, async () => {
    const env = await versions(target);
    const repo = env.context.repository, commit = repo.commit;
    const old = env.first.results[0].current!, latest = env.second.results[0].current!;
    let injected = false, newer: Awaited<ReturnType<typeof pinRuleVersion>> | undefined;
    let newerHeads: Map<string, string> | undefined, newerBytes: Awaited<ReturnType<typeof stableBytes>> | undefined;
    repo.commit = async (...args) => {
      const head = await commit(...args);
      if (!injected && Object.keys(args[2]).some(path => path.startsWith('stable/openai/'))) {
        injected = true;
        newer = await pinRuleVersion({ context: { ...env.context }, id: 'openai', version: latest.versionId! });
        assert.equal(newer.status, 'success', JSON.stringify(newer));
        newerHeads = new Map(env.heads); newerBytes = await stableBytes(env);
        throw new PublicationWriteError(head, new Error('old response lost after a newer decision'));
      }
      return head;
    };
    const stale = await pinRuleVersion({ context: env.context, id: 'openai', version: old.versionId! });
    assert.ok(injected); assert.notEqual(stale.status, 'success');
    assert.deepEqual(env.heads, newerHeads); assert.deepEqual(await stableBytes(env), newerBytes);
    const status = await getRulesStatus({ context: env.context });
    const observed = status.rules!.find(rule => rule.id === 'openai')!;
    assert.equal(status.status, 'success'); assert.equal(observed.current?.candidateId, latest.candidateId);
    assert.deepEqual(observed.control, newer!.results[0].control); assert.equal(observed.pendingOperation, undefined);
    assert.equal((await env.journal()).pendingDelivery, undefined);
    const writes = env.writes.length;
    assert.equal((await syncRules({ context: { ...env.context } })).results.find(rule => rule.id === 'openai')?.status, 'pinned-skipped');
    assert.equal(env.writes.length, writes); assert.deepEqual(await stableBytes(env), newerBytes);
  });

  test(`${target}: pin 写入前配置、维护、代次或 head 变化不会被旧会话覆盖`, async t => {
    for (const race of ['configuration', 'maintenance', 'generation', 'head']) await t.test(race, async () => {
      const env = await versions(target);
      const old = env.first.results[0].current!;
      const before = await stableBytes(env); let raced = false, heads: Map<string, string> | undefined;
      env.beforeWrite(async files => {
        if (!Object.keys(files).some(path => path.startsWith('stable/'))) return;
        env.beforeWrite(); raced = true;
        if (race === 'configuration') env.configure(env.config());
        else {
          const journal = await env.journal();
          if (race === 'maintenance') journal.maintenance = 'maintenance';
          if (race === 'generation') journal.generation++;
          const snapshot = await env.context.repository.snapshot();
          await env.context.repository.commit(env.context.repository.branch, snapshot.head,
            race === 'head' ? { 'pipeline/rival.json': Buffer.from('{}') } : { [RULE_STATE_PATH]: encodeRecord(journal) },
            '模拟并发权威变更', async () => {});
        }
        heads = new Map(env.heads);
      });
      const result = await pinRuleVersion({ context: env.context, id: 'openai', version: old.versionId! });
      assert.ok(raced); assert.notEqual(result.status, 'success'); assert.deepEqual(env.heads, heads);
      assert.deepEqual(await stableBytes(env), before);
    });
  });
}
