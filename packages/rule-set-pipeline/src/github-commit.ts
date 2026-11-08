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

export interface CommitSourceRecord {
  kind: 'github-commit';
  repository: string;
  branch: string;
  commit: string;
  file: { path: string; url: string };
  inputSha256: string;
  inputBytes: number;
}

export interface CommitOptions {
  commit?: string;
  fetch?: typeof fetch;
  token?: string;
}

export async function readCommitInput(input: CommitInput, options: CommitOptions): Promise<{ bytes: Uint8Array; source: CommitSourceRecord }> {
  const fetcher = options.fetch ?? fetch;
  const { repository, branch, input: { path } } = input;
  const shaPattern = /^[a-f0-9]{40}$/;
  if (options.commit !== undefined && !shaPattern.test(options.commit)) {
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
  if (metadata?.name !== branch || typeof head !== 'string' || !shaPattern.test(head)) {
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

  const url = `https://raw.githubusercontent.com/${repository}/${commit}/${path}`;
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new SourceError('DOWNLOAD_FAILED', `HTTP ${response.status}: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, source: { kind: 'github-commit', repository, branch, commit, file: { path, url },
    inputSha256: sha256(bytes), inputBytes: bytes.byteLength } };
}
