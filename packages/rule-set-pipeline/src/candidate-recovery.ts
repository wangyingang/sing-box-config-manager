import { isDeepStrictEqual } from 'node:util';
import { verifyActivationCandidate } from './activation.js';
import type { RuleDefinition } from './configured-build.js';
import type { PublicationSnapshot } from './publication-repository.js';
import type { PublicationTransport } from './publication.js';
import { sha256 } from './release.js';
import type { SourceRecord } from './types.js';
import type { Candidate } from './update.js';

/** Recover evidence only after proving the candidate is retained and usable now. */
export async function verifyRetainedCandidate(options: {
  candidate: Candidate | undefined; source: SourceRecord | undefined; snapshot: PublicationSnapshot;
  publication: PublicationTransport; binary: string; targetBranch: string; definition?: RuleDefinition; allowEvidence?: boolean;
}) {
  const { candidate, snapshot, publication } = options;
  if (!candidate?.retained || !candidate.evidenceUrl || (candidate.phase !== 'complete' && !(options.allowEvidence && candidate.phase === 'evidence'))
    || ['domains.json', 'domains.srs', 'manifest.json', 'source.json', 'conversion-report.json', 'build.json', 'readback.json']
      .some(file => !snapshot.paths.includes(`candidates/${candidate.id}/${file}`))) {
    throw new Error('CANDIDATE_UNAVAILABLE: processed Release no longer has a retained candidate');
  }
  const download = async (url: string) => {
    const bytes = await publication.download(url);
    const path = new URL(url).pathname.split('/').slice(4).join('/');
    const retained = path.startsWith(`candidates/${candidate.id}/`) ? await snapshot.read(path) : undefined;
    if (!retained?.equals(bytes)) throw new Error('CANDIDATE_UNAVAILABLE: immutable address differs from retained candidate');
    return bytes;
  };
  const verified = await verifyActivationCandidate({ candidateEvidenceUrl: candidate.evidenceUrl, binary: options.binary }, {
    branch: options.targetBranch, download, head: async () => snapshot.head,
    commit: async () => { throw new Error('Candidate verification is read-only'); },
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
