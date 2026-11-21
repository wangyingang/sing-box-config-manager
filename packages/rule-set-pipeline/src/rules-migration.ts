import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { activationSubscription, candidateStableFiles, verifyCandidateEvidence } from './activation.js';
import { configuredSubscriptions, parseHistoricalConfiguration, parseRuleDefinition, parseSource, type RuleDefinition, type SourceInput } from './configuration.js';
import { effectiveControl } from './manual-activation.js';
import { immutableUrl } from './publication.js';
import { retainedCandidateDownload, type PublicationRepository, type PublicationSnapshot } from './publication-repository.js';
import { readRemoteState, type RemoteJournal } from './remote-state.js';
import { activationRecord, verifyStableFiles } from './remote-status.js';
import { sha256 } from './release.js';
import { guardRulesConfiguration, loadRulesRequest, rulesBinary, type LoadedRules, type RulesRequest } from './rules-context.js';
import { definitionRevision, encodeRecord, inputBindingRevision, parseRulesJournal, RULE_RECEIPT_PATH, RULE_STATE_PATH,
  type ManagedRule, type RuleCandidate, type RuleDelivery, type RulesJournal } from './rules-model.js';
import type { RuleWrites } from './rules-repository.js';

interface MigrationAudit {
  id: string;
  oldHeads: { journal: string; stable: string };
  configurationRevision: string;
  /** Frozen provenance only. New operations never interpret this as control state. */
  legacy: RemoteJournal;
  quarantinedCandidates: string[];
  quarantinedOperations: string[];
  timeEvidence: Record<string, string>;
  pending: string[];
}
interface MigrationPlan {
  schemaVersion: 1;
  next: RulesJournal & { migration: MigrationAudit };
  stableRecords: Record<string, RuleDelivery>;
}
interface MigratingJournal extends RemoteJournal { rulesMigration?: MigrationPlan; rulesMigrationSha256?: string }

/** Only immutable publication evidence may establish a historical publication time. */
function historicalTime(bytes: Buffer, candidateId: string) {
  const evidence = JSON.parse(bytes.toString());
  if (typeof evidence.publishedAt !== 'string' || !Number.isFinite(Date.parse(evidence.publishedAt))
    || new Date(evidence.publishedAt).toISOString() !== evidence.publishedAt) return undefined;
  const versionId = typeof evidence.versionId === 'string' && evidence.versionId.startsWith(`${evidence.publishedAt}~`)
    ? evidence.versionId : `${evidence.publishedAt}~${candidateId.replaceAll('-', '')}`;
  return { publishedAt: evidence.publishedAt as string, versionId };
}

function historicalSource(source: RuleCandidate['source'], definition: RuleCandidate['definition']): SourceInput {
  const format = 'artifact' in definition.usages['dns-response'] ? 'cidr-text' : 'plain-yaml';
  if ('kind' in source) {
    if (source.kind !== 'github-commit') throw new Error('RULE_MIGRATION_BLOCKED: unsupported historical source');
    return parseSource({ repository: source.repository, version: 'git-branch', branch: source.branch, input: { format, path: source.file.path } });
  }
  return parseSource({ repository: source.repository, version: 'latest-release', input: { format,
    asset: source.yaml.name, checksum: source.checksum.name } });
}

function readOnlyLegacyRepository(loaded: LoadedRules, snapshot?: PublicationSnapshot): PublicationRepository {
  return { branch: loaded.context.repository.branch,
    snapshot: branch => snapshot && (!branch || branch === loaded.context.repository.branch) ? Promise.resolve(snapshot) : loaded.context.repository.snapshot(branch),
    commit: async () => { throw new Error('Migration inventory is read-only'); } };
}

async function prepareMigration(loaded: LoadedRules, journal: RemoteJournal, snapshot: PublicationSnapshot, stable: PublicationSnapshot): Promise<MigrationPlan> {
  if (journal.maintenance !== 'open' || journal.maintenanceRun || journal.maintenanceCleanup) throw new Error('RULE_MIGRATION_BLOCKED: finish existing maintenance first');
  const audit: MigrationAudit = { id: randomUUID(), oldHeads: { journal: snapshot.head, stable: stable.head },
    configurationRevision: loaded.observed.revision, legacy: journal, quarantinedCandidates: [], quarantinedOperations: [], timeEvidence: {}, pending: [] };
  const next: MigrationPlan['next'] = { schemaVersion: 2, id: journal.id, generation: journal.generation + 1,
    targetBranch: journal.targetBranch, maintenance: 'open', rules: {}, candidates: {}, migration: audit };
  const oldActive = new Map<string, ReturnType<typeof activationRecord>['record']>();
  for (const path of stable.paths.filter(path => /^stable\/.+\/activation\.json$/.test(path))) {
    const bytes = await stable.read(path);
    const { record } = activationRecord(JSON.parse(bytes!.toString()), path, journal.targetBranch);
    await verifyStableFiles(record, file => stable.read(file));
    if (oldActive.has(record.logicalId)) throw new Error('RULE_MIGRATION_BLOCKED: duplicate stable logical ID');
    oldActive.set(record.logicalId, record);
  }
  const quarantinedDefinitions = new Map<string, { definition: RuleDefinition; source: SourceInput }>();
  const candidateIds = new Set([
    ...snapshot.paths.map(path => /^candidates\/([a-f0-9-]{36})\//.exec(path)?.[1]).filter((id): id is string => !!id),...Object.values(journal.state.candidates).filter(candidate => candidate.retained).map(candidate => candidate.id),
    ...[...oldActive.values()].map(record => record.candidateId)]);
  const generation = new Map<string, string>();
  const logicalGeneration = (id: string) => {
    if (!generation.has(id)) generation.set(id, randomUUID());
    return generation.get(id)!;
  };
  for (const id of candidateIds) {
    const registered = journal.state.candidates[id];
    const active = [...oldActive.values()].find(record => record.candidateId === id);
    const buildBytes = await snapshot.read(`candidates/${id}/build.json`);
    const evidenceBytes = await snapshot.read(`candidates/${id}/readback.json`);
    if (!buildBytes || !evidenceBytes || registered && registered.status !== 'verified') {
      if (active) throw new Error(`RULE_MIGRATION_BLOCKED: current candidate ${id} is incomplete`);
      let owner: string | undefined;
      const current = loaded.configuration.ruleSets.find(definition => definition.id === registered?.logicalId);
      if (current) {
        owner = current.id;
        quarantinedDefinitions.set(owner, { definition: current, source: loaded.configuration.sources[current.source] });
      } else if (registered?.logicalId && registered.definition) {
        const operation = [journal.state.pendingOperation, ...(journal.parkedOperations ?? [])]
          .find(operation => operation?.id === registered.operationId);
        if (operation?.configuration) {
          const configuration = parseHistoricalConfiguration(operation.configuration);
          const definition = configuration.ruleSets.find(definition => definition.id === registered.logicalId);
          if (definition && isDeepStrictEqual(definition, registered.definition)) {
            owner = definition.id;
            quarantinedDefinitions.set(owner, { definition, source: configuration.sources[definition.source] });
          }
        }
      }
      const reason = owner ? 'Incomplete historical publication retained for inspection'
        : 'Historical candidate ownership or original definition is unresolved';
      (next.quarantinedCandidates ??= {})[id] = { id, ...(owner ? { logicalId: owner } : {}), reason };
      audit.quarantinedCandidates.push(id); audit.pending.push(`Candidate ${id}: ${reason}`); continue;
    }
    const build = JSON.parse(buildBytes.toString());
    const format = build.definition?.usages?.['dns-response']?.artifact ? 'cidr-text' : 'plain-yaml';
    const definition = parseRuleDefinition(build.definition, format);
    const evidenceUrl = active?.candidateEvidenceUrl ?? registered?.evidenceUrl
      ?? immutableUrl(await loaded.context.repository.lastChange(snapshot.head, `candidates/${id}/readback.json`), `candidates/${id}/readback.json`);
    const verified = await verifyCandidateEvidence({ candidateEvidenceUrl: evidenceUrl, binary: rulesBinary(loaded.context),
      evidenceSha256: registered?.evidenceSha256 }, { branch: journal.targetBranch,
      download: retainedCandidateDownload(snapshot, id, loaded.context.repository.download) }, definition, 'rollback');
    if (verified.candidateId !== id || verified.buildId !== build.buildId || registered?.buildId && registered.buildId !== build.buildId
      || active && !isDeepStrictEqual(active.source, verified.source)) throw new Error('RULE_MIGRATION_BLOCKED: historical identity mismatch');
    const source = historicalSource(verified.source, definition);
    const time = historicalTime(evidenceBytes, id);
    const evidence = JSON.parse(evidenceBytes.toString());
    next.candidates[id] = { id, status: 'verified', operation: 'migration', logicalId: definition.id, definition,
      sourceInput: source, inputBindingRevision: inputBindingRevision(source, definition), definitionGeneration: logicalGeneration(definition.id),
      source: verified.source, buildId: verified.buildId, filesCommit: evidence.filesCommit, metadataCommit: evidence.metadataCommit,
      evidenceCommit: evidenceUrl.split('/')[5], evidenceUrl, evidenceSha256: sha256(evidenceBytes),
      manifestUrl: immutableUrl(evidence.metadataCommit, `candidates/${id}/manifest.json`), ...time,
      ...(!time ? { migrationPending: 'Historical publication time is unavailable; retained evidence is not eligible for age-based cleanup or version selection' } : {}) };
    if (time) audit.timeEvidence[id] = evidenceUrl;
    else audit.pending.push(`Candidate ${id}: historical publication time unavailable`);
    if (active) {
      // Compare every stable byte to the candidate as well as to its stored digest.
      const expected = candidateStableFiles(verified, active.subscription, definition, journal.targetBranch);
      if (!isDeepStrictEqual(Object.keys(expected).sort(), Object.keys(active.files).sort())) throw new Error('RULE_MIGRATION_BLOCKED: stable file set mismatch');
      for (const [path, bytes] of Object.entries(expected)) if (!(await stable.read(path))?.equals(bytes)) throw new Error('RULE_MIGRATION_BLOCKED: stable bytes do not match current candidate');
    }
  }
  const definitions = new Map(loaded.configuration.ruleSets.map(definition => [definition.id, definition]));
  for (const id of new Set([...definitions.keys(), ...oldActive.keys(), ...Object.values(next.candidates).map(candidate => candidate.logicalId), ...quarantinedDefinitions.keys()])) {
    const active = oldActive.get(id);
    const previous = active ? next.candidates[active.candidateId] : Object.values(next.candidates).find(candidate => candidate.logicalId === id);
    const definition = definitions.get(id) ?? previous?.definition ?? quarantinedDefinitions.get(id)!.definition;
    const source = definitions.has(id) ? loaded.configuration.sources[definition.source] : previous?.sourceInput ?? quarantinedDefinitions.get(id)!.source;
    const binding = inputBindingRevision(source, definition);
    if (active && definitions.has(id)) {
      const expected = activationSubscription(configuredSubscriptions({ ...loaded.configuration, ruleSets: [definition] })[id], journal.targetBranch, definition);
      if (!isDeepStrictEqual(active.subscription, expected)) throw new Error(`RULE_MIGRATION_BLOCKED: ${id} subscription contract changed`);
    }
    const keepPin = active && previous && definitions.has(id) && previous.inputBindingRevision === binding
      && effectiveControl(journal, id, active)?.pauseAutomaticActivation;
    const control = keepPin ? { mode: 'pinned' as const, revision: randomUUID(), inputBindingRevision: binding, candidateId: previous.id }
      : { mode: 'auto' as const, revision: randomUUID(), inputBindingRevision: binding };
    next.rules[id] = { definition, source, inputBindingRevision: binding, definitionRevision: definitionRevision(source, definition),
      configurationRevision: loaded.observed.revision, generation: logicalGeneration(id), lifecycle: 'present', control } satisfies ManagedRule;
  }
  const stableRecords: MigrationPlan['stableRecords'] = {};
  for (const [id, old] of oldActive) {
    const candidate = next.candidates[old.candidateId];
    stableRecords[`${candidate.definition.stablePath}/activation.json`] = { schemaVersion: 2, id: old.id, logicalId: id,
      candidateId: candidate.id, candidateEvidenceUrl: candidate.evidenceUrl!, source: candidate.source,
      versionId: candidate.versionId, publishedAt: candidate.publishedAt, subscription: old.subscription, files: old.files };
  }
  audit.quarantinedOperations = [...new Set([
    ...(journal.state.pendingOperation?.status === 'pending' ? [journal.state.pendingOperation.id] : []),
    ...(journal.parkedOperations ?? []).map(operation => operation.id),
    ...Object.values(journal.manualOperations ?? {}).filter(operation => !operation.notCommitted).map(operation => operation.id),
    ...Object.values(journal.automaticOperations ?? {}).filter(operation => !operation.notCommitted).map(operation => operation.id),
  ])];
  parseRulesJournal(encodeRecord(next));
  return { schemaVersion: 1, next, stableRecords };
}

/** Internal one-time conversion; deliberately absent from CLI and package exports.
 * A split target checkpoints the complete plan under the old maintenance gate.
 * Retries inspect the same receipt and never re-run an old upstream operation.
 */
export async function migrateRulesState(request: RulesRequest) {
  if (request.draft !== undefined) throw new Error('Migration requires the current official configuration');
  const loaded = await loadRulesRequest(request);
  const repository = loaded.context.repository;
  let snapshot = await repository.snapshot();
  const state = await snapshot.read(RULE_STATE_PATH);
  if (!state) throw new Error('RULE_MIGRATION_BLOCKED: no legacy journal');
  const raw = JSON.parse(state.toString());
  if (raw.schemaVersion === 2) {
    const current = parseRulesJournal(state) as MigrationPlan['next'];
    if (!current.migration) throw new Error('RULE_MIGRATION_BLOCKED: journal is already current');
    return { status: 'already-converted', dryRun: loaded.dryRun, migration: current.migration };
  }
  const { journal } = await readRemoteState(readOnlyLegacyRepository(loaded, snapshot));
  let stable = repository.branch === loaded.context.targetBranch ? snapshot : await repository.snapshot(loaded.context.targetBranch);
  const existing = (journal as MigratingJournal).rulesMigration;
  if (existing && (journal as MigratingJournal).rulesMigrationSha256 !== sha256(encodeRecord(existing))) {
    throw new Error('RULE_MIGRATION_BLOCKED: conversion checkpoint digest differs');
  }
  const plan = existing ?? await prepareMigration(loaded, journal, snapshot, stable);
  if (plan.schemaVersion !== 1 || !plan.next?.migration || !plan.stableRecords) throw new Error('RULE_MIGRATION_BLOCKED: invalid conversion checkpoint');
  parseRulesJournal(encodeRecord(plan.next));
  const audit = plan.next.migration;
  if (audit.configurationRevision !== loaded.observed.revision || plan.next.targetBranch !== loaded.context.targetBranch) throw new Error('RULE_MIGRATION_BLOCKED: configuration changed during conversion');
  if (loaded.dryRun) return { status: 'planned', dryRun: true, migration: audit,
    stableRecords: Object.keys(plan.stableRecords), stableBytesUnchanged: true };
  const shared = repository.branch === loaded.context.targetBranch;
  const guard = async () => {
    await guardRulesConfiguration(loaded);
    if ((await repository.snapshot()).head !== snapshot.head) throw new Error('RULE_MIGRATION_PENDING: journal head changed');
  };
  const write = async (branch: string, parent: string, files: RuleWrites) => {
    try { await repository.commit(branch, parent, files, '转换规则交付状态并隔离旧操作', guard); }
    catch (error) {
      const actual = await repository.snapshot(branch);
      if (!(await Promise.all(Object.entries(files).map(async ([path, bytes]) => bytes !== null && (await actual.read(path))?.equals(bytes)))).every(Boolean)) {
        throw new Error('RULE_MIGRATION_PENDING: conversion write requires verification', { cause: error });
      }
    }
  };
  const finalFiles: RuleWrites = { [RULE_STATE_PATH]: encodeRecord(plan.next),
    'pipeline/identity.json': encodeRecord({ schemaVersion: 2, id: plan.next.id }) };
  const stableFiles: RuleWrites = { ...Object.fromEntries(Object.entries(plan.stableRecords).map(([path, record]) => [path, encodeRecord(record)])),
    [RULE_RECEIPT_PATH]: encodeRecord({ schemaVersion: 2, id: audit.id, migration: true }) };
  if (shared) {
    await write(repository.branch, snapshot.head, { ...finalFiles, ...stableFiles });
  } else {
    if (!existing) {
      const checkpoint: MigratingJournal = { ...journal, maintenance: 'maintenance', rulesMigration: plan, rulesMigrationSha256: sha256(encodeRecord(plan)) };
      await write(repository.branch, snapshot.head, { [RULE_STATE_PATH]: encodeRecord(checkpoint) });
      snapshot = await repository.snapshot();
    }
    const receipt = await stable.read(RULE_RECEIPT_PATH);
    const applied = receipt && JSON.parse(receipt.toString()).id === audit.id;
    if (!applied) {
      if (stable.head !== audit.oldHeads.stable) throw new Error('RULE_MIGRATION_PENDING: stable head changed; preserve current delivery and inspect conversion');
      await write(loaded.context.targetBranch, stable.head, stableFiles);
      stable = await repository.snapshot(loaded.context.targetBranch);
    }
    for (const [path, record] of Object.entries(plan.stableRecords)) {
      if (!(await stable.read(path))?.equals(encodeRecord(record))) throw new Error('RULE_MIGRATION_PENDING: converted activation differs');
      await verifyStableFiles(record, file => stable.read(file));
    }
    await write(repository.branch, snapshot.head, finalFiles);
  }
  const final = await repository.snapshot();
  const actual = await final.read(RULE_STATE_PATH);
  if (!actual?.equals(finalFiles[RULE_STATE_PATH]!)) throw new Error('RULE_MIGRATION_PENDING: final journal not confirmed');
  parseRulesJournal(actual);
  return { status: 'converted', dryRun: false, migration: audit,
    stableRecords: Object.keys(plan.stableRecords), stableBytesUnchanged: true };
}
