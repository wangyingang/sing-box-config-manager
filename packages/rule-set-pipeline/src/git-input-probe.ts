import { fullGitCommit as fullGitObjectId, resolveCommit, readCommitInput, validCommitSource, withCommitCheckpoint,
  type CommitIdentity, type CommitInput, type CommitOptions, type CommitSourceRecord } from './github-commit.js';

type Network = Pick<CommitOptions, 'fetch' | 'token'>;

export function readPinnedCommitInput(input: CommitInput, network: Network, identity: CommitIdentity, expectedSource?: CommitSourceRecord) {
  return readCommitInput(input, withCommitCheckpoint(network, { identity, expectedSource, onSource: async () => {} }));
}

interface TreeEntry {
  path?: string;
  sha?: string;
  mode?: string;
  type?: string;
  size?: number;
}

async function fileBlob(input: CommitInput, network: Network, commit: string) {
  async function api(path: string) {
    const response = await (network.fetch ?? fetch)(`https://api.github.com/repos/${input.repository}/${path}`, {
      headers: { Accept: 'application/vnd.github+json', ...(network.token ? { Authorization: `Bearer ${network.token}` } : {}) },
      redirect: 'error', signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Git blob lookup HTTP ${response.status}`);
    return await response.json() as unknown;
  }
  const metadata = await api(`git/commits/${commit}`) as { sha?: string; tree?: { sha?: string } } | null;
  if (metadata?.sha !== commit || !fullGitObjectId(metadata.tree?.sha)) return;
  let treeSha = metadata.tree.sha;
  const parts = input.input.path.split('/');
  for (const [index, part] of parts.entries()) {
    const tree = await api(`git/trees/${treeSha}`) as { sha?: string; truncated?: boolean; tree?: TreeEntry[] } | null;
    if (tree?.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) return;
    const entries = tree.tree.filter(entry => entry?.path === part);
    const entry = entries[0];
    if (entries.length !== 1 || !fullGitObjectId(entry?.sha)) return;
    if (index === parts.length - 1) {
      if (entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')
        && typeof entry.size === 'number' && Number.isSafeInteger(entry.size)) return { sha: entry.sha, size: entry.size };
      return;
    }
    if (entry.type !== 'tree' || entry.mode !== '040000') return;
    treeSha = entry.sha;
  }
}

export async function probeCommitInput(input: CommitInput, network: Network, branchHeads?: Map<string, Promise<string>>) {
  const identity = await resolveCommit(input, network, branchHeads);
  const blobs = new Map<string, NonNullable<Awaited<ReturnType<typeof fileBlob>>>>();
  async function blob(commit: string) {
    const cached = blobs.get(commit);
    if (cached) return cached;
    // Optional tree evidence may be unavailable, even for a valid raw input.
    const result = await fileBlob(input, network, commit).catch(() => undefined);
    if (result) blobs.set(commit, result);
    return result;
  }
  return {
    async unchanged(previous: CommitSourceRecord) {
      if (!validCommitSource(previous, input)) return;
      if (identity.commit === previous.commit) return previous;
      const latest = await blob(identity.commit);
      if (!latest || latest.size !== previous.inputBytes) return;
      const original = await blob(previous.commit);
      if (original?.sha === latest.sha && original.size === latest.size) {
        return { ...identity, inputSha256: previous.inputSha256, inputBytes: previous.inputBytes };
      }
    },
    read: () => readPinnedCommitInput(input, network, identity),
  };
}
