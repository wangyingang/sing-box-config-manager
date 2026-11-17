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

test('维护发现未归属的稳定文件时延期并保留文件', async () => {
  const env = remote();
  activate(env, addCandidate(env, 'a1'));
  const rule = 'stable/untracked/rules.srs';
  env.stable.set(rule, Buffer.from('untracked stable bytes'));
  const original = new Map(env.stable);
  const options = { repository: env.repository, publication: env.publication, activation: env.publication };
  const status = await readRemoteStatus(options);
  assert.equal(status.activeRuleVersions.openai.activation.candidateId, 'a1');
  assert.deepEqual(Object.keys(status.rollbackTargets), ['openai']);
  assert.deepEqual(status.pendingOperations, []);
  const result = await manageMaintenance({ ...options, action: 'enter', manual: true, refs: async () => [] });
  assert.equal(result.status, 'deferred');
  assert.ok('blockers' in result && result.blockers.some(item => item.id === rule && item.status === 'unidentified-stable-file'));
  assert.deepEqual(env.stable, original);
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
