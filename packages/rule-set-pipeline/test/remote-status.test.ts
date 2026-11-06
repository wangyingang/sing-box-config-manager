import assert from 'node:assert/strict';
import test from 'node:test';
import { readRemoteStatus } from '../src/remote-status.js';
import type { PublicationRepository } from '../src/publication-repository.js';
import type { PublicationTransport } from '../src/publication.js';
import { immutableUrl } from '../src/publication.js';
import { sha256 } from '../src/release.js';
import type { RemoteJournal } from '../src/remote-state.js';

const head = 'a'.repeat(40);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

function subscription(configured = true, source = true, path = configured ? 'stable/ai-openai' : 'stable') {
  const endpoint = (file: string) => ({ url: `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/main/${path}/${file}`, requiredCapabilities: [] as string[] });
  const formats: Record<string, ReturnType<typeof endpoint>> = { binary: endpoint('domains.srs') };
  if (source) formats.source = endpoint('domains.json');
  return { schemaVersion: configured ? 2 : 1,
    systemRuleSetId: configured ? 'ai-openai' : 'v2fly:domain-list-community:category-ai-!cn', targetVersion: '1.14.4', sourceFormatVersion: 4,
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
    id: `ai-openai@${id}:${file}`, format, url: immutableUrl(filesCommit, `${prefix}/${file}`),
    sha256: sha256(bytes as Buffer), byteLength: (bytes as Buffer).length, termCount: 1, requiredCapabilities: [],
  }));
  const contents: Record<string, Buffer> = {
    'domains.json': sourceBytes, 'domains.srs': binaryBytes,
    'source.json': encode(source), 'conversion-report.json': encode({ status: 'converted' }),
    'build.json': encode({ candidateId: id, source, buildId: 'e'.repeat(64), ...(configured ? { id: 'ai-openai',
      definition: { id: 'ai-openai', list: 'openai', stablePath: 'stable/ai-openai' },
      target: { repository: 'wangyingang/sing-box-rule-artifacts', branch: 'main' } } : {}) }),
    'manifest.json': encode({ schemaVersion: 1, id: configured ? 'ai-openai' : 'v2fly:category-ai-!cn', revision: id, targetVersion: '1.14.4', sourceFormatVersion: 4,
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
  const activation = { schemaVersion: 1, id: `activation-${id}`, logicalId: 'ai-openai', candidateId: id,
    subscription: subscription(),
    candidateEvidenceUrl: immutableUrl(evidenceCommit, `${prefix}/readback.json`), history: [] as { commit: string; id: string; candidateId: string }[],
    files: { 'stable/ai-openai/domains.json': { sha256: sha256(sourceBytes), byteLength: sourceBytes.length },
      'stable/ai-openai/domains.srs': { sha256: sha256(binaryBytes), byteLength: binaryBytes.length } } };
  return { contents, activation };
}

function activate(env: ReturnType<typeof remote>, candidate: ReturnType<typeof addCandidate>) {
  env.stable.set('stable/ai-openai/activation.json', encode(candidate.activation));
  for (const file of ['domains.json', 'domains.srs']) env.stable.set(`stable/ai-openai/${file}`, candidate.contents[file]);
}

function register(env: ReturnType<typeof remote>, id: string, phase: 'registered' | 'files' | 'metadata' | 'evidence' | 'complete' = 'complete') {
  env.journal.state.pinned['42'] = { identity: { repository: 'v2fly/domain-list-community', releaseId: 42,
    tag: '20261104112839', commit: '9'.repeat(40),
    yaml: { id: 11, name: 'dlc.dat_plain.yml', url: 'https://github.com/v2fly/domain-list-community/releases/download/20261104112839/dlc.dat_plain.yml' },
    checksum: { id: 12, name: 'dlc.dat_plain.yml.sha256sum', url: 'https://github.com/v2fly/domain-list-community/releases/download/20261104112839/dlc.dat_plain.yml.sha256sum' } } };
  env.journal.state.candidates[id] = { id, releaseId: 42, tag: '20261104112839', status: phase === 'complete' ? 'verified' : 'publishing',
    phase, logicalId: 'ai-openai', generation: 1, retained: true, targetBranch: 'main',
    definition: { id: 'ai-openai', list: 'openai', stablePath: 'stable/ai-openai' }, operationId: 'ee', operation: 'update',
    buildId: 'e'.repeat(64), filesCommit: 'b'.repeat(40), metadataCommit: 'c'.repeat(40), evidenceCommit: 'd'.repeat(40),
    evidenceUrl: immutableUrl('d'.repeat(40), `candidates/${id}/readback.json`) };
  env.journal.state.pendingOperation ??= { id: 'ee', kind: 'update', generation: 1, releaseId: 42, tag: '20261104112839',
    status: phase === 'complete' ? 'complete' : 'pending', expectedHead: head, candidateIds: [],
    configuration: JSON.stringify({ schemaVersion: 1, source: 'v2fly/domain-list-community',
      target: { repository: 'wangyingang/sing-box-rule-artifacts', branch: 'main' },
      ruleSets: [{ id: 'ai-openai', list: 'openai', stablePath: 'stable/ai-openai' }] }) };
  env.journal.state.pendingOperation.candidateIds.push(id);
  env.saveJournal();
}

function legacyActivation(candidate: ReturnType<typeof addCandidate>, expectedHead: string, stablePath = 'stable') {
  const { logicalId: _logicalId, history: _history, files, ...record } = candidate.activation;
  return { ...record, subscription: subscription(false, !!record.subscription.projections.route.formats.source, stablePath),
    expectedHead, files: Object.fromEntries(Object.entries(files).map(([path, metadata]) =>
      [path.replace('stable/ai-openai/', `${stablePath}/`), metadata])) };
}

for (const configured of [false, true]) {
  test(`仅binary的v${configured ? 2 : 1}订阅可查询当前版本及仍有效的回滚目标`, async () => {
    const env = remote(), old = addCandidate(env, 'a1', configured), current = addCandidate(env, 'b2', configured);
    binaryOnly(old.activation); binaryOnly(current.activation);
    const oldCommit = 'f'.repeat(40), genesis = '0'.repeat(40);
    const stablePath = configured ? 'stable/ai-openai' : 'stable/v2fly/category-ai-not-cn';
    const recordPath = configured ? `${stablePath}/activation.json` : 'stable/activation.json';
    const oldRecord = configured ? old.activation : legacyActivation(old, genesis, stablePath);
    const currentRecord = configured ? current.activation : legacyActivation(current, oldCommit, stablePath);
    if (configured) current.activation.history.push({ commit: oldCommit, id: old.activation.id, candidateId: 'a1' });
    env.stable.set(recordPath, encode(currentRecord));
    env.stable.set(`${stablePath}/domains.srs`, current.contents['domains.srs']);
    env.history.set(immutableUrl(oldCommit, recordPath), encode(oldRecord));
    env.history.set(immutableUrl(oldCommit, `${stablePath}/domains.srs`), old.contents['domains.srs']);
    const activation = { async download(url: string) {
      if (url === immutableUrl(genesis, recordPath)) throw new Error(`Readback HTTP 404: ${url}`);
      return env.publication.download(url);
    } };
    const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation });
    const id = configured ? 'ai-openai' : 'v2fly:category-ai-!cn';
    assert.equal((configured ? result.activeRuleVersions[id] : result.activeRuleVersion)?.activation.candidateId, 'b2');
    assert.deepEqual(result.rollbackTargets[id].map(target => target.candidateId), ['a1']);
    assert.equal(result.historyComplete[id], true);
    assert.deepEqual(result.historyErrors[id], []);
    assert.deepEqual(result.pendingOperations, []);
    assert.equal(env.stable.has(`${stablePath}/domains.json`), false);
  });
}

for (const configured of [false, true]) {
  for (const fault of ['missing', 'schema', 'identity', 'repository', 'branch', 'path', 'file-set', 'mapping']) {
    test(`v${configured ? 2 : 1}状态拒绝${fault}订阅或文件记录`, async () => {
      const env = remote(), current = addCandidate(env, 'a1', configured), genesis = '0'.repeat(40);
      const record: Record<string, any> = configured ? current.activation : legacyActivation(current, genesis);
      const recordPath = configured ? 'stable/ai-openai/activation.json' : 'stable/activation.json';
      const projection = record.subscription.projections;
      if (fault === 'missing') delete record.subscription;
      if (fault === 'schema') record.subscription.schemaVersion = configured ? 1 : 2;
      if (fault === 'identity') record.subscription.systemRuleSetId = 'another-rule-set';
      if (fault === 'repository') projection.route.formats.binary.url = projection.route.formats.binary.url.replace('sing-box-rule-artifacts', 'untrusted-artifacts');
      if (fault === 'branch') projection.route.formats.binary.url = projection.route.formats.binary.url.replace('/main/', '/other/');
      if (fault === 'path') projection.route.formats.binary.url = projection.route.formats.binary.url.replace('/stable/', '/stable/../');
      if (fault === 'file-set') delete record.files[Object.keys(record.files).find(path => path.endsWith('domains.srs'))!];
      if (fault === 'mapping') {
        if (configured) delete projection['dns-query'].formats.source;
        else projection['dns-query'].formats.binary.requiredCapabilities.push('processMatching');
      }
      env.stable.set(recordPath, encode(record));
      await assert.rejects(readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication }),
        /subscription|Subscription|activation file set/);
    });
  }
}

test('v1状态保留已支持的route与dns-query不同格式集合', async () => {
  const env = remote(), current = addCandidate(env, 'a1', false), genesis = '0'.repeat(40);
  const record = legacyActivation(current, genesis, 'stable/v2fly/category-ai-not-cn');
  delete record.subscription.projections.route.formats.source;
  env.stable.set('stable/activation.json', encode(record));
  for (const file of ['domains.json', 'domains.srs']) env.stable.set(`stable/v2fly/category-ai-not-cn/${file}`, current.contents[file]);
  const activation = { async download(url: string): Promise<Buffer> { throw new Error(`Readback HTTP 404: ${url}`); } };
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation });
  assert.equal(result.activeRuleVersion?.activation.candidateId, 'a1');
  assert.equal(result.candidateAvailability.a1.status, 'available');
  assert.deepEqual(result.pendingOperations, []);
});

test('历史订阅缺失时保留当前交付但不返回该回滚目标', async () => {
  const env = remote(), old = addCandidate(env, 'a1'), current = addCandidate(env, 'b2');
  const oldCommit = 'f'.repeat(40);
  current.activation.history.push({ commit: oldCommit, id: old.activation.id, candidateId: 'a1' }); activate(env, current);
  const broken: Record<string, unknown> = { ...old.activation }; delete broken.subscription;
  env.history.set(immutableUrl(oldCommit, 'stable/ai-openai/activation.json'), encode(broken));
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.equal(result.activeRuleVersions['ai-openai'].activation.candidateId, 'b2');
  assert.deepEqual(result.rollbackTargets['ai-openai'], []);
  assert.equal(result.historyComplete['ai-openai'], false);
  assert.match(result.unavailableRollbackTargets['ai-openai'][0].reason, /Rule Subscription/);
});

test('legacy status 沿远端 expectedHead 链列出仍保留且已核验的历史版本', async () => {
  const env = remote(), oldest = addCandidate(env, 'a1', false), previous = addCandidate(env, 'b2', false), current = addCandidate(env, 'c3', false);
  const genesis = '0'.repeat(40), oldestCommit = '1'.repeat(40), previousCommit = '2'.repeat(40);
  const currentRecord = legacyActivation(current, previousCommit);
  env.stable.set('stable/activation.json', encode(currentRecord));
  for (const file of ['domains.json', 'domains.srs']) env.stable.set(`stable/${file}`, current.contents[file]);
  for (const [commit, candidate, expectedHead] of [[previousCommit, previous, oldestCommit], [oldestCommit, oldest, genesis]] as const) {
    env.history.set(immutableUrl(commit, 'stable/activation.json'), encode(legacyActivation(candidate, expectedHead)));
    for (const file of ['domains.json', 'domains.srs']) env.history.set(immutableUrl(commit, `stable/${file}`), candidate.contents[file]);
  }
  const reads: string[] = [];
  const activation = { async download(url: string) {
    reads.push(url);
    if (url === immutableUrl(genesis, 'stable/activation.json')) throw new Error(`Readback HTTP 404: ${url}`);
    return env.publication.download(url);
  } };
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation });
  assert.equal(result.activeRuleVersion?.activation.candidateId, 'c3');
  assert.deepEqual(result.rollbackTargets['v2fly:category-ai-!cn'].map(target => target.candidateId), ['b2', 'a1']);
  assert.equal(result.historyComplete['v2fly:category-ai-!cn'], true);
  assert.deepEqual(result.historyErrors['v2fly:category-ai-!cn'], []);
  assert.deepEqual(reads, [previousCommit, oldestCommit, genesis].map(commit => immutableUrl(commit, 'stable/activation.json')));
});

for (const fault of ['network', 'ambiguous-404', 'missing-head', 'commit-cycle', 'activation-cycle']) {
  test(`legacy history ${fault} 保留当前交付并明确报告历史待核实`, async () => {
    const env = remote(), current = addCandidate(env, 'a1', false), old = addCandidate(env, 'b2', false);
    const oldCommit = '2'.repeat(40), genesis = '0'.repeat(40);
    const currentRecord: Record<string, unknown> = legacyActivation(current, fault === 'commit-cycle' ? head : oldCommit);
    if (fault === 'missing-head') delete currentRecord.expectedHead;
    env.stable.set('stable/activation.json', encode(currentRecord));
    for (const file of ['domains.json', 'domains.srs']) env.stable.set(`stable/${file}`, current.contents[file]);
    const activation = { async download() {
      if (fault === 'network') throw new Error('Git API unavailable');
      if (fault === 'ambiguous-404') throw new Error('Readback HTTP 404');
      if (fault === 'activation-cycle') return encode({ ...legacyActivation(old, genesis), id: current.activation.id });
      throw new Error('Invalid old head must not be queried');
    } };
    const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation });
    assert.equal(result.activeRuleVersion?.activation.candidateId, 'a1');
    assert.equal(result.historyComplete['v2fly:category-ai-!cn'], false);
    assert.equal(result.historyErrors['v2fly:category-ai-!cn'].length, 1);
    assert.deepEqual(result.rollbackTargets['v2fly:category-ai-!cn'], []);
    assert.ok(result.pendingOperations.some(operation => operation.status === 'history-verification-pending'));
  });
}

test('legacy 首次激活的旧 Git tree 确认没有记录后才报告完整空历史', async () => {
  const env = remote(), current = addCandidate(env, 'a1', false), genesis = '0'.repeat(40);
  env.stable.set('stable/activation.json', encode(legacyActivation(current, genesis)));
  for (const file of ['domains.json', 'domains.srs']) env.stable.set(`stable/${file}`, current.contents[file]);
  const activation = { async download(url: string): Promise<Buffer> {
    assert.equal(url, immutableUrl(genesis, 'stable/activation.json'));
    throw new Error(`Readback HTTP 404: ${url}`);
  } };
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation });
  assert.equal(result.historyComplete['v2fly:category-ai-!cn'], true);
  assert.deepEqual(result.historyErrors['v2fly:category-ai-!cn'], []);
  assert.deepEqual(result.rollbackTargets['v2fly:category-ai-!cn'], []);
  assert.deepEqual(result.pendingOperations, []);
});

test('全新目录查询远端空状态，不创建发布或伪造当前版本', async () => {
  const env = remote();
  const result = await readRemoteStatus({ repository: env.repository });
  assert.equal(result.authority, 'remote');
  assert.equal(result.head, head);
  assert.equal(result.generation, 1);
  assert.equal(result.activeRuleVersion, null);
  assert.deepEqual(result.activeRuleVersions, {});
  assert.deepEqual(result.rollbackTargets, {});
  assert.deepEqual(result.pendingOperations, []);
});

test('已提交的当前规则不因候选回读故障变成未激活，并单独报告待核实操作', async () => {
  const env = remote(), current = addCandidate(env, 'a1'); activate(env, current);
  env.history.delete(current.activation.candidateEvidenceUrl);
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.equal(result.activeRuleVersions['ai-openai'].activation.candidateId, 'a1');
  assert.equal(result.candidateAvailability.a1.status, 'verification-pending');
  assert.ok(result.pendingOperations.some(operation => operation.candidateId === 'a1'));
});

test('status 从当前稳定记录与仍保留的历史证据报告可回滚版本，不依赖本地回执', async () => {
  const env = remote(), old = addCandidate(env, 'a1'), current = addCandidate(env, 'b2');
  const oldCommit = 'f'.repeat(40);
  current.activation.history.push({ commit: oldCommit, id: old.activation.id, candidateId: 'a1' });
  env.stable.set('stable/ai-openai/activation.json', encode(current.activation));
  for (const file of ['domains.json', 'domains.srs']) {
    env.stable.set(`stable/ai-openai/${file}`, current.contents[file]);
    env.history.set(immutableUrl(oldCommit, `stable/ai-openai/${file}`), old.contents[file]);
  }
  env.history.set(immutableUrl(oldCommit, 'stable/ai-openai/activation.json'), encode(old.activation));
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.equal(result.activeRuleVersions['ai-openai'].activation.candidateId, 'b2');
  assert.equal(result.activeRuleVersions['ai-openai'].commit, head);
  assert.deepEqual(result.rollbackTargets['ai-openai'].map(target => target.candidateId), ['a1']);
  assert.equal(result.rollbackTargets['ai-openai'][0].verification, 'structural');
  assert.equal(result.candidateAvailability['b2'].verification, 'structural');
});

test('历史订阅契约不兼容时不列为有效回滚目标', async () => {
  const env = remote(), old = addCandidate(env, 'a1'), current = addCandidate(env, 'b2');
  const oldCommit = 'f'.repeat(40);
  binaryOnly(current.activation);
  current.activation.history.push({ commit: oldCommit, id: old.activation.id, candidateId: 'a1' }); activate(env, current);
  env.history.set(immutableUrl(oldCommit, 'stable/ai-openai/activation.json'), encode(old.activation));
  for (const file of ['domains.json', 'domains.srs']) env.history.set(immutableUrl(oldCommit, `stable/ai-openai/${file}`), old.contents[file]);
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.deepEqual(result.rollbackTargets['ai-openai'], []);
  assert.match(result.unavailableRollbackTargets['ai-openai'][0].reason, /subscription/i);
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
  env.history.set(immutableUrl(oldCommit, 'stable/ai-openai/activation.json'), encode(old.activation));
  for (const file of ['domains.json', 'domains.srs']) env.history.set(immutableUrl(oldCommit, `stable/ai-openai/${file}`), old.contents[file]);
  const result = await readRemoteStatus({ repository: env.repository, publication: env.publication, activation: env.publication });
  assert.deepEqual(result.rollbackTargets['ai-openai'], []);
  assert.equal(result.candidateAvailability.a1.status, 'unavailable');
  assert.equal(result.candidateAvailability.a1.evidenceUrl, undefined);
  assert.match(result.unavailableRollbackTargets['ai-openai'][0].reason, /no longer retained/);
});

test('当前稳定字节损坏与非法历史记录不能被当作正常状态', async () => {
  for (const corrupt of ['bytes', 'history'] as const) {
    const env = remote(), current = addCandidate(env, 'a1'); activate(env, current);
    if (corrupt === 'bytes') env.stable.set('stable/ai-openai/domains.srs', Buffer.from('corrupted'));
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
