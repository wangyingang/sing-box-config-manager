import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { activateAutomatically, activationSubscription, verifyActivationCandidate } from './activation.js';
import { githubActivation, type ActivationTransport } from './activation-transport.js';
import { verifyRetainedCandidate } from './candidate-recovery.js';
import { buildConfiguredRelease, configuredBuildTools, parseBuildConfiguration, type RuleDefinition } from './configured-build.js';
import { publishConfiguredCandidate, type ConfiguredUpdateOptions } from './configured-update.js';
import { readActivationOperationResults, type ObservedActivation } from './manual-activation.js';
import { inspectBinary } from './native.js';
import { githubPublication } from './publication.js';
import { retainedCandidateDownload, type PublicationSnapshot } from './publication-repository.js';
import { sha256 } from './release.js';
import { openRemoteSession } from './remote-state.js';
import { activationRecord, readRemoteStatus, verifyStableFiles } from './remote-status.js';
import type { Candidate, UpdateState } from './update.js';

export interface CheckOptions extends Omit<ConfiguredUpdateOptions, 'sampleTag' | 'retryRelease'> {
  /** Trusted, complete v2 Rule Subscription for each selected logical ID. */
  subscriptions: Record<string, unknown>;
  activation?: ActivationTransport;
}

type CheckStatus = 'activated' | 'unchanged' | 'paused' | 'failed' | 'verification-pending';
export interface CheckRecord {
  operationId: string; status: CheckStatus; checkedAt: string;
  releaseId?: number; tag?: string; candidateId?: string; error?: string;
}
type Active = ObservedActivation & {
  subscription: unknown;
  control?: { revision: string; reason: string; pauseAutomaticActivation: boolean; pauseAutomaticRetry: boolean };
  source: { releaseId?: number; tag?: string };
  validation: { buildId: string; tool: { sha256: string } };
  operation?: string;
  history: { commit: string; id: string; candidateId: string }[];
};
type Delivery = { id: string; candidateId: string; releaseId?: number; tag?: string; commit?: string; containingCommit?: string };
type CheckResult = CheckRecord & { id: string; current?: Delivery; lastObserved?: Delivery;
  control?: Active['control']; pendingOperation?: { id: string; status: string; commit?: string; containingCommit?: string };
  rollbackTargets?: { commit: string; id: string; candidateId: string }[] };
type Built = Awaited<ReturnType<typeof buildConfiguredRelease>>;
type SuccessfulBuild = Extract<Built['results'][number], { status: 'built-validated' }>;
type CheckOperation = NonNullable<UpdateState['pendingOperation']>;
const recordPath = (definition: RuleDefinition) => `${definition.stablePath}/activation.json`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const uncertain = (error: unknown) => /PUBLICATION_PENDING|ACTIVATION_(UNKNOWN|APPLIED_READBACK_PENDING|CONFLICT_OR_SUPERSEDED)/.test(message(error));

async function readActive(snapshot: PublicationSnapshot, definition: RuleDefinition, branch: string) {
  const path = recordPath(definition);
  const bytes = await snapshot.read(path);
  if (!bytes) return undefined;
  const { record } = activationRecord(JSON.parse(bytes.toString()), path, branch);
  if (record.logicalId !== definition.id) throw new Error('Stable directory belongs to another logical ID');
  await verifyStableFiles(record, file => snapshot.read(file));
  return record as Active;
}

function delivery(active: Active): Delivery {
  return { id: active.id, candidateId: active.candidateId, releaseId: active.source?.releaseId, tag: active.source?.tag };
}

async function readRetainedBuild(snapshot: PublicationSnapshot, candidateId: string, buildId: string | undefined) {
  const bytes = await snapshot.read(`candidates/${candidateId}/build.json`);
  const build = bytes && JSON.parse(bytes.toString());
  if (!build || build.buildId !== buildId || build.candidateId !== candidateId) {
    throw new Error('CANDIDATE_UNAVAILABLE: retained build identity is missing or inconsistent');
  }
  return build;
}

async function sameDelivery(result: SuccessfulBuild, built: Built, active: Active, snapshot: PublicationSnapshot,
  publication: NonNullable<CheckOptions['publication']>, binary: string) {
  if (active.validation?.tool?.sha256 !== result.native.tool.sha256) return false;
  // Old builds can use a different projection implementation. Establish
  // comparability before attempting to reproduce their bytes with today's tools.
  const previous = await readRetainedBuild(snapshot, active.candidateId, active.validation.buildId);
  if (previous.tool?.sha256 !== result.native.tool.sha256 || !isDeepStrictEqual(previous.definition, result.definition)
    || !isDeepStrictEqual(previous.tools, built.tools)) return false;
  const retained = retainedCandidateDownload(snapshot, active.candidateId, url => publication.download(url));
  const candidate = await verifyActivationCandidate({ candidateEvidenceUrl: active.candidateEvidenceUrl, binary },
    { branch: built.configuration.target.branch, download: retained }, result.definition, 'rollback');
  if (candidate.build.tool.sha256 !== result.native.tool.sha256
    || !isDeepStrictEqual(candidate.build.definition, result.definition) || !isDeepStrictEqual(candidate.build.tools, built.tools)) return false;
  if (!result.native.artifacts.every(artifact => artifact.content.equals(candidate.bytesByFormat[artifact.format]))) return false;
  const filenames = new Map(candidate.manifest.artifacts.map((artifact: { id: string; format: string }) =>
    [artifact.id, artifact.format === 'source' ? 'domains.json' : 'domains.srs']));
  for (const [usage, projection] of Object.entries(result.native.usages)) {
    const previous = candidate.manifest.projections[usage];
    if ('artifactFiles' in projection) {
      if (!Array.isArray(previous.artifactIds) || !isDeepStrictEqual([...projection.artifactFiles].sort(),
        previous.artifactIds.map((id: string) => filenames.get(id)).sort())) return false;
    } else if (previous.unavailable !== 'empty') return false;
  }
  for (const [path, file] of Object.entries(active.files)) {
    const artifact = result.native.artifacts.find(entry => path === `${result.definition.stablePath}/${entry.file}`);
    if (!artifact || artifact.sha256 !== file.sha256 || artifact.bytes !== file.byteLength) return false;
  }
  return true;
}

/** Check the configured sets against one official Release and activate verified changes. */
export async function checkRules(options: CheckOptions) {
  const configuration = parseBuildConfiguration(options.configuration);
  const ids = options.selectedIds ?? configuration.ruleSets.map(rule => rule.id);
  const definitions = configuration.ruleSets.filter(rule => ids.includes(rule.id));
  if (!definitions.length || definitions.length !== ids.length) throw new Error('Selected logical ID is duplicate or unknown');
  const { branch } = configuration.target;
  const publication = options.publication ?? githubPublication(undefined, branch === 'main' ? 'candidates' : branch);
  const activation = options.activation ?? githubActivation(branch);
  const repository = publication.repository;
  if (!repository || activation.branch !== branch || activation.repository?.branch !== repository.branch) {
    throw new Error('Check requires matching remote publication and activation targets');
  }

  await mkdir(options.stateDirectory, { recursive: true });
  const lock = join(options.stateDirectory, 'update.lock');
  await mkdir(lock);
  try {
    return await runCheck();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }

  async function runCheck() {
    const repo = repository!;
    const shared = repo.branch === branch;
    let stableHead: string;
    const guardStable = async () => {
      if (!shared && await activation.head() !== stableHead) throw new Error('PUBLICATION_CONFLICT: stable head changed');
    };
    const session = await openRemoteSession(publication, options.stateDirectory, branch, guardStable);
    const { state, journal } = session;
    const stable = shared ? session.snapshot : await repo.snapshot(branch);
    stableHead = stable.head;
    const expectedStableHead = () => shared ? session.head : stableHead;
    const activeById = new Map<string, Active>();
    const errors = new Map<string, string>();
    const paths = new Set(definitions.map(recordPath));
    const stableIdentities = new Map<string, string>();
    for (const path of stable.paths.filter(path => path.endsWith('/activation.json'))) {
      try {
        const bytes = await stable.read(path);
        const id = bytes && JSON.parse(bytes.toString()).logicalId;
        if (typeof id === 'string') stableIdentities.set(id, path);
      } catch {
        // readActive reports corruption for the configured owner. A sibling
        // with a different stable directory can still proceed.
      }
    }
    const subscriptionHashes = Object.fromEntries(definitions.map(rule => [rule.id, sha256(JSON.stringify(options.subscriptions[rule.id]) ?? '')]));
    for (const rule of definitions) {
      try {
        const active = await readActive(stable, rule, branch);
        if (active) activeById.set(rule.id, active);
        else if (stableIdentities.has(rule.id)) throw new Error('Existing stable path cannot change during check');
        if (active?.control?.pauseAutomaticRetry) continue;
        const subscription = activationSubscription(options.subscriptions[rule.id], branch, rule);
        if (active && !isDeepStrictEqual(active.subscription, subscription)) throw new Error('Existing subscription contract cannot change during check');
      } catch (error) {
        if (!activeById.has(rule.id)) paths.delete(recordPath(rule));
        errors.set(rule.id, message(error));
      }
    }

    let operation = state.pendingOperation?.status === 'pending' ? state.pendingOperation : undefined;
    if (operation && (operation.kind !== 'check' || !operation.configuration
      || !isDeepStrictEqual(parseBuildConfiguration(operation.configuration), configuration)
      || !isDeepStrictEqual(operation.selectedIds, definitions.map(rule => rule.id))
      || !isDeepStrictEqual(operation.subscriptionHashes, subscriptionHashes))) {
      throw new Error('RECOVERY_REQUEST_MISMATCH: resume the registered operation with its original configuration, subscriptions and selection');
    }
    const operationId = operation?.id ?? randomUUID();
    const checkedAt = new Date().toISOString();
    const results = new Map<string, CheckRecord>();
    const latestChecks = state.latestChecks ??= {};
    const record = (id: string, status: CheckStatus, fields: Partial<CheckRecord> = {}) => {
      const value = { operationId, checkedAt, status, ...fields };
      latestChecks[id] = value;
      results.set(id, value);
    };
    const knownApplied = new Map<string, string>();
    const report = async (failure?: unknown) => {
      let remoteStatus: Awaited<ReturnType<typeof readRemoteStatus>> | undefined;
      let statusError: string | undefined;
      try {
        remoteStatus = await readRemoteStatus({ repository: repo, publication, activation, recordPaths: paths });
      } catch (error) { statusError = message(error); }
      let reconciledSwitch = false;
      const ordered = definitions.map(rule => {
        const { id } = rule;
        const entry = results.get(id) ?? {
          operationId, checkedAt, status: uncertain(failure) ? 'verification-pending' as const : 'failed' as const,
          ...(operation ? { releaseId: operation.releaseId, tag: operation.tag } : {}), error: message(failure),
        };
        const observed = activeById.get(id);
        const remote = remoteStatus?.activeRuleVersions[id];
        const current = remoteStatus ? remote?.activation as Active | undefined : knownApplied.has(id) ? observed : undefined;
        const automatic = remoteStatus?.automaticOperations.find(value => value.id === current?.id);
        const pending = remoteStatus?.pendingOperations.find(value => value.logicalId === id
          && ['activated-readback-pending', 'activated-verification-pending', 'automatic-commit-pending', 'manual-commit-pending'].includes(value.status));
        const pendingSwitch = pending && (remoteStatus?.automaticOperations.find(value => value.id === pending.id)
          ?? remoteStatus?.manualOperations.find(value => value.id === pending.id));
        const result: CheckResult = { id, ...entry };
        if (current) {
          result.current = { ...delivery(current), commit: automatic?.commit ?? knownApplied.get(id),
            containingCommit: automatic?.containingCommit ?? remote?.commit };
          result.control = current.control;
        } else if (statusError && observed) result.lastObserved = delivery(observed);
        if (pending) {
          result.pendingOperation = { id: pending.id, status: pending.status, commit: pendingSwitch?.commit,
            containingCommit: pendingSwitch?.containingCommit };
          if (result.status !== 'failed') {
            result.status = 'verification-pending';
            result.error ??= pending.error ?? pending.status;
          }
        } else if (automatic?.status === 'committed' && automatic.checkOperationId === operationId
          && automatic.candidateId === entry.candidateId && entry.status === 'verification-pending'
          && /ACTIVATION_(UNKNOWN|APPLIED_READBACK_PENDING|CONFLICT_OR_SUPERSEDED)/.test(entry.error ?? '')) {
          result.status = 'activated';
          delete result.error;
          reconciledSwitch = true;
        }
        if (remoteStatus && paths.has(recordPath(rule))) result.rollbackTargets = remoteStatus.rollbackTargets[id] ?? [];
        return result;
      });
      const switchFailureReconciled = reconciledSwitch
        && /ACTIVATION_(UNKNOWN|APPLIED_READBACK_PENDING|CONFLICT_OR_SUPERSEDED)/.test(message(failure));
      const unresolvedFailure = switchFailureReconciled ? undefined : failure;
      return { exitCode: unresolvedFailure || statusError || ordered.some(result => result.status === 'failed' || result.status === 'verification-pending') ? 1 : 0,
        ...(operation ? { releaseId: operation.releaseId, tag: operation.tag } : {}), results: ordered,
        ...(unresolvedFailure ? { error: message(unresolvedFailure) } : {}), ...(statusError ? { statusError } : {}),
        ...(session.cacheWarning ? { cacheWarning: session.cacheWarning } : {}) };
    };

    // A dual-branch switch that can still reach its parent must be resolved before
    // any check writes. A shared-branch journal write can fence an unknown switch.
    const allSwitches = [...Object.values(journal.manualOperations ?? {}), ...Object.values(journal.automaticOperations ?? {})];
    const unfenced = allSwitches.filter(entry => !entry.notCommitted && entry.generation === session.generation
      && (shared ? stable.parent === entry.expectedHead : stable.head === entry.expectedHead)
      && (entry.logicalId === undefined || activeById.get(entry.logicalId)?.id !== entry.id));
    if (unfenced.length) {
      try { if (shared) await session.save(); }
      catch (error) { return report(error); }
      return report(new Error('ACTIVATION_UNKNOWN: a registered switch must be reconciled before this check can write'));
    }

    for (const rule of definitions) {
      const { id } = rule;
      const active = activeById.get(id);
      const currentRevision = active?.control?.revision ?? null;
      if (errors.has(id)) record(id, 'failed', { error: errors.get(id) });
      else if (active?.control?.pauseAutomaticRetry) record(id, 'paused');
      else if (operation && operation.controlRevisions![id] !== currentRevision) {
        if (active?.control?.pauseAutomaticActivation) record(id, 'paused');
        else record(id, 'failed', { error: 'PUBLICATION_CONFLICT: control revision changed since registration' });
      } else if (operation && latestChecks[id]?.operationId === operationId && latestChecks[id].status !== 'verification-pending') {
        results.set(id, latestChecks[id]);
      }
    }
    if (operation) {
      const recovery = operation;
      for (const rule of definitions.filter(({ id }) => !results.has(id))) {
        const active = activeById.get(rule.id);
        const pendingSwitch = allSwitches.find(entry => entry.kind === 'automatic' && entry.checkOperationId === operationId && entry.id === active?.id);
        if (!active || !pendingSwitch) continue;
        const [outcome] = await readActivationOperationResults(repo, journal, stable,
          new Map([[recordPath(rule), active]]), url => activation.download(url), [pendingSwitch]);
        record(rule.id, outcome.status === 'committed' ? 'activated' : 'verification-pending', {
          releaseId: recovery.releaseId, tag: recovery.tag, candidateId: active.candidateId,
          ...(outcome.error ? { error: outcome.error } : {}),
        });
      }
    }
    const remaining = definitions.filter(rule => !results.has(rule.id));
    const abandonIncomplete = (id: string) => {
      for (const candidate of Object.values(state.candidates)) {
        if (candidate.operationId === operation?.id && candidate.logicalId === id && candidate.phase !== 'complete') candidate.retained = false;
      }
    };
    if (!remaining.length) {
      if (operation) {
        for (const rule of definitions) abandonIncomplete(rule.id);
        if (![...results.values()].some(entry => entry.status === 'verification-pending')) operation.status = 'complete';
      }
      try { await session.save(); }
      catch (error) { results.clear(); return report(error); }
      return report();
    }

    const readyCandidates = remaining.flatMap(definition => {
      const candidate = Object.values(state.candidates).find(entry => entry.operationId === operation?.id
        && entry.logicalId === definition.id && entry.retained && (entry.phase === 'evidence' || entry.phase === 'complete'));
      return candidate ? [{ id: definition.id, definition, candidate }] : [];
    });
    let built: Built | undefined;
    try {
      if (readyCandidates.length !== remaining.length) built = await buildLatestOrPinned();
    } catch (error) {
      if (/PUBLICATION_(PENDING|CONFLICT)/.test(message(error))) return report(error);
      const fields = operation ? { releaseId: operation.releaseId, tag: operation.tag } : {};
      for (const { id } of remaining) record(id, 'failed', { ...fields, error: message(error) });
      if (operation) {
        for (const rule of definitions) abandonIncomplete(rule.id);
        if (![...results.values()].some(entry => entry.status === 'verification-pending')) operation.status = 'complete';
      }
      try { await session.save(); }
      catch (checkpoint) { return report(checkpoint); }
      return report();
    }

    async function buildLatestOrPinned() {
      const fetcher = options.fetch ?? fetch;
      const response = await fetcher(`https://api.github.com/repos/v2fly/domain-list-community/releases/${operation?.releaseId ?? 'latest'}`, {
        headers: { Accept: 'application/vnd.github+json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Release lookup HTTP ${response.status}`);
      const release = await response.json() as Record<string, unknown>;
      const { id: releaseId, tag_name: tag } = release;
      if (typeof releaseId !== 'number' || !Number.isSafeInteger(releaseId) || releaseId <= 0
        || typeof tag !== 'string' || !/^[0-9]{14}$/.test(tag)
        || operation && (operation.releaseId !== releaseId || operation.tag !== tag)
        || Object.values(state.pinned).some(pin => pin.identity?.tag === tag && pin.identity.releaseId !== releaseId)) {
        throw new Error('SOURCE_CHANGED: official Release identity changed or is invalid');
      }
      const pin = state.pinned[String(releaseId)] ?? {};
      return buildConfiguredRelease({ configuration: options.configuration, binary: options.binary,
        selectedIds: remaining.map(rule => rule.id),
        release: { tag, releaseMetadata: release, fetch: fetcher, token: options.token, expectedSource: pin.source,
          onPinned: async identity => {
            if (pin.identity && !isDeepStrictEqual(pin.identity, identity)) throw new Error('SOURCE_CHANGED: pinned Release identity changed');
            pin.identity = identity;
            state.pinned[String(releaseId)] = pin;
            if (!operation) {
              const controlRevisions = Object.fromEntries(definitions.map(({ id }) => [id, activeById.get(id)?.control?.revision ?? null]));
              state.pendingOperation = operation = { id: operationId, kind: 'check', generation: session.generation,
                releaseId, tag, status: 'pending', expectedHead: session.head, candidateIds: [], configuration: options.configuration,
                selectedIds: definitions.map(rule => rule.id), controlRevisions, subscriptionHashes };
            }
            await session.save();
          },
          onSource: async source => { pin.source = source; await session.save(); },
        } });
    }

    const release = { releaseId: operation!.releaseId, tag: operation!.tag };
    const verify = (candidate: Candidate, definition: RuleDefinition) => verifyRetainedCandidate({
      candidate, source: state.pinned[String(release.releaseId)]?.source, snapshot: session.snapshot, publication,
      binary: options.binary, targetBranch: branch, definition, allowEvidence: true,
    });
    const checkTools = built?.tools ?? await configuredBuildTools();
    for (const result of built?.results ?? readyCandidates) {
      const { id, definition } = result;
      let candidate: Candidate | undefined;
      try {
        const active = activeById.get(id);
        if ('candidate' in result) {
          candidate = result.candidate;
          const previous = await readRetainedBuild(session.snapshot, candidate.id, candidate.buildId);
          if (!isDeepStrictEqual(previous.tools, checkTools) || previous.tool?.sha256 !== (await inspectBinary(options.binary)).sha256) {
            throw new Error('RECOVERY_BUILD_CHANGED: original tool and build identity required');
          }
          await verify(candidate, definition);
        } else {
          if (result.status === 'failed') throw new Error(`${result.error}: ${JSON.stringify(result.report.diagnostics)}`);
          if (active && await sameDelivery(result, built!, active, session.snapshot, publication, options.binary)) {
            abandonIncomplete(id);
            record(id, active.control?.pauseAutomaticActivation ? 'paused' : 'unchanged', release);
            await session.save();
            continue;
          }
          candidate = Object.values(state.candidates).find(entry => entry.operationId === operationId && entry.logicalId === id && entry.retained)
            ?? Object.values(state.candidates).find(entry =>
              entry.retained && entry.phase === 'complete' && entry.status === 'verified' && entry.logicalId === id && entry.buildId === result.buildId);
          if (candidate?.buildId && candidate.buildId !== result.buildId) throw new Error('RECOVERY_BUILD_CHANGED: original tool and build identity required');
          if (!candidate) {
            candidate = { id: randomUUID(), logicalId: id, ...release, status: 'building', operation: 'update',
              generation: session.generation, phase: 'registered', retained: true, definition, targetBranch: branch, operationId };
            state.candidates[candidate.id] = candidate;
            operation!.candidateIds.push(candidate.id);
            await session.save();
          }
          if (candidate.phase === 'evidence' || candidate.phase === 'complete') await verify(candidate, definition);
          else {
            candidate.buildId = result.buildId;
            await publishConfiguredCandidate(result, candidate, built!.source, checkTools, configuration.target, session.publication, options.binary, session.save);
          }
        }
        candidate.phase = 'complete'; candidate.status = 'verified'; delete candidate.error;
        const processed = state.configuredProcessed ??= {};
        if (!Object.hasOwn(processed, id)) processed[id] = {};
        processed[id][String(release.releaseId)] = { candidateId: candidate.id, tag: release.tag, evidenceUrl: candidate.evidenceUrl!,
          definitionSha256: sha256(JSON.stringify({ definition, target: configuration.target })) };
        await session.save();
        if (active?.control?.pauseAutomaticActivation) {
          record(id, 'paused', { ...release, candidateId: candidate.id });
        } else {
          await activateAutomatically({ configuration: options.configuration, logicalId: id, subscription: options.subscriptions[id],
            candidateEvidenceUrl: candidate.evidenceUrl!, binary: options.binary, expectedHead: expectedStableHead(), transport: activation }, {
            journalHead: session.head,
            async register(entry) {
              entry.checkOperationId = operationId;
              (journal.automaticOperations ??= {})[entry.id] = entry;
              await session.save();
              return { expectedHead: expectedStableHead(), write: { operationId: entry.id, journalHead: session.head },
                async markNotCommitted() { entry.notCommitted = true; await session.save(); } };
            },
            applied(parent, commit, current) {
              session.acceptStableCommit(parent, commit);
              stableHead = commit;
              knownApplied.set(id, commit);
              activeById.set(id, activationRecord(current, recordPath(definition), branch).record as Active);
            },
          });
          record(id, 'activated', { ...release, candidateId: candidate.id });
        }
        await session.save();
      } catch (error) {
        const coordinationStopped = /PUBLICATION_(PENDING|CONFLICT)|ACTIVATION_(UNKNOWN|CONFLICT_OR_SUPERSEDED)/.test(message(error));
        if (results.get(id)?.status === 'activated') {
          if (coordinationStopped) return report(error);
          // A definite checkpoint failure does not undo a verified switch.
          // The next guarded save can include the same check outcome.
          continue;
        }
        const pending = uncertain(error) || candidate?.phase === 'evidence' && !/^(RECOVERY_BUILD_CHANGED|CANDIDATE_UNAVAILABLE)/.test(message(error));
        record(id, pending ? 'verification-pending' : 'failed', { ...release, error: message(error),
          ...(candidate ? { candidateId: candidate.id } : {}) });
        if (coordinationStopped) return report(error);
        if (!pending) abandonIncomplete(id);
        try { await session.save(); }
        catch (checkpoint) { return report(checkpoint); }
      }
    }
    for (const { id } of definitions) if (results.get(id)?.status === 'failed' || results.get(id)?.status === 'paused') abandonIncomplete(id);
    if (![...results.values()].some(result => result.status === 'verification-pending')) operation!.status = 'complete';
    try { await session.save(); }
    catch (error) {
      return report(error);
    }
    return report();
  }
}
