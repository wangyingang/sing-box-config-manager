import { isDeepStrictEqual } from 'node:util';
import { candidateStableFiles } from './activation.js';
import { validArtifactFilename } from './artifact-path.js';
import { artifactSubscription } from './configuration.js';
import { type DeliveryReadback, readDeliveryUrl, readPublishedFile } from './delivery-readback.js';
import { fullGitCommit } from './github-commit.js';
import { ARTIFACT_REPOSITORY, immutableUrl } from './publication.js';
import type { PublicationSnapshot } from './publication-repository.js';
import { verifyRuleCandidateInSnapshot } from './rules-build.js';
import { matchesRuleDelivery } from './rules-delivery.js';
import { parseRulesJournal, RULE_STATE_PATH, type FileEvidence, type RulesJournal, type RulesResult } from './rules-model.js';
import { githubRulesRepository, type RulesRepository } from './rules-repository.js';
import type { RuleStatus } from './rules-status.js';
import { verifyStableDeliveries, type StableDeliveries } from './stable-deliveries.js';
import { ruleDeliveryRecordPath, singleArtifactPaths } from './stable-rule-paths.js';

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type Status = RulesResult & { rules: RuleStatus[]; observedHeads: { journal: string; stable: string } };
type Reader = Pick<RulesRepository, 'branch' | 'snapshot' | 'head' | 'lastChange'>;

function parseStatus(input: unknown): Status {
  requireFact(input && typeof input === 'object', 'Expected JSON status');
  let raw: unknown = input;
  if (!('operation' in input)) {
    requireFact('exitCode' in input && input.exitCode === 0 && 'results' in input && Array.isArray(input.results)
      && input.results.length === 1, 'Expected one successful status result from Actions');
    requireFact('target' in input && input.target === 'main', 'Expected a production main Actions status');
    raw = input.results[0];
  }
  const status = raw as Partial<Status> | null;
  requireFact(status?.operation === 'status' && status.status === 'success' && status.exitCode === 0 && status.dryRun === false,
    'Expected a successful rules status');
  requireFact(status.target?.repository === ARTIFACT_REPOSITORY && status.target.branch === 'main',
    'Expected a production main status for the artifact repository');
  requireFact(fullGitCommit(status.configurationRevision) && fullGitCommit(status.observedHeads?.journal) && fullGitCommit(status.observedHeads?.stable),
    'Missing configuration revision or observed Git heads');
  requireFact(Array.isArray(status.rules) && status.rules.length > 0
    && status.rules.every(rule => typeof rule?.id === 'string') && isDeepStrictEqual(status.rules, status.results),
    'Expected nonempty, consistent status rules and results');
  return status as Status;
}

interface FileCheck {
  format: 'source' | 'binary';
  path: string;
  expected: FileEvidence;
  deliveryCommit: string;
  reads: Awaited<ReturnType<typeof readPublishedFile>>;
}
interface RuleCheck {
  id: string;
  ok: boolean;
  candidateId?: string;
  versionId?: string;
  manifestUrl?: string;
  deliveryRecordPath?: string;
  files: FileCheck[];
  error?: string;
}

interface ObservedDelivery {
  journal: RulesJournal;
  candidateTree: PublicationSnapshot;
  deliveries: StableDeliveries;
  stableHead: string;
}

async function checkRule(rule: RuleStatus, observed: ObservedDelivery, reader: Reader, request: typeof fetch): Promise<RuleCheck> {
  const { journal, candidateTree, deliveries, stableHead } = observed;
  const { id, current } = rule;
  const check: RuleCheck = { id, candidateId: current?.candidateId, versionId: current?.versionId, ok: false, files: [] };
  try {
    requireFact(rule.deliveryState === 'delivered' && rule.status === 'unchanged' && rule.lifecycle === 'present'
      && rule.configurationDifference === 'none' && !rule.pendingOperation && !rule.deliveryIssue && current, 'Rule is not fully delivered');
    const managed = journal.rules[id], candidate = journal.candidates[current.candidateId];
    requireFact(managed?.lifecycle === 'present' && 'artifact' in managed.definition, 'Missing current rule definition');
    requireFact(candidate?.definitionGeneration === managed.generation
      && rule.candidates.some(c => c.id === current.candidateId && c.versionId === current.versionId && c.current && c.selectable),
      'Status does not identify a selectable current candidate');
    const recordPath = ruleDeliveryRecordPath(managed.definition);
    requireFact(deliveries.recordPaths.get(id) === recordPath && isDeepStrictEqual(current, deliveries.records.get(id)),
      'Status delivery differs from the stable Git record');
    check.deliveryRecordPath = recordPath;
    const subscription = artifactSubscription(managed.definition, journal.targetBranch);
    const urls = subscription.formats;
    requireFact(isDeepStrictEqual(subscription, current.subscription)
      && isDeepStrictEqual([...rule.stableUrls].sort(), [urls.source.url, urls.binary.url].sort()), 'Inconsistent subscription addresses');
    const verified = await verifyRuleCandidateInSnapshot(candidateTree, candidate, journal.targetBranch, reader.lastChange);
    const stableFiles = candidateStableFiles(verified, current.subscription, managed.definition, journal.targetBranch);
    requireFact(matchesRuleDelivery(current, candidate, stableFiles), 'Stable delivery differs from the verified candidate');
    check.manifestUrl = candidate.manifestUrl;
    const [json, srs] = singleArtifactPaths(managed.definition.stablePath, managed.definition.artifact);
    for (const [format, path] of [['source', json], ['binary', srs]] as const) {
      const artifact = verified.manifest.artifacts.find((item: { format: string }) => item.format === format);
      const expected = current.files[path];
      const commit = await reader.lastChange(stableHead, path);
      const reads = await readPublishedFile({ candidate: artifact.url, fixedDelivery: immutableUrl(commit, path), stable: urls[format].url }, expected, request);
      check.files.push({ format, path, expected, deliveryCommit: commit, reads });
    }
    check.ok = check.files.every(file => Object.values(file.reads).every(read => read.ok));
  } catch (error) {
    check.error = message(error);
  }
  return check;
}

interface Report {
  ok: boolean;
  target?: Status['target'];
  configurationRevision?: string;
  observedHeads?: Status['observedHeads'];
  rules: RuleCheck[];
  retired: DeliveryReadback[];
  error?: string;
}

export async function verifyDelivery(input: unknown, retired: string[], open: (branch: string) => Reader = githubRulesRepository,
  request: typeof fetch = fetch): Promise<Report> {
  const report: Report = { ok: false, rules: [], retired: [] };
  try {
    const status = parseStatus(input);
    const { target, observedHeads, configurationRevision } = status;
    Object.assign(report, { target, observedHeads, configurationRevision });
    const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${target.branch}/`;
    for (const url of retired) {
      const path = url.slice(prefix.length);
      requireFact(url.startsWith(prefix) && /^stable(?:\/[a-z0-9][a-z0-9._-]*)+\/[^/]+$/.test(path)
        && validArtifactFilename(path.slice(path.lastIndexOf('/') + 1)), `Invalid retired subscription URL: ${url}`);
    }
    const reader = open(target.branch);
    const [candidateTree, stableTree] = await Promise.all([reader.snapshot(reader.branch), reader.snapshot(target.branch)]);
    requireFact(candidateTree.head === observedHeads.journal && stableTree.head === observedHeads.stable, 'Status heads changed; obtain a fresh status');
    const journalBytes = await candidateTree.read(RULE_STATE_PATH);
    requireFact(journalBytes, 'Missing rule journal');
    const journal = parseRulesJournal(journalBytes);
    requireFact(journal.targetBranch === target.branch && !journal.pendingDelivery && journal.maintenance === 'open', 'Journal target or operation differs from status');
    const deliveries = await verifyStableDeliveries(stableTree);
    const ids = new Set([...Object.entries(journal.rules).filter(([, rule]) => rule.lifecycle !== 'deleted').map(([id]) => id), ...deliveries.records.keys()]);
    requireFact(isDeepStrictEqual(status.rules.map(rule => rule.id).sort(), [...ids].sort()), 'Status must cover every current rule exactly once');
    const observed = { journal, candidateTree, deliveries, stableHead: stableTree.head };
    for (const rule of status.rules) {
      report.rules.push(await checkRule(rule, observed, reader, request));
    }
    for (const url of retired) {
      const read = await readDeliveryUrl(url, 'retired', request);
      if (stableTree.paths.includes(url.slice(prefix.length))) {
        read.ok = false;
        read.error = 'Retired path still exists in the stable Git tree';
      }
      report.retired.push(read);
    }
    const head = (branch: string) => reader.head ? reader.head(branch) : reader.snapshot(branch).then(snapshot => snapshot.head);
    const [endJournal, endStable] = await Promise.all([head(reader.branch), head(target.branch)]);
    requireFact(endJournal === observedHeads.journal && endStable === observedHeads.stable, 'Heads changed during readback; obtain a fresh status');
    report.ok = report.rules.every(rule => rule.ok) && report.retired.every(read => read.ok);
  } catch (error) {
    report.error = message(error);
  }
  return report;
}
