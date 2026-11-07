import type { RemoteJournal } from './remote-state.js';
import { ARTIFACT_REPOSITORY, ghJson, PUBLICATION_BRANCH } from './publication.js';

export interface PublicationSnapshot {
  head: string;
  /** Single parent, if present. */
  parent?: string;
  parents?: string[];
  paths: string[];
  read(path: string): Promise<Buffer | undefined>;
}
export interface PublicationRepository {
  readonly branch: string;
  lastChange?(head: string, path: string): Promise<string>;
  snapshot(branch?: string): Promise<PublicationSnapshot>;
  /** The supplied head is the only parent; a conflict never rebases this write. */
  commit(expectedHead: string, files: Record<string, Buffer>, message: string, maintenanceId?: string): Promise<string>;
}

export class PublicationWriteError extends Error {
  constructor(public readonly attemptedCommit: string, cause: unknown) {
    super(`Publication write response uncertain: ${String(cause)}`, { cause });
  }
}

export function retainedCandidateDownload(snapshot: PublicationSnapshot, candidateId: string, download: (url: string) => Promise<Buffer>) {
  return async (url: string) => {
    const bytes = await download(url);
    const path = new URL(url).pathname.split('/').slice(4).join('/');
    const retained = path.startsWith(`candidates/${candidateId}/`) ? await snapshot.read(path) : undefined;
    if (!retained?.equals(bytes)) throw new Error('CANDIDATE_UNAVAILABLE: immutable address differs from retained candidate');
    return bytes;
  };
}

const fullCommit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function checkBranch(branch: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(branch)) throw new Error('Invalid publication branch');
}
interface TreeEntry { path: string; type: string; mode: string; sha: string }

/** Reads control records from immutable Git objects, never from a potentially stale CDN. */
export function githubPublicationRepository(branch = PUBLICATION_BRANCH, request: typeof ghJson = ghJson) {
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
    if (parent.parents !== undefined && (!Array.isArray(parent.parents) || !parent.parents.every((entry: { sha?: string }) => fullCommit(entry?.sha)))) {
      throw new Error('Invalid remote commit parents');
    }
    const parents: string[] | undefined = parent.parents?.map((entry: { sha: string }) => entry.sha);
    return { head, parent: parents?.length === 1 ? parents[0] : undefined, parents, treeSha, entries, paths: [...entries.keys()],
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
    async lastChange(head, path) {
      if (!fullCommit(head)) throw new Error('Expected full commit for path history');
      const query = new URLSearchParams({ sha: head, path, per_page: '1' });
      const commits = await api(`commits?${query}`);
      if (!Array.isArray(commits) || !fullCommit(commits[0]?.sha)) throw new Error(`Cannot identify commit for ${path}`);
      return commits[0].sha;
    },
    async commit(expectedHead, files, message, maintenanceId?: string) {
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
      // The journal and candidate bytes share the same expected parent.
      const previous = await current.read('pipeline/state.json');
      if (previous) {
        const journal: RemoteJournal = JSON.parse(previous.toString());
        const state = files['pipeline/state.json'];
        const baseline = journal.maintenance === 'maintenance' && !journal.maintenanceRun && !journal.maintenanceCleanup
          ? await current.read('pipeline/baseline.json') : undefined;
        const marker = baseline && JSON.parse(baseline.toString());
        const baselineId = marker?.schemaVersion === 1 && marker.generation === journal.generation ? marker.maintenanceId : undefined;
        if (journal.maintenance === 'maintenance' && (!maintenanceId || (journal.maintenanceRun?.id ?? journal.maintenanceCleanup?.id ?? baselineId) !== maintenanceId
          || Object.keys(files).length !== 1 || !state)) {
          throw new Error('REPOSITORY_MAINTENANCE');
        }
        if (!state) throw new Error('Unregistered publication write: missing remote state');
        const next: RemoteJournal = JSON.parse(state.toString());
        // A registered stable update might already have passed its final
        // journal check. Its expected stable parent must be fenced before
        // the separate journal branch may change generation or open the gate.
        if (branch === PUBLICATION_BRANCH && journal.targetBranch === 'main' && (next.maintenance !== journal.maintenance
          || next.generation !== journal.generation || next.id !== journal.id)) {
          const stable = await snapshot('main');
          const oldHeads = (next.maintenanceRun ?? journal.maintenanceRun)?.oldHeads;
          const expectedStable = journal.maintenanceCleanup?.stableHead ?? oldHeads?.stable;
          if (expectedStable && stable.head !== expectedStable) throw new Error('PUBLICATION_CONFLICT: stable head changed');
          const active = [...Object.values(journal.manualOperations ?? {}), ...Object.values(journal.automaticOperations ?? {})];
          if (active.some(operation => !operation.notCommitted && operation.generation === journal.generation
            && operation.expectedHead === stable.head)) {
            throw new Error('MANUAL_OPERATION_PENDING: stable head can still accept a registered write');
          }
        }
      }
      const commit = await createGitCommit(api, files, message, { tree: current.treeSha, head: expectedHead });
      try {
        await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/refs/heads/${branch}`, '--method', 'PATCH', '--input', '-'],
          { sha: commit, force: false });
      } catch (error) {
        throw new PublicationWriteError(commit, error);
      }
      return commit;
    },
  } satisfies PublicationRepository;
}

export async function createGitCommit(api: (path: string, input?: unknown) => Promise<any>,
  files: Record<string, Buffer>, message: string, parent?: { tree: string; head: string }) {
  const entries = [];
  for (const [path, bytes] of Object.entries(files)) {
    const blob = await api('git/blobs', { content: bytes.toString('base64'), encoding: 'base64' });
    if (!fullCommit(blob?.sha)) throw new Error('Invalid created blob');
    entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = entries.length ? (await api('git/trees', { ...(parent && { base_tree: parent.tree }), tree: entries }))?.sha : parent?.tree;
  if (!fullCommit(tree)) throw new Error('Invalid created tree');
  const commit = await api('git/commits', { message, tree, parents: parent ? [parent.head] : [] });
  if (!fullCommit(commit?.sha)) throw new Error('Invalid created commit');
  return commit.sha;
}
