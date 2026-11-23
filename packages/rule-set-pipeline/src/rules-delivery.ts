import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathsOverlap, ruleDeliveryRecordPath, singleArtifactPaths, stableRecordLocation } from './stable-rule-paths.js';
import { activationSubscription, candidateStableFiles } from './activation.js';
import { artifactSubscription, configuredSubscription, type RuleDefinition } from './configuration.js';
import { immutableUrl } from './publication.js';
import { PublicationWriteError, type PublicationSnapshot } from './publication-repository.js';
import { sha256 } from './release.js';
import { encodeRecord, RULE_RECEIPT_PATH, type FileEvidence, type ManagedRule, type PendingDelivery, type RuleCandidate, type RuleDelivery } from './rules-model.js';
import type { RulesSession } from './rules-session.js';
import type { RuleWrites } from './rules-repository.js';
import { rulesBinary } from './rules-context.js';
import { verifyRuleCandidate } from './rules-build.js';
import { qualifiedRuleCandidate, successfulRuleInput, verifiedDeliveryInput } from './rules-success.js';

export async function readRuleDeliveries(session: RulesSession, snapshot: PublicationSnapshot) {
  return (await session.loaded.readStableDeliveries(snapshot)).records;
}

export function ruleSubscription(session: RulesSession, rule: Pick<ManagedRule, 'definition'>, current?: RuleDelivery) {
  const { definition } = rule;
  const branch = session.loaded.context.targetBranch;
  const subscription = 'artifact' in definition ? artifactSubscription(definition, branch)
    : activationSubscription(configuredSubscription(definition, branch), branch, definition);
  if (current && !isDeepStrictEqual(current.subscription, subscription)) throw new Error('Existing subscription contract cannot change during delivery');
  return subscription;
}

function checkOtherDeliveryRoots(logicalId: string, stablePath: string, recordPaths: ReadonlyMap<string, string>,
  sharedDirectoryAllowed = false) {
  for (const [id, path] of recordPaths) {
    if (id === logicalId) continue;
    const { directory, artifact } = stableRecordLocation(path)!;
    if (sharedDirectoryAllowed && artifact !== undefined) continue;
    if (pathsOverlap(directory, stablePath)) {
      throw new Error(`SUBSCRIPTION_PATH_CONFLICT: ${stablePath} overlaps current delivery ${id}`);
    }
  }
}

/** Desired paths cannot overwrite a different rule's still-current contract. */
export async function ensureRulePathAvailable(session: RulesSession, definition: RuleDefinition, observed?: PublicationSnapshot) {
  const stable = observed ?? await session.stable();
  const { records, recordPaths } = await session.loaded.readStableDeliveries(stable);
  const current = records.get(definition.id);
  const ownRecord = recordPaths.get(definition.id);
  const recordPath = ruleDeliveryRecordPath(definition);
  if (ownRecord && ownRecord !== recordPath) {
    throw new Error(`SUBSCRIPTION_PATH_CONFLICT: current delivery ${definition.id} is registered at ${ownRecord}`);
  }
  checkOtherDeliveryRoots(definition.id, definition.stablePath, recordPaths, 'artifact' in definition);
  if ('artifact' in definition) {
    const expected = [recordPath, ...singleArtifactPaths(definition.stablePath, definition.artifact)];
    const occupied = stable.paths.find(path =>
      path !== ownRecord && !(current && Object.hasOwn(current.files, path))
      && expected.some(output => pathsOverlap(output, path)
        && !(output.startsWith(path + '/') && stable.isDirectory?.(path))));
    if (occupied) throw new Error(`SUBSCRIPTION_PATH_CONFLICT: ${definition.id} overlaps existing path ${occupied}`);
    return current;
  }
  if (stable.paths.some(path => path.startsWith(`${definition.stablePath}/`) && path !== ownRecord && !(current && Object.hasOwn(current.files, path)))) {
    throw new Error(`SUBSCRIPTION_PATH_CONFLICT: ${definition.stablePath} contains unmanaged files`);
  }
  return current;
}

async function observedDeletion(session: RulesSession, id: string, stable: PublicationSnapshot) {
  const { records, recordPaths } = await session.loaded.readStableDeliveries(stable);
  const record = records.get(id);
  if (!record) return { record, paths: [] };
  // A rejected definition may name a different root. Unmanaged siblings are left in place.
  const recordPath = recordPaths.get(id)!;
  const location = stableRecordLocation(recordPath)!;
  if (location.artifact === undefined) checkOtherDeliveryRoots(id, location.directory, recordPaths);
  return { record, paths: [recordPath, ...Object.keys(record.files)] };
}

async function verifyPendingOwnership(session: RulesSession, pending: PendingDelivery, stable: PublicationSnapshot) {
  if (pending.kind === 'delete') {
    const deletion = await observedDeletion(session, pending.logicalId, stable);
    if (!isDeepStrictEqual(new Set(deletion.paths), new Set(Object.keys(pending.changes)))) {
      throw new Error('RULE_WRITE_PENDING: registered deletion differs from current owned paths');
    }
  } else {
    const current = await ensureRulePathAvailable(session, pending.afterRule.definition, stable);
    ruleSubscription(session, pending.afterRule, current);
  }
}

async function plannedDeliveryFiles(session: RulesSession, pending: PendingDelivery): Promise<RuleWrites> {
  if (pending.kind === 'delete') return Object.fromEntries(Object.keys(pending.changes).map(path => [path, null]));
  const record = pending.record!;
  const candidate = session.journal.candidates[record.candidateId];
  if (!candidate) throw new Error('CANDIDATE_UNAVAILABLE: pending delivery has no retained version');
  const verified = await verifyRuleCandidate(session, candidate, rulesBinary(session.loaded.context));
  const subscription = ruleSubscription(session, pending.afterRule, record);
  const files: RuleWrites = candidateStableFiles(verified, subscription, pending.afterRule.definition, session.loaded.context.targetBranch);
  files[ruleDeliveryRecordPath(pending.afterRule.definition)] = encodeRecord(record);
  return files;
}

const evidenceFor = (files: RuleWrites) => Object.fromEntries(Object.entries(files).map(([path, bytes]) =>
  [path, bytes === null ? null : { sha256: sha256(bytes), byteLength: bytes.length }]));

export function matchesRuleDelivery(current: RuleDelivery, candidate: RuleCandidate, files: Record<string, Buffer>) {
  return current.logicalId === candidate.logicalId && current.candidateId === candidate.id
    && current.versionId === candidate.versionId && current.publishedAt === candidate.publishedAt
    && current.candidateEvidenceUrl === candidate.evidenceUrl && isDeepStrictEqual(current.source, candidate.source)
    && isDeepStrictEqual(current.files, evidenceFor(files));
}

async function receiptMatches(snapshot: PublicationSnapshot, id: string) {
  const bytes = await snapshot.read(RULE_RECEIPT_PATH);
  const receipt = bytes && JSON.parse(bytes.toString());
  return receipt?.schemaVersion === 2 && receipt.id === id;
}

async function verifyChanges(snapshot: PublicationSnapshot, changes: PendingDelivery['changes']) {
  for (const [path, expected] of Object.entries(changes)) {
    const bytes = await snapshot.read(path);
    if (expected === null ? bytes !== undefined : !bytes || bytes.length !== expected.byteLength || sha256(bytes) !== expected.sha256) {
      throw new Error(`RULE_WRITE_PENDING: stable write cannot be verified: ${path}`);
    }
  }
}

async function finishDelivery(session: RulesSession, pending: PendingDelivery, stable: PublicationSnapshot) {
  const rule = { ...pending.afterRule };
  if (pending.kind === 'sync') {
    const record = pending.record!;
    // The exact candidate was verified before registration. Stable recovery
    // can finish even if the previously checked candidate HTTPS is unavailable.
    const success = pending.qualifiedCandidate
      ? successfulRuleInput(rule, record.source, pending.qualifiedCandidate)
      : await verifiedDeliveryInput(session, rule, record, stable);
    if (success) rule.successfulInput = success;
  }
  session.journal.rules[pending.logicalId] = rule;
  const files: RuleWrites = {};
  for (const id of pending.removeCandidates) {
    for (const path of session.snapshot.paths.filter(path => path.startsWith(`candidates/${id}/`))) files[path] = null;
    delete session.journal.candidates[id];
    if (session.journal.quarantinedCandidates) delete session.journal.quarantinedCandidates[id];
  }
  if (pending.kind === 'delete' && (Object.keys(pending.changes).length || pending.removeCandidates.length)) {
    session.journal.deletedHistoryPending = true;
  }
  delete session.journal.pendingDelivery;
  await session.save(files);
}

function matchesRegisteredHead(shared: boolean, stable: PublicationSnapshot, verifiedHead: string, registrationCommit?: string) {
  if (!shared) return stable.head === verifiedHead;
  // On a shared branch the journal registration is itself the single child of the verified head.
  if (registrationCommit) return stable.head === registrationCommit;
  return stable.parents ? stable.parents.length === 1 && stable.parents[0] === verifiedHead : stable.parent === verifiedHead;
}

/** Resume exactly the registered write, including across machines or a lost response. */
export async function recoverRuleDelivery(session: RulesSession, registrationCommit?: string) {
  const pending = session.journal.pendingDelivery;
  if (!pending) return;
  if (session.loaded.dryRun) throw new Error('RULE_WRITE_PENDING: preview does not resume a pending delivery');
  const repository = session.loaded.context.repository;
  let stable = await session.stable();
  const applied = await receiptMatches(stable, pending.id);
  let deliveryCommit: string | undefined;
  if (!applied && pending.configurationRevision !== session.loaded.observed.revision) {
    // Fence the old stable parent before dropping its registration: a late PATCH
    // can no longer recreate deleted files or restore a superseded pin.
    if (!session.shared && stable.head !== pending.stableHead) throw new Error('RULE_WRITE_PENDING: superseded write has an unknown stable result');
    const fence = { [RULE_RECEIPT_PATH]: encodeRecord({ schemaVersion: 2, id: randomUUID(), superseded: pending.id }) };
    if (session.shared) await session.save(fence);
    else await repository.commit(session.loaded.context.targetBranch, stable.head, fence, '隔离已过期的规则交付', session.guard);
    delete session.journal.pendingDelivery;
    await session.save();
    return;
  }
  if (!applied) {
    session.loaded.progress('stable-write', pending.logicalId);
    if (!matchesRegisteredHead(session.shared, stable, pending.stableHead, registrationCommit)) {
      throw new Error('RULE_WRITE_PENDING: stable head differs from registered write');
    }
    // An older registration may have captured its head after the original ownership check.
    if (!registrationCommit) await verifyPendingOwnership(session, pending, stable);
    const files = await plannedDeliveryFiles(session, pending);
    if (!isDeepStrictEqual(evidenceFor(files), pending.changes)) throw new Error('RULE_WRITE_PENDING: registered content changed');
    files[RULE_RECEIPT_PATH] = encodeRecord({ schemaVersion: 2, id: pending.id });
    try {
      if (session.shared) await session.save(files);
      else deliveryCommit = await repository.commit(session.loaded.context.targetBranch, pending.stableHead, files,
        `交付规则 ${pending.logicalId}：${pending.kind}`, session.guard);
    } catch (error) {
      stable = await session.stable();
      if (!await receiptMatches(stable, pending.id)) throw new Error(`RULE_WRITE_PENDING: ${error instanceof PublicationWriteError ? error.attemptedCommit : String(error)}`, { cause: error });
    }
    stable = await session.stable();
  }
  if (!await receiptMatches(stable, pending.id)) throw new Error('RULE_WRITE_PENDING: receipt not visible');
  session.loaded.progress('readback', pending.logicalId);
  await verifyChanges(stable, pending.changes);
  // Git success and HTTPS readback are separate facts. Keep the registration if
  // readback fails, so status can show the committed version and pending check.
  if (pending.record) {
    const commit = deliveryCommit ?? await repository.lastChange(stable.head, RULE_RECEIPT_PATH);
    for (const [path, expected] of Object.entries(pending.record.files)) {
      await session.loaded.verifyEvidence(async download => {
        const actual = await download(immutableUrl(commit, path));
        if (actual.length !== expected.byteLength || sha256(actual) !== expected.sha256) {
          throw new Error('RULE_WRITE_PENDING: committed HTTPS readback differs');
        }
      });
    }
  }
  await finishDelivery(session, pending, stable);
}

export async function deliverRuleVersion(session: RulesSession, rule: ManagedRule, candidate: RuleCandidate,
  kind: 'sync' | 'pin', current?: RuleDelivery) {
  session.loaded.progress('prepare-delivery', rule.definition.id);
  const verified = await verifyRuleCandidate(session, candidate, rulesBinary(session.loaded.context));
  const qualification = kind === 'sync' ? qualifiedRuleCandidate(rule, candidate, verified) : undefined;
  if (kind === 'sync' && !qualification) throw new Error('CANDIDATE_UNAVAILABLE: incomplete input or build qualification');
  const subscription = ruleSubscription(session, rule, current);
  const stable = await session.stable();
  const observed = await ensureRulePathAvailable(session, rule.definition, stable);
  if (!isDeepStrictEqual(observed, current)) throw new Error('RULE_WRITE_CONFLICT: current delivery changed before registration');
  const files = candidateStableFiles(verified, subscription, rule.definition, session.loaded.context.targetBranch);
  const id = randomUUID();
  const record: RuleDelivery = { schemaVersion: 2, id, logicalId: rule.definition.id, candidateId: candidate.id,
    versionId: candidate.versionId, publishedAt: candidate.publishedAt, candidateEvidenceUrl: candidate.evidenceUrl!,
    source: candidate.source, subscription, files: evidenceFor(files) as Record<string, FileEvidence> };
  files[ruleDeliveryRecordPath(rule.definition)] = encodeRecord(record);
  session.journal.pendingDelivery = { id, kind, logicalId: rule.definition.id, configurationRevision: session.loaded.observed.revision,
    stableHead: stable.head, afterRule: rule, record, changes: evidenceFor(files), removeCandidates: [],
    ...(qualification && { qualifiedCandidate: qualification }) };
  const registrationCommit = await session.save();
  await recoverRuleDelivery(session, registrationCommit);
  return record;
}

export async function deleteRuleDelivery(session: RulesSession, rule: ManagedRule, current?: RuleDelivery) {
  const id = rule.definition.id;
  const quarantined = Object.values(session.journal.quarantinedCandidates ?? {});
  if (quarantined.some(candidate => !candidate.logicalId)) throw new Error('RULE_MIGRATION_PENDING: candidate ownership must be established before deletion');
  const stable = await session.stable();
  const deletion = await observedDeletion(session, id, stable);
  if (!isDeepStrictEqual(deletion.record, current)) throw new Error('RULE_WRITE_CONFLICT: current delivery changed before deletion');
  const files: RuleWrites = Object.fromEntries(deletion.paths.map(path => [path, null]));
  const removeCandidates = [...Object.values(session.journal.candidates), ...quarantined].filter(candidate => candidate.logicalId === id).map(candidate => candidate.id);
  const afterRule: ManagedRule = { ...rule, lifecycle: 'deleted', control: { mode: 'auto', revision: randomUUID(), inputBindingRevision: rule.inputBindingRevision } };
  delete afterRule.lastFailure;
  delete afterRule.successfulInput;
  session.journal.pendingDelivery = { id: randomUUID(), kind: 'delete', logicalId: id,
    configurationRevision: session.loaded.observed.revision, stableHead: stable.head, afterRule,
    changes: evidenceFor(files), removeCandidates };
  const registrationCommit = await session.save();
  await recoverRuleDelivery(session, registrationCommit);
}

/** Read-only interpretation of a committed write whose final checkpoint is pending. */
export async function observedRule(session: RulesSession, id: string, stable: PublicationSnapshot) {
  const pending = session.journal.pendingDelivery;
  if (pending?.logicalId === id && await receiptMatches(stable, pending.id)) return pending.afterRule;
  return Object.hasOwn(session.journal.rules, id) ? session.journal.rules[id] : undefined;
}
