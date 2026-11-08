import { isDeepStrictEqual } from 'node:util';
import { candidateFiles } from './candidate-publication.js';
import { verifyActivationCandidate } from './activation.js';
import type { RuleDefinition } from './configured-build.js';
import { retainedCandidateDownload, type PublicationSnapshot } from './publication-repository.js';
import type { PublicationTransport } from './publication.js';
import { sha256 } from './release.js';
import type { CommitSourceRecord } from './github-commit.js';
import type { SourceRecord } from './types.js';
import type { Candidate } from './update.js';

/** Recover evidence only after proving the candidate is retained and usable now. */
export async function verifyRetainedCandidate(options: {
  candidate: Candidate | undefined; source: SourceRecord | CommitSourceRecord | undefined; snapshot: PublicationSnapshot;
  publication: PublicationTransport; binary: string; targetBranch: string; definition?: RuleDefinition; allowEvidence?: boolean;
}) {
  const { candidate, snapshot, publication } = options;
  if (!candidate?.retained || !candidate.evidenceUrl || (candidate.phase !== 'complete' && !(options.allowEvidence && candidate.phase === 'evidence'))
    || candidateFiles(candidate.definition).some(file => !snapshot.paths.includes(`candidates/${candidate.id}/${file}`))) {
    throw new Error('CANDIDATE_UNAVAILABLE: fixed source no longer has a retained candidate');
  }
  const download = retainedCandidateDownload(snapshot, candidate.id, url => publication.download(url));
  const verified = await verifyActivationCandidate({ candidateEvidenceUrl: candidate.evidenceUrl, binary: options.binary, evidenceSha256: candidate.evidenceSha256 }, {
    branch: options.targetBranch, download,
  }, options.definition);
  if (!isDeepStrictEqual(verified.source, options.source) || verified.validation.buildId !== candidate.buildId) {
    throw new Error('RECOVERY_BUILD_CHANGED: registered source or build differs');
  }
  const bytes = await download(candidate.evidenceUrl);
  const evidence = JSON.parse(bytes.toString());
  const readback: { url: string; sha256: string; byteLength: number; exactBytes: true }[] =
    [...evidence.readback, { url: candidate.evidenceUrl, sha256: sha256(bytes), byteLength: bytes.length, exactBytes: true }];
  return { verified, readback };
}
