import { isDeepStrictEqual } from 'node:util';
import type { PublicationCandidate } from './candidate-publication.js';
import type { BuildConfiguration, RuleDefinition, SourceInput } from './configuration.js';
import { parseStoredRuleDefinition, parseSource } from './configuration.js';
import { validCommitSource, type CommitSourceRecord } from './github-commit.js';
import { validFixedUrlSource, type FixedUrlSource } from './fixed-url-source.js';
import type { SourceRecord } from './types.js';
import { validOpenAiVoiceSource, type OpenAiVoiceSource } from './openai-voice-source.js';
import { sha256 } from './release.js';
import { validReleaseSource } from './release-source-fact.js';
import type { CleanupCheckpoint, CleanupReport, CleanupRun, LastCleanup } from './rules-cleanup-model.js';
import { validateCleanupFields } from './rules-cleanup-model.js';

export const RULE_STATE_PATH = 'pipeline/state.json';
export const RULE_RECEIPT_PATH = 'pipeline/rule-operation.json';
export const encodeRecord = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export type RuleSource = SourceRecord | CommitSourceRecord | OpenAiVoiceSource | FixedUrlSource;
export type RuleControl = { mode: 'auto'; revision: string; inputBindingRevision: string }
  | { mode: 'pinned'; revision: string; inputBindingRevision: string; candidateId: string };

export interface QualifiedRuleCandidate {
  toolSha256: string;
  buildToolsSha256: string;
  validationPolicy: string;
  nativeBuildId: string;
  candidateId: string;
  buildId: string;
}

export interface SuccessfulRuleInput extends QualifiedRuleCandidate {
  source: RuleSource;
  inputBindingRevision: string;
  definitionRevision: string;
  definitionGeneration: string;
}

export interface ManagedRule {
  definition: RuleDefinition;
  source: SourceInput;
  inputBindingRevision: string;
  definitionRevision: string;
  configurationRevision: string;
  generation: string;
  lifecycle: 'present' | 'deleting' | 'deleted';
  control: RuleControl;
  lastFailure?: string;
  successfulInput?: SuccessfulRuleInput;
}

export interface RuleCandidate extends PublicationCandidate {
  logicalId: string;
  definition: RuleDefinition;
  sourceInput: SourceInput;
  inputBindingRevision: string;
  definitionGeneration: string;
  controlRevision?: string;
  source: RuleSource;
  buildId: string;
  operation: 'sync' | 'migration';
  publishedAt?: string;
  versionId?: string;
  evidenceSha256?: string;
  error?: string;
  migrationPending?: string;
}

export type FileEvidence = { sha256: string; byteLength: number };
export interface RuleDelivery {
  schemaVersion: 2;
  id: string;
  logicalId: string;
  candidateId: string;
  versionId?: string;
  publishedAt?: string;
  candidateEvidenceUrl: string;
  source: RuleSource;
  subscription: unknown;
  files: Record<string, FileEvidence>;
}

/** A single registered stable write. Other writers reconcile it before proceeding. */
export interface PendingDelivery {
  id: string;
  kind: 'sync' | 'pin' | 'delete';
  logicalId: string;
  configurationRevision: string;
  stableHead: string;
  afterRule: ManagedRule;
  record?: RuleDelivery;
  /** Build proof recorded at preparation. It becomes a successful input only after stable readback. */
  qualifiedCandidate?: QualifiedRuleCandidate;
  changes: Record<string, FileEvidence | null>;
  removeCandidates: string[];
}

export interface QuarantinedRuleCandidate {
  id: string;
  /** Present only when the original logical owner and definition are established. */
  logicalId?: string;
  reason: string;
}

export interface RulesJournal {
  schemaVersion: 2;
  id: string;
  generation: number;
  maintenance: 'open' | 'maintenance';
  targetBranch: string;
  rules: Record<string, ManagedRule>;
  candidates: Record<string, RuleCandidate>;
  quarantinedCandidates?: Record<string, QuarantinedRuleCandidate>;
  pendingDelivery?: PendingDelivery;
  /** A completed deletion left content reachable in managed history. */
  deletedHistoryPending?: true;
  cleanupRun?: CleanupRun;
  cleanupCheckpoint?: CleanupCheckpoint;
  lastCleanup?: LastCleanup;
  writeId?: string;
}

export type RuleOutcome = 'delivered' | 'unchanged' | 'pinned-skipped' | 'pinned' | 'resumed' | 'deleted'
  | 'failed' | 'pending' | 'superseded' | 'planned';
export interface RuleResult {
  id: string;
  status: RuleOutcome;
  changes?: string[];
  error?: string;
  current?: RuleDelivery;
  control?: RuleControl;
  expectedSource?: SourceInput;
  unsupportedTypeCounts?: Record<string, number>;
  candidate?: { versionId?: string; publishedAt?: string };
  successfulInput?: SuccessfulRuleInput;
  verified?: string[];
  reliedOn?: string[];
  unverified?: string[];
  continueWith?: string;
}
export interface RulesResult {
  operation: 'status' | 'sync' | 'pin' | 'resume' | 'cleanup';
  dryRun: boolean;
  configurationRevision: string;
  configurationOrigin: string;
  target: BuildConfiguration['target'];
  status: 'success' | 'partial' | 'failed' | 'pending' | 'disabled';
  exitCode: 0 | 1;
  results: RuleResult[];
  /** Actual Raw HTTP requests initiated by this operation, including unsuccessful attempts. */
  readbackRequests?: string[];
  observedHeads?: { journal: string; stable: string };
  error?: string;
  cleanup?: CleanupReport;
}

/** Only resolved input semantics participate; aliases and upstream revisions do not. */
export function inputBindingRevision(source: SourceInput, definition: RuleDefinition) {
  return sha256(JSON.stringify({ source: parseSource(source), list: definition.list,
    filter: 'filter' in definition ? definition.filter : undefined }));
}

export function definitionRevision(source: SourceInput, definition: RuleDefinition) {
  const { source: _alias, ...delivery } = definition;
  return sha256(JSON.stringify({ input: inputBindingRevision(source, definition), delivery }));
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
function validQualification(value: unknown) {
  return object(value) && uuid(value.candidateId)
    && ['toolSha256', 'buildToolsSha256', 'nativeBuildId', 'buildId'].every(key => digest(value[key]))
    && typeof value.validationPolicy === 'string' && Boolean(value.validationPolicy);
}

export function validRuleSource(value: unknown, input: SourceInput, definition: RuleDefinition): value is RuleSource {
  if (!object(value)) return false;
  if (input.version === 'url') return validFixedUrlSource(value, input);
  if (input.version === 'openai-voice') return validOpenAiVoiceSource(value);
  if (input.version === 'git-branch') {
    return value.kind === 'github-commit' && validCommitSource(value as CommitSourceRecord, input)
      && ('artifact' in definition || value.inputBytes > 0);
  }
  return validReleaseSource(value, input);
}

function validSuccessfulInput(value: unknown, source: SourceInput, definition: RuleDefinition) {
  if (!object(value) || !validQualification(value) || !object(value.source) || !uuid(value.definitionGeneration)
    || !digest(value.inputBindingRevision) || !digest(value.definitionRevision)) return false;
  return validRuleSource(value.source, source, definition);
}

export function parseRulesJournal(bytes: Buffer): RulesJournal {
  const value: unknown = JSON.parse(bytes.toString());
  if (object(value) && value.schemaVersion === 1) throw new Error('RULE_STATE_MIGRATION_REQUIRED: the current native policy requires an empty artifact target');
  if (!object(value) || value.schemaVersion !== 2 || !uuid(value.id) || !Number.isSafeInteger(value.generation)
    || value.generation < 1 || !['open', 'maintenance'].includes(value.maintenance)
    || typeof value.targetBranch !== 'string' || !object(value.rules) || !object(value.candidates)) throw new Error('RULE_STATE_CORRUPT');
  for (const [id, rule] of Object.entries(value.rules)) {
    if (!object(rule) || !object(rule.control) || !uuid(rule.generation) || !uuid(rule.control.revision)
      || !['present', 'deleting', 'deleted'].includes(rule.lifecycle) || !['auto', 'pinned'].includes(rule.control.mode)
      || typeof rule.configurationRevision !== 'string' || !rule.configurationRevision) throw new Error('RULE_STATE_CORRUPT: rule');
    const source = parseSource(rule.source), definition = parseStoredRuleDefinition(rule.definition, source.input.format);
    const pinned = rule.control.mode === 'pinned' ? value.candidates[rule.control.candidateId] : undefined;
    if (definition.id !== id || inputBindingRevision(source, definition) !== rule.inputBindingRevision
      || definitionRevision(source, definition) !== rule.definitionRevision || rule.control.inputBindingRevision !== rule.inputBindingRevision
      || rule.successfulInput !== undefined && (!validSuccessfulInput(rule.successfulInput, source, definition)
        || rule.successfulInput.inputBindingRevision !== rule.inputBindingRevision || rule.successfulInput.definitionRevision !== rule.definitionRevision
        || rule.successfulInput.definitionGeneration !== rule.generation || rule.lifecycle === 'deleted')
      || rule.control.mode === 'pinned' && (!pinned || pinned.logicalId !== id || pinned.definitionGeneration !== rule.generation)) throw new Error('RULE_STATE_CORRUPT: definition or control');
  }
  if (value.quarantinedCandidates !== undefined) {
    if (!object(value.quarantinedCandidates)) throw new Error('RULE_STATE_CORRUPT: quarantine index');
    for (const [id, candidate] of Object.entries(value.quarantinedCandidates)) {
      if (!object(candidate) || !uuid(id) || candidate.id !== id || Object.hasOwn(value.candidates, id)
        || typeof candidate.reason !== 'string' || !candidate.reason
        || candidate.logicalId !== undefined && (!/^[a-z][a-z0-9-]*$/.test(candidate.logicalId)
          || !Object.hasOwn(value.rules, candidate.logicalId))) throw new Error('RULE_STATE_CORRUPT: quarantine owner');
    }
  }
  const versions = new Set<string>();
  for (const [id, candidate] of Object.entries(value.candidates)) {
    if (!object(candidate) || id !== candidate.id || !uuid(id) || !digest(candidate.buildId)
      || !uuid(candidate.definitionGeneration) || !['building', 'publishing', 'verified', 'failed'].includes(candidate.status)
      || !object(candidate.source) || !digest(candidate.inputBindingRevision)
      || candidate.operation === 'sync' && !uuid(candidate.controlRevision)) throw new Error('RULE_STATE_CORRUPT: candidate');
    const source = parseSource(candidate.sourceInput), definition = parseStoredRuleDefinition(candidate.definition, source.input.format);
    if (candidate.logicalId !== definition.id || inputBindingRevision(source, definition) !== candidate.inputBindingRevision
      || (source.version === 'url' || source.version === 'openai-voice') && !validRuleSource(candidate.source, source, definition)) throw new Error('RULE_STATE_CORRUPT: candidate binding');
    if (candidate.publishedAt !== undefined || candidate.versionId !== undefined) {
      if (typeof candidate.publishedAt !== 'string' || !Number.isFinite(Date.parse(candidate.publishedAt))
        || new Date(candidate.publishedAt).toISOString() !== candidate.publishedAt || typeof candidate.versionId !== 'string'
        || !candidate.versionId.startsWith(`${candidate.publishedAt}~`) || versions.has(candidate.versionId)) throw new Error('RULE_STATE_CORRUPT: version');
      versions.add(candidate.versionId);
    }
  }
  const pending = value.pendingDelivery;
  if (pending !== undefined && (!object(pending) || !uuid(pending.id) || !['sync', 'pin', 'delete'].includes(pending.kind)
    || !/^[a-f0-9]{40}$/.test(pending.stableHead) || !object(pending.changes) || !object(pending.afterRule)
    || !Array.isArray(pending.removeCandidates))) throw new Error('RULE_STATE_CORRUPT: pending delivery');
  const record = pending?.record;
  if (pending && pending.kind !== 'delete') {
    const definition = pending.afterRule.definition;
    const candidate = record && value.candidates[record.candidateId];
    if (!object(record) || record.schemaVersion !== 2 || record.id !== pending.id || record.logicalId !== pending.logicalId
      || !candidate || candidate.logicalId !== pending.logicalId || candidate.definitionGeneration !== pending.afterRule.generation
      || record.versionId !== candidate.versionId || record.publishedAt !== candidate.publishedAt
      || record.candidateEvidenceUrl !== candidate.evidenceUrl || !isDeepStrictEqual(record.source, candidate.source)
      || !object(definition) || definition.id !== pending.logicalId || !object(record.files)
      || pending.kind === 'pin' && (pending.afterRule.control?.mode !== 'pinned' || pending.afterRule.control.candidateId !== candidate.id)) {
      throw new Error('RULE_STATE_CORRUPT: pending delivery record');
    }
    const activationPath = `${definition.stablePath}/activation.json`;
    const activation = encodeRecord(record);
    if (!isDeepStrictEqual(pending.changes, { ...record.files, [activationPath]: { sha256: sha256(activation), byteLength: activation.length } })) {
      throw new Error('RULE_STATE_CORRUPT: pending delivery changes');
    }
  }
  const qualification = pending?.qualifiedCandidate;
  if (qualification !== undefined) {
    const candidate = record && value.candidates[record.candidateId];
    if (!validQualification(qualification) || pending.kind !== 'sync' || !candidate || candidate.status !== 'verified'
      || qualification.candidateId !== candidate.id || qualification.buildId !== candidate.buildId
      || pending.afterRule.inputBindingRevision !== candidate.inputBindingRevision
      || pending.afterRule.definitionRevision !== definitionRevision(candidate.sourceInput, candidate.definition)) {
      throw new Error('RULE_STATE_CORRUPT: pending candidate qualification');
    }
  }
  validateCleanupFields(value);
  return value as RulesJournal;
}
