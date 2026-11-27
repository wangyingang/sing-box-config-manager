import type { SourceInput } from './configuration.js';
import { readFixedUrlInput, validFixedUrlSource, verifyFixedUrlSnapshot } from './fixed-url-source.js';
import { validCommitSource, type CommitSourceRecord } from './github-commit.js';
import { probeCommitInput, readPinnedCommitInput } from './git-input-probe.js';
import { OPENAI_VOICE_FILE, openAiVoiceSnapshotPath, probeOpenAiVoiceInput, validOpenAiVoiceSource,
  verifyOpenAiVoiceSnapshot } from './openai-voice-source.js';
import type { PublicationSnapshot } from './publication-repository.js';
import { lookupRelease, readReleaseInput, sha256, type ReleaseInput, type ReleaseOptions } from './release.js';
import { probeReleaseInput } from './release-input-probe.js';
import type { RuleCandidate, RuleSource } from './rules-model.js';
import type { SourceRecord } from './types.js';

type Network = Pick<ReleaseOptions, 'fetch' | 'token'>;
type SnapshotReader = Pick<PublicationSnapshot, 'read'>;
type AcquiredInput = { bytes: Uint8Array; source: RuleSource };
type InputProbe = {
  read(): Promise<AcquiredInput>;
  unchanged?(previous: RuleSource): Promise<RuleSource | undefined>;
};
type CandidateSource = Pick<RuleCandidate, 'id' | 'source' | 'sourceInput'>;

type InputSnapshot = {
  path: string;
  verify(bytes: Uint8Array | undefined): Uint8Array;
};

interface RuleSourceAdapter {
  file: string;
  probe(network: Network, branchHeads?: Map<string, Promise<string>>): InputProbe | Promise<InputProbe>;
  openFixed(network: Network, candidate: CandidateSource, snapshot: SnapshotReader): InputProbe | Promise<InputProbe>;
  snapshotRequirement?(candidate: CandidateSource): InputSnapshot;
}

async function releaseOptions(input: ReleaseInput, network: Network, expectedSource?: SourceRecord) {
  const metadata = await lookupRelease(input, expectedSource ? String(expectedSource.releaseId) : 'latest', network);
  if (typeof metadata.tag_name !== 'string') throw new Error('Release metadata has no tag');
  return { ...network, tag: metadata.tag_name, releaseMetadata: metadata, expectedSource };
}

function voiceSource(source: RuleSource) {
  if (!validOpenAiVoiceSource(source)) throw new Error('Invalid recorded ChatGPT Voice input identity');
  return source;
}

function voiceSnapshot(id: string, source: ReturnType<typeof voiceSource>): InputSnapshot {
  return { path: openAiVoiceSnapshotPath(id), verify: bytes => verifyOpenAiVoiceSnapshot(source, bytes) };
}

const voiceAdapter: RuleSourceAdapter = {
  file: OPENAI_VOICE_FILE,
  probe: network => probeOpenAiVoiceInput(network.fetch),
  openFixed(_network, candidate, snapshot) {
    const source = voiceSource(candidate.source);
    const input = voiceSnapshot(candidate.id, source);
    return { read: async () => ({ source, bytes: await readSnapshot(input, snapshot) }) };
  },
  snapshotRequirement: candidate => voiceSnapshot(candidate.id, voiceSource(candidate.source)),
};

export function ruleSourceAdapter(input: SourceInput): RuleSourceAdapter {
  if (input.version === 'url') {
    const snapshotRequirement = (candidate: CandidateSource): InputSnapshot => {
      const source = candidate.source;
      if (!validFixedUrlSource(source, input)) throw new Error('Invalid recorded URL input identity');
      const extension = input.input.format === 'v2fly-dlc-yaml' ? 'yml' : 'json';
      return { path: `candidates/${candidate.id}/input.source.${extension}`, verify: bytes => verifyFixedUrlSnapshot(source, bytes) };
    };
    return {
      file: input.input.url,
      probe: network => ({ read: () => readFixedUrlInput(input, network.fetch) }),
      openFixed(_network, candidate, snapshot) {
        return { read: async () => ({ source: candidate.source, bytes: await readSnapshot(snapshotRequirement(candidate), snapshot) }) };
      },
      snapshotRequirement,
    };
  }
  if (input.version === 'openai-voice') return voiceAdapter;
  if (input.version === 'git-branch') {
    const snapshotRequirement = input.input.format === 'sing-box-srs' ? (candidate: CandidateSource): InputSnapshot => {
      const source = candidate.source;
      if (!('kind' in source) || source.kind !== 'github-commit' || !validCommitSource(source, input)) {
        throw new Error('Invalid recorded SRS input identity');
      }
      return {
        path: `candidates/${candidate.id}/input.source.srs`,
        verify(bytes) {
          if (!bytes || bytes.byteLength !== source.inputBytes || sha256(bytes) !== source.inputSha256) {
            throw new Error('Recorded SRS snapshot is missing or differs from its input digest');
          }
          return bytes;
        },
      };
    } : undefined;
    return {
      file: input.input.path,
      async probe(network, branchHeads) {
        const probe = await probeCommitInput(input, network, branchHeads);
        return { read: probe.read, unchanged: async previous => 'kind' in previous && previous.kind === 'github-commit' ? probe.unchanged(previous) : undefined };
      },
      openFixed(network, candidate, snapshot) {
        if (snapshotRequirement) {
          return { read: async () => ({ source: candidate.source, bytes: await readSnapshot(snapshotRequirement(candidate), snapshot) }) };
        }
        const expected = candidate.source as CommitSourceRecord;
        const { inputSha256: _hash, inputBytes: _bytes, ...identity } = expected;
        return { read: () => readPinnedCommitInput(input, network, identity, expected) };
      },
      snapshotRequirement,
    };
  }
  return {
    file: input.input.asset,
    async probe(network) {
      const probe = probeReleaseInput(input, await releaseOptions(input, network));
      return { read: probe.read, unchanged: async previous => 'kind' in previous ? undefined : probe.unchanged(previous) };
    },
    async openFixed(network, candidate) {
      const options = await releaseOptions(input, network, candidate.source as SourceRecord);
      return { read: () => readReleaseInput(options, input) };
    },
  };
}

async function readSnapshot(input: InputSnapshot, snapshot: SnapshotReader) {
  return input.verify(await snapshot.read(input.path));
}

/** Candidate stages own Git writes, while adapters describe the required input file. */
export function candidateInputSnapshot(candidate: CandidateSource) {
  const input = ruleSourceAdapter(candidate.sourceInput).snapshotRequirement?.(candidate);
  if (!input) return;
  return { ...input, read: (snapshot: SnapshotReader) => readSnapshot(input, snapshot) };
}
