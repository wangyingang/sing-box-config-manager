import { isDeepStrictEqual } from 'node:util';
import { sha256, SourceError } from './release.js';

export const CHINA_IP_INPUT = {
  repository: 'gaoyifan/china-operator-ip', version: 'git-branch', branch: 'ip-lists',
  input: { format: 'cidr-text', path: 'china46.txt' },
} as const;

export interface CommitInput {
  repository: string;
  version: 'git-branch';
  branch: string;
  input: { format: 'cidr-text'; path: string };
}

export interface CommitIdentity {
  kind: 'github-commit';
  repository: string;
  branch: string;
  commit: string;
  file: { path: string; url: string };
}

export interface CommitSourceRecord extends CommitIdentity {
  inputSha256: string;
  inputBytes: number;
}

export interface CommitOptions {
  commit?: string;
  fetch?: typeof fetch;
  token?: string;
}

const checkpoint = Symbol('commitCheckpoint');
interface CommitCheckpoint {
  identity: CommitIdentity;
  expectedSource?: CommitSourceRecord;
  onSource: (source: CommitSourceRecord) => Promise<void>;
}
type CheckpointedOptions = CommitOptions & { [checkpoint]?: CommitCheckpoint };

// Only the remote journal may supply a previously checked identity. The
// public build options always validate an explicit SHA against the branch.
export function withCommitCheckpoint(options: Pick<CommitOptions, 'fetch' | 'token'>, pin: CommitCheckpoint): CheckpointedOptions {
  return { ...options, [checkpoint]: pin };
}

export const fullGitCommit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

function commitIdentity(input: CommitInput, commit: string): CommitIdentity {
  const { repository, branch, input: { path } } = input;
  return { kind: 'github-commit', repository, branch, commit, file: { path, url: `https://raw.githubusercontent.com/${repository}/${commit}/${path}` } };
}

export function commitSourceKey({ repository, branch, commit, file }: CommitIdentity) {
  return `github-commit:${repository}:${branch}:${file.path}:${commit}`;
}

export function validCommitIdentity(identity: CommitIdentity, input: CommitInput = CHINA_IP_INPUT) {
  return identity && fullGitCommit(identity.commit) && isDeepStrictEqual(identity, commitIdentity(input, identity.commit));
}

export function validCommitSource(source: CommitSourceRecord, input: CommitInput = CHINA_IP_INPUT) {
  if (!source || typeof source !== 'object') return false;
  const { inputSha256, inputBytes, ...identity } = source;
  return validCommitIdentity(identity, input) && typeof inputSha256 === 'string' && /^[a-f0-9]{64}$/.test(inputSha256)
    && Number.isSafeInteger(inputBytes) && inputBytes >= 0;
}

export async function resolveCommit(input: CommitInput, options: CommitOptions): Promise<CommitIdentity> {
  const fetcher = options.fetch ?? fetch;
  const { repository, branch } = input;
  if (options.commit !== undefined && !fullGitCommit(options.commit)) {
    throw new SourceError('INVALID_COMMIT', 'Expected a full lowercase commit SHA');
  }
  const api = async (endpoint: string, errorCode: string): Promise<unknown> => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      redirect: 'error', signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new SourceError(errorCode, `${repository}/${endpoint}: HTTP ${response.status}`);
    return response.json();
  };
  const metadata = await api(`branches/${branch}`, 'BRANCH_LOOKUP_FAILED') as
    { name?: unknown; commit?: { sha?: unknown } } | null;
  const head = metadata?.commit?.sha;
  if (metadata?.name !== branch || !fullGitCommit(head)) {
    throw new SourceError('INVALID_COMMIT', `${repository}/${branch} did not resolve to a full commit SHA`);
  }
  const commit = options.commit ?? head;
  // The raw host can serve fork commits under the upstream repository's name.
  if (commit !== head) {
    const comparison = await api(`compare/${commit}...${head}?per_page=1`, 'COMMIT_LOOKUP_FAILED') as
      { merge_base_commit?: { sha?: unknown } } | null;
    if (comparison?.merge_base_commit?.sha !== commit) {
      throw new SourceError('COMMIT_OUTSIDE_BRANCH', `${commit} is outside ${repository}/${branch} history`);
    }
  }

  return commitIdentity(input, commit);
}

export async function readCommitInput(input: CommitInput, options: CheckpointedOptions): Promise<{ bytes: Uint8Array; source: CommitSourceRecord }> {
  const pin = options[checkpoint];
  const identity = pin?.identity ?? await resolveCommit(input, options);
  if (!validCommitIdentity(identity, input)) throw new SourceError('SOURCE_CHANGED', 'Invalid pinned Git source');
  const { url } = identity.file;
  const response = await (options.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new SourceError('DOWNLOAD_FAILED', `HTTP ${response.status}: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const source = { ...identity, inputSha256: sha256(bytes), inputBytes: bytes.byteLength };
  if (pin?.expectedSource && !isDeepStrictEqual(source, pin?.expectedSource)) {
    throw new SourceError('SOURCE_CHANGED', 'Pinned Git input no longer matches its recorded digest or length');
  }
  await pin?.onSource(source);
  return { bytes, source };
}
