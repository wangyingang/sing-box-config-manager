import { readFile } from 'node:fs/promises';
import { parseBuildConfiguration } from '../src/configuration.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readRemoteStatus } from '../src/remote-status.js';
import { manageMaintenance } from '../src/maintenance.js';
import type { PublicationRepository } from '../src/publication-repository.js';
import type { PublicationTransport } from '../src/publication.js';
import { immutableUrl } from '../src/publication.js';
import { sha256 } from '../src/release.js';
import type { RemoteJournal } from '../src/remote-state.js';

const official = parseBuildConfiguration(await readFile(new URL('../config/rulesets.yml', import.meta.url), 'utf8'));
const [openai] = official.ruleSets;
const head = 'a'.repeat(40);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

function subscription() {
  const endpoint = (file: string) => ({ url: `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/main/stable/openai/${file}`, requiredCapabilities: [] as string[] });
  const formats: Record<string, ReturnType<typeof endpoint>> = { binary: endpoint('domains.srs') };
  formats.source = endpoint('domains.json');
  return { schemaVersion: 2,
    systemRuleSetId: 'openai', targetVersion: '1.14.4', sourceFormatVersion: 4,
    projections: { route: { formats }, 'dns-query': { formats: structuredClone(formats) }, 'dns-response': { unavailable: 'empty' } } };
}

function binaryOnly(record: { subscription: ReturnType<typeof subscription>; files: Record<string, unknown> }) {
  delete record.subscription.projections.route.formats.source;
  delete record.subscription.projections['dns-query'].formats.source;
  for (const path of Object.keys(record.files)) if (path.endsWith('/domains.json')) delete record.files[path];
}

function remote() {
  const journal: RemoteJournal = { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', generation: 1,
    maintenance: 'open', targetBranch: 'main',
    state: { schemaVersion: 1, pinned: {}, processed: {}, configuredProcessed: {}, candidates: {} } };
  const files = new Map<string, Buffer>([
    ['pipeline/state.json', encode(journal)],
    ['pipeline/identity.json', encode({ schemaVersion: 1, id: journal.id, targetBranch: journal.targetBranch })],
  ]);
  const stable = new Map<string, Buffer>();
  const repository: PublicationRepository = { branch: 'candidates',
    async snapshot(branch) {
      const tree = branch === journal.targetBranch ? stable : files;
      return { head, paths: [...tree.keys()], async read(path) { return tree.get(path); } };
    },
    async commit() { throw new Error('status must never write'); },
  };
  const history = new Map<string, Buffer>();
  const publication: PublicationTransport = { repository,
    async commit() { throw new Error('status must never write'); },
    async download(url) {
      const bytes = history.get(url);
      if (!bytes) throw new Error('Readback HTTP 404');
      return bytes;
    },
  };
  return { journal, files, stable, repository, history, publication,
    saveJournal() { files.set('pipeline/state.json', encode(journal)); } };
}

function addCandidate(env: ReturnType<typeof remote>, id: string, configured = true) {
  const prefix = `candidates/${id}`;
  const filesCommit = 'b'.repeat(40), metadataCommit = 'c'.repeat(40), evidenceCommit = 'd'.repeat(40);
  const source = { repository: 'v2fly/domain-list-community', releaseId: 42, tag: '20261104112839' };
  const sourceBytes = encode({ version: 4, rules: [{ domain_suffix: [`${id}.example`] }] });
  const binaryBytes = Buffer.from(`fixture-srs-${id}`);
  const artifacts = [['domains.json', 'source', sourceBytes], ['domains.srs', 'binary', binaryBytes]].map(([file, format, bytes]) => ({
    id: `openai@${id}:${file}`, format, url: immutableUrl(filesCommit, `${prefix}/${file}`),
    sha256: sha256(bytes as Buffer), byteLength: (bytes as Buffer).length, termCount: 1, requiredCapabilities: [],
  }));
  const contents: Record<string, Buffer> = {
    'domains.json': sourceBytes, 'domains.srs': binaryBytes,
    'source.json': encode(source), 'conversion-report.json': encode({ status: 'converted' }),
    'build.json': encode({ candidateId: id, source, buildId: 'e'.repeat(64), ...(configured ? { id: 'openai',
      definition: openai,
      target: { repository: 'wangyingang/sing-box-rule-artifacts', branch: 'main' } } : {}) }),
    'manifest.json': encode({ schemaVersion: 1, id: configured ? 'openai' : 'v2fly:category-ai-!cn', revision: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
      artifacts, projections: { route: { artifactIds: artifacts.map(a => a.id) },
        'dns-query': { artifactIds: artifacts.map(a => a.id) }, 'dns-response': { unavailable: 'empty' } } }),
  };
  contents['readback.json'] = encode({ schemaVersion: 1, candidateId: id, status: 'remote-verified',
    filesCommit, metadataCommit, buildId: 'e'.repeat(64),
    readback: Object.entries(contents).map(([file, bytes]) => ({ url: immutableUrl(file.startsWith('domains.') ? filesCommit : metadataCommit, `${prefix}/${file}`),
      sha256: sha256(bytes), byteLength: bytes.length, exactBytes: true })) });
  for (const [file, bytes] of Object.entries(contents)) {
    env.files.set(`${prefix}/${file}`, bytes);
    const commit = file === 'readback.json' ? evidenceCommit : file.startsWith('domains.') ? filesCommit : metadataCommit;
    env.history.set(immutableUrl(commit, `${prefix}/${file}`), bytes);
  }
  const activation = { schemaVersion: 1, id: `activation-${id}`, logicalId: 'openai', candidateId: id,
    subscription: subscription(),
    candidateEvidenceUrl: immutableUrl(evidenceCommit, `${prefix}/readback.json`), history: [] as { commit: string; id: string; candidateId: string }[],
    files: { 'stable/openai/domains.json': { sha256: sha256(sourceBytes), byteLength: sourceBytes.length },
      'stable/openai/domains.srs': { sha256: sha256(binaryBytes), byteLength: binaryBytes.length } } };
  return { contents, activation };
}

function activate(env: ReturnType<typeof remote>, candidate: ReturnType<typeof addCandidate>) {
  env.stable.set('stable/openai/activation.json', encode(candidate.activation));
  for (const file of ['domains.json', 'domains.srs']) env.stable.set(`stable/openai/${file}`, candidate.contents[file]);
}

function register(env: ReturnType<typeof remote>, id: string, phase: 'registered' | 'files' | 'metadata' | 'evidence' | 'complete' = 'complete') {
  env.journal.state.pinned['42'] = { identity: { repository: 'v2fly/domain-list-community', releaseId: 42,
    tag: '20261104112839', commit: '9'.repeat(40),
    yaml: { id: 11, name: 'dlc.dat_plain.yml', url: 'https://github.com/v2fly/domain-list-community/releases/download/20261104112839/dlc.dat_plain.yml' },
    checksum: { id: 12, name: 'dlc.dat_plain.yml.sha256sum', url: 'https://github.com/v2fly/domain-list-community/releases/download/20261104112839/dlc.dat_plain.yml.sha256sum' } } };
  env.journal.state.candidates[id] = { id, releaseId: 42, tag: '20261104112839', status: phase === 'complete' ? 'verified' : 'publishing',
    phase, logicalId: 'openai', generation: 1, retained: true, targetBranch: 'main',
    definition: openai, operationId: 'ee', operation: 'update',
    buildId: 'e'.repeat(64), filesCommit: 'b'.repeat(40), metadataCommit: 'c'.repeat(40), evidenceCommit: 'd'.repeat(40),
    evidenceUrl: immutableUrl('d'.repeat(40), `candidates/${id}/readback.json`) };
  env.journal.state.pendingOperation ??= { id: 'ee', kind: 'update', generation: 1, releaseId: 42, tag: '20261104112839',
    status: phase === 'complete' ? 'complete' : 'pending', expectedHead: head, candidateIds: [],
    configuration: JSON.stringify({ ...official,
      target: { repository: 'wangyingang/sing-box-rule-artifacts', branch: 'main' },
      ruleSets: [openai] }) };
  env.journal.state.pendingOperation.candidateIds.push(id);
  env.saveJournal();
}

test('仅提供 SRS 的 v2 订阅可查询当前版本及有效回滚目标', async () => {
  const env = remote(), old = addCandidate(env, 'a1'), current = addCandidate(env, 'b2');
  binaryOnly(old.activation); binaryOnly(current.activation);
  const oldCommit = 'f'.repeat(40), stablePath = 'stable/openai';
  const recordPath = `${stablePath}/activation.json`;
  current.activation.history.push({ commit: oldCommit, id: old.activation.id, candidateId: 'a1' });
  env.stable.set(recordPath, encode(current.activation));
  env.stable.set(`${stablePath}/domains.srs`, current.contents['domains.srs']);
  env.history.set(immutableUrl(oldCommit, recordPath), encode(old.activation));
  env.history.set(immutableUrl(oldCommit, `${stablePath}/domains.srs`), old.contents['domains.srs']);
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.equal(result.activeRuleVersions.openai.activation.candidateId, 'b2');
  assert.deepEqual(result.rollbackTargets.openai.map(target => target.candidateId), ['a1']);
  assert.equal(result.historyComplete.openai, true);
  assert.deepEqual(result.historyErrors.openai, []);
  assert.deepEqual(result.pendingOperations, []);
});

for (const fault of ['missing', 'schema', 'identity', 'repository', 'branch', 'path', 'file-set', 'mapping']) {
  test(`v2 状态拒绝 ${fault} 订阅或文件记录`, async () => {
    const env = remote(), current = addCandidate(env, 'a1');
    const record: Record<string, any> = current.activation;
    const projection = record.subscription.projections;
    if (fault === 'missing') delete record.subscription;
    if (fault === 'schema') record.subscription.schemaVersion = 1;
    if (fault === 'identity') record.subscription.systemRuleSetId = 'another-rule-set';
    if (fault === 'repository') projection.route.formats.binary.url = projection.route.formats.binary.url.replace('sing-box-rule-artifacts', 'untrusted-artifacts');
    if (fault === 'branch') projection.route.formats.binary.url = projection.route.formats.binary.url.replace('/main/', '/other/');
    if (fault === 'path') projection.route.formats.binary.url = projection.route.formats.binary.url.replace('/stable/', '/stable/../');
    if (fault === 'file-set') delete record.files['stable/openai/domains.srs'];
    if (fault === 'mapping') delete projection['dns-query'].formats.source;
    env.stable.set('stable/openai/activation.json', encode(record));
    await assert.rejects(readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication }),
      /subscription|Subscription|activation file set/);
  });
}

test('已废止的 v1 记录不参与状态和回滚，维护不会重写或清除旧交付', async () => {
  const env = remote();
  activate(env, addCandidate(env, 'a1'));
  const retired = 'stable/activation.json', rule = 'stable/domains.srs';
  env.stable.set(retired, encode({ subscription: { schemaVersion: 1 } }));
  env.stable.set(rule, Buffer.from('historical stable bytes'));
  const original = new Map(env.stable);
  const options = { repository: env.repository, publication: env.publication, activation: env.publication };
  const status = await readRemoteStatus(options);
  assert.equal(status.activeRuleVersions.openai.activation.candidateId, 'a1');
  assert.deepEqual(Object.keys(status.rollbackTargets), ['openai']);
  assert.ok(status.pendingOperations.some(item => item.id === retired && item.status === 'retired-subscription'));
  const result = await manageMaintenance({ ...options, action: 'enter', manual: true, refs: async () => [] });
  assert.equal(result.status, 'deferred');
  assert.ok('blockers' in result && result.blockers.some(item => item.id === retired && item.status === 'retired-subscription'));
  assert.deepEqual(env.stable, original);
});

test('历史订阅缺失时保留当前交付但不返回该回滚目标', async () => {
  const env = remote(), old = addCandidate(env, 'a1'), current = addCandidate(env, 'b2');
  const oldCommit = 'f'.repeat(40);
  current.activation.history.push({ commit: oldCommit, id: old.activation.id, candidateId: 'a1' }); activate(env, current);
  const broken: Record<string, unknown> = { ...old.activation }; delete broken.subscription;
  env.history.set(immutableUrl(oldCommit, 'stable/openai/activation.json'), encode(broken));
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.equal(result.activeRuleVersions['openai'].activation.candidateId, 'b2');
  assert.deepEqual(result.rollbackTargets['openai'], []);
  assert.equal(result.historyComplete['openai'], false);
  assert.match(result.unavailableRollbackTargets['openai'][0].reason, /Rule Subscription/);
});

test('全新目录查询远端空状态，不创建发布或伪造当前版本', async () => {
  const env = remote();
  const result = await readRemoteStatus({ repository: env.repository });
  assert.equal(result.authority, 'remote');
  assert.equal(result.head, head);
  assert.equal(result.generation, 1);
  assert.deepEqual(result.activeRuleVersions, {});
  assert.deepEqual(result.rollbackTargets, {});
  assert.deepEqual(result.pendingOperations, []);
});

test('已提交的当前规则不因候选回读故障变成未激活，并单独报告待核实操作', async () => {
  const env = remote(), current = addCandidate(env, 'a1'); activate(env, current);
  env.history.delete(current.activation.candidateEvidenceUrl);
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.equal(result.activeRuleVersions['openai'].activation.candidateId, 'a1');
  assert.equal(result.candidateAvailability.a1.status, 'verification-pending');
  assert.ok(result.pendingOperations.some(operation => operation.candidateId === 'a1'));
});

test('status 从当前稳定记录与仍保留的历史证据报告可回滚版本，不依赖本地回执', async () => {
  const env = remote(), old = addCandidate(env, 'a1'), current = addCandidate(env, 'b2');
  const oldCommit = 'f'.repeat(40);
  current.activation.history.push({ commit: oldCommit, id: old.activation.id, candidateId: 'a1' });
  env.stable.set('stable/openai/activation.json', encode(current.activation));
  for (const file of ['domains.json', 'domains.srs']) {
    env.stable.set(`stable/openai/${file}`, current.contents[file]);
    env.history.set(immutableUrl(oldCommit, `stable/openai/${file}`), old.contents[file]);
  }
  env.history.set(immutableUrl(oldCommit, 'stable/openai/activation.json'), encode(old.activation));
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.equal(result.activeRuleVersions['openai'].activation.candidateId, 'b2');
  assert.equal(result.activeRuleVersions['openai'].commit, head);
  assert.deepEqual(result.rollbackTargets['openai'].map(target => target.candidateId), ['a1']);
  assert.equal(result.rollbackTargets['openai'][0].verification, 'structural');
  assert.equal(result.candidateAvailability['b2'].verification, 'structural');
});

test('历史订阅契约不兼容时不列为有效回滚目标', async () => {
  const env = remote(), old = addCandidate(env, 'a1'), current = addCandidate(env, 'b2');
  const oldCommit = 'f'.repeat(40);
  binaryOnly(current.activation);
  current.activation.history.push({ commit: oldCommit, id: old.activation.id, candidateId: 'a1' }); activate(env, current);
  env.history.set(immutableUrl(oldCommit, 'stable/openai/activation.json'), encode(old.activation));
  for (const file of ['domains.json', 'domains.srs']) env.history.set(immutableUrl(oldCommit, `stable/openai/${file}`), old.contents[file]);
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.deepEqual(result.rollbackTargets['openai'], []);
  assert.match(result.unavailableRollbackTargets['openai'][0].reason, /subscription/i);
});

test('各候选发布阶段的残缺文件与已提交待核实结果分别报告', async () => {
  const env = remote();
  for (const [id, phase, keep] of [['a1', 'registered', 0], ['b2', 'files', 2], ['c3', 'metadata', 6], ['d4', 'evidence', 7]] as const) {
    addCandidate(env, id); register(env, id, phase);
    const files = ['domains.json', 'domains.srs', 'manifest.json', 'source.json', 'conversion-report.json', 'build.json', 'readback.json'];
    for (const file of files.slice(keep)) env.files.delete(`candidates/${id}/${file}`);
  }
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.deepEqual(['a1', 'b2', 'c3'].map(id => result.candidateAvailability[id].status), ['incomplete', 'incomplete', 'incomplete']);
  assert.deepEqual(['a1', 'b2', 'c3'].map(id => result.candidateAvailability[id].missingFiles!.length), [7, 5, 1]);
  assert.equal(result.candidateAvailability.d4.status, 'available');
  assert.equal(result.pendingOperations.find(operation => operation.id === 'd4')?.status, 'verification-pending');
  assert.equal(result.pendingOperations.length, 5);
});

test('候选已从远端保留集合移除时，即使旧对象仍可下载也不列为有效回滚目标', async () => {
  const env = remote(), old = addCandidate(env, 'a1'), current = addCandidate(env, 'b2');
  register(env, 'a1');
  env.journal.state.candidates.a1.retained = false; env.saveJournal();
  const oldCommit = 'f'.repeat(40);
  current.activation.history.push({ commit: oldCommit, id: old.activation.id, candidateId: 'a1' }); activate(env, current);
  env.history.set(immutableUrl(oldCommit, 'stable/openai/activation.json'), encode(old.activation));
  for (const file of ['domains.json', 'domains.srs']) env.history.set(immutableUrl(oldCommit, `stable/openai/${file}`), old.contents[file]);
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.deepEqual(result.rollbackTargets['openai'], []);
  assert.equal(result.candidateAvailability.a1.status, 'unavailable');
  assert.equal(result.candidateAvailability.a1.evidenceUrl, undefined);
  assert.match(result.unavailableRollbackTargets['openai'][0].reason, /no longer retained/);
});

test('当前稳定字节损坏与非法历史记录不能被当作正常状态', async () => {
  for (const corrupt of ['bytes', 'history'] as const) {
    const env = remote(), current = addCandidate(env, 'a1'); activate(env, current);
    if (corrupt === 'bytes') env.stable.set('stable/openai/domains.srs', Buffer.from('corrupted'));
    else { current.activation.history.push({ commit: 'short', id: 'old', candidateId: 'b2' }); activate(env, current); }
    await assert.rejects(readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication }),
      corrupt === 'bytes' ? /Stable file integrity/ : /Invalid activation history/);
  }
});

test('远端候选证据摘要损坏时不声称候选可用', async () => {
  const env = remote(); addCandidate(env, 'a1'); register(env, 'a1');
  env.files.set('candidates/a1/domains.srs', Buffer.from('corrupted'));
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.equal(result.candidateAvailability.a1.status, 'verification-pending');
  assert.match(result.candidateAvailability.a1.error!, /evidence mismatch/);
  assert.equal(result.pendingOperations[0].candidateId, 'a1');
});

test('维护预览保留当前规则证据，不按年龄排除固定版本', async () => {
  const env = remote(), configured = addCandidate(env, 'aa');
  const completedUnactivated = addCandidate(env, 'cc');
  configured.activation.history.push({ commit: 'e'.repeat(40), id: 'recent-activation', candidateId: 'cc' });
  Object.assign(configured.activation, { control: {
    revision: configured.activation.id, reason: 'manual-activation', pauseAutomaticActivation: true, pauseAutomaticRetry: false,
  } });
  activate(env, configured);
  env.journal.state.latestChecks = {
    'openai': { operationId: 'ae879b98-1814-4a6e-8ce6-e1f95df2e304', status: 'unchanged', checkedAt: '2026-11-07T01:00:00Z' },
  };
  env.saveJournal();
  const evidencePath = `candidates/${completedUnactivated.activation.candidateId}/readback.json`;
  const repository = { ...env.repository, async lastChange(_head: string, path: string) {
    assert.equal(path, evidencePath);
    return completedUnactivated.activation.candidateEvidenceUrl.split('/')[5];
  } };
  const inspect = () => manageMaintenance({ ...env, repository, action: 'preview', manual: true,
    refs: async () => [], activation: env.publication });
  const preview = await inspect();
  assert.equal(preview.status, 'ready');
  assert.ok('plan' in preview);
  assert.deepEqual(preview.plan.retain.active.map(entry => entry.record.candidateId).sort(), ['aa']);
  assert.deepEqual(preview.plan.retain.active.find(entry => entry.record.candidateId === 'aa')!.record.control,
    Reflect.get(configured.activation, 'control'));
  assert.deepEqual(Object.keys(preview.plan.retain.progress.latestChecks), ['openai']);
  assert.deepEqual(preview.plan.discard.candidateIds, [completedUnactivated.activation.candidateId]);
  assert.deepEqual(preview.plan.discard.activations['stable/openai/activation.json'], configured.activation.history);

  env.history.delete(completedUnactivated.activation.candidateEvidenceUrl);
  const deferred = await inspect();
  assert.equal(deferred.status, 'deferred');
  assert.ok('plan' in deferred);
  assert.deepEqual(deferred.plan.discard.candidateIds, []);
  assert.ok(deferred.blockers.some(blocker => blocker.candidateId === 'cc' && blocker.status === 'candidate-completion-unverified'));
});
