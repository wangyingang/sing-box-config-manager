import { ARTIFACT_REPOSITORY, ghJson, PUBLICATION_BRANCH } from './publication.js';

export interface PublicationSnapshot {
  head: string;
  paths: string[];
  read(path: string): Promise<Buffer | undefined>;
}
export interface PublicationRepository {
  readonly branch: string;
  snapshot(branch?: string): Promise<PublicationSnapshot>;
  /** The supplied head is the only parent; a conflict never rebases this write. */
  commit(expectedHead: string, files: Record<string, Buffer>, message: string): Promise<string>;
}

export class PublicationWriteError extends Error {
  constructor(public readonly attemptedCommit: string, cause: unknown) {
    super(`Publication write response uncertain: ${String(cause)}`, { cause });
  }
}

const fullCommit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function checkBranch(branch: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(branch)) throw new Error('Invalid publication branch');
}
interface TreeEntry { path: string; type: string; mode: string; sha: string }

/** Reads control records from immutable Git objects, never from a potentially stale CDN. */
export function githubPublicationRepository(branch = PUBLICATION_BRANCH, request: typeof ghJson = ghJson): PublicationRepository {
  checkBranch(branch);
  const api = (path: string, input?: unknown) => request(['api', `repos/${ARTIFACT_REPOSITORY}${path ? `/${path}` : ''}`,
    ...(input === undefined ? [] : ['--method', 'POST', '--input', '-'])], input);
  async function snapshot(target = branch) {
    checkBranch(target);
    const repository = await api('');
    if (repository.private !== false) throw new Error('Artifact repository must be public');
    const ref = await api(`git/ref/heads/${target}`);
    if (!fullCommit(ref?.object?.sha)) throw new Error('Invalid remote head');
    const head: string = ref.object.sha;
    const parent = await api(`git/commits/${head}`);
    if (!fullCommit(parent?.tree?.sha)) throw new Error('Invalid remote tree');
    const treeSha: string = parent.tree.sha;
    const result = await api(`git/trees/${treeSha}?recursive=1`);
    if (result.truncated || !Array.isArray(result.tree)) throw new Error('Cannot establish remote state: incomplete tree');
    const entries = new Map<string, TreeEntry>();
    for (const entry of result.tree) {
      if (!entry || typeof entry.path !== 'string' || entry.path.split('/').some((part: string) => !part || part === '.' || part === '..')
        || !fullCommit(entry.sha) || entries.has(entry.path)) throw new Error('Invalid remote tree entry');
      entries.set(entry.path, entry);
    }
    return { head, treeSha, entries, paths: [...entries.keys()],
      async read(path: string): Promise<Buffer | undefined> {
        const entry = entries.get(path);
        if (!entry) return undefined;
        if (entry.type !== 'blob' || entry.mode !== '100644') throw new Error('Invalid remote record type');
        const blob = await api(`git/blobs/${entry.sha}`);
        if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || !Number.isSafeInteger(blob.size) || blob.size < 0) {
          throw new Error('Invalid remote record blob');
        }
        const bytes = Buffer.from(blob.content, 'base64');
        if (bytes.length !== blob.size) throw new Error('Remote record size mismatch');
        return bytes;
      },
    };
  }
  return { branch, snapshot,
    async commit(expectedHead, files, message) {
      if (!fullCommit(expectedHead)) throw new Error('Expected full old commit');
      const current = await snapshot();
      if (current.head !== expectedHead) throw new Error('PUBLICATION_CONFLICT: remote head changed');
      if (!Object.keys(files).length) throw new Error('Empty publication commit');
      // Check the entire write set before uploading any blob. Candidate paths
      // are append-only; only the control records may replace existing content.
      for (const path of Object.keys(files)) {
        const control = path === 'pipeline/state.json' || path === 'pipeline/identity.json';
        if (!control && !/^candidates\/[a-f0-9][a-f0-9-]*\/[a-z0-9][a-z0-9.-]*$/.test(path)) throw new Error('Invalid publication path');
        const existing = current.entries.get(path);
        if (existing && !control) throw new Error('Refusing to overwrite a historical candidate file');
        if (existing && (existing.type !== 'blob' || existing.mode !== '100644')) throw new Error('Invalid remote record type');
        const parts = path.split('/');
        for (let index = 1; index < parts.length; index++) {
          const ancestor = current.entries.get(parts.slice(0, index).join('/'));
          if (ancestor && (ancestor.type !== 'tree' || ancestor.mode !== '040000')) throw new Error('Invalid publication parent path');
        }
      }
      const tree = [];
      for (const [path, content] of Object.entries(files)) {
        const blob = await api('git/blobs', { content: content.toString('base64'), encoding: 'base64' });
        if (!fullCommit(blob?.sha)) throw new Error('Invalid created blob');
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const createdTree = await api('git/trees', { base_tree: current.treeSha, tree });
      if (!fullCommit(createdTree?.sha)) throw new Error('Invalid created tree');
      const commit = await api('git/commits', { message, tree: createdTree.sha, parents: [expectedHead] });
      if (!fullCommit(commit?.sha)) throw new Error('Invalid created commit');
      try {
        await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/refs/heads/${branch}`, '--method', 'PATCH', '--input', '-'],
          { sha: commit.sha, force: false });
      } catch (error) {
        throw new PublicationWriteError(commit.sha, error);
      }
      return commit.sha;
    },
  };
}
