import { githubPublicationRepository, type PublicationRepository } from './publication-repository.js';
import { ARTIFACT_REPOSITORY, ghJson, githubPublication } from './publication.js';

export interface ActivationTransport {
  readonly branch: string;
  /** Coordination journal for configured operations, on candidates in production. */
  readonly repository?: PublicationRepository;
  head(): Promise<string>;
  download(url: string): Promise<Buffer>;
  /** Exactly one parent, expectedHead; never rebase or force-push on conflict.
   * Run the configured operation's guard immediately before updating the ref.
   * Wrap uncertain ref updates in ActivationWriteError.
   */
  commit(expectedHead: string, files: Record<string, Buffer>, message: string, beforeWrite?: () => Promise<void>): Promise<string>;
}

export function isConfiguredActivationPath(path: string) {
  return /^stable\/.+\/(?:domains\.(?:srs|json)|activation\.json)$/.test(path);
}

/** Branch must already exist. Creating a production or acceptance environment is separate. */
export function githubActivation(branch = 'main', request: typeof ghJson = ghJson): ActivationTransport {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(branch) || branch === 'candidates') throw new Error('Invalid activation branch');
  const api = (path: string, input?: unknown) => request(['api', `repos/${ARTIFACT_REPOSITORY}/${path}`,
    ...(input === undefined ? [] : ['--method', 'POST', '--input', '-'])], input);
  return {
    branch,
    repository: githubPublicationRepository(branch === 'main' ? 'candidates' : branch, request),
    async head() {
      const repository = await request(['api', `repos/${ARTIFACT_REPOSITORY}`]);
      if (repository.private) throw new Error('Artifact repository must be public');
      const ref = await api(`git/ref/heads/${branch}`);
      if (!/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error('Invalid remote head');
      return ref.object.sha;
    },
    async download(url) {
      const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/`;
      const match = url.startsWith(prefix) ? /^([a-f0-9]{40})\/(stable\/(?:[a-z0-9._-]+\/)*activation\.json)$/.exec(url.slice(prefix.length)) : null;
      if (!match) return githubPublication(request).download(url);
      // A fresh raw/CDN 404 cannot prove the old record is absent. Read the
      // immutable Git tree/blob for concurrency state, failing closed on errors.
      const parent = await api(`git/commits/${match[1]}`);
      const tree = await api(`git/trees/${parent.tree.sha}?recursive=1`);
      if (tree.truncated) throw new Error('Cannot establish previous activation: truncated tree');
      const entry = tree.tree.find((item: { path: string }) => item.path === match[2]);
      if (!entry) throw new Error(`Readback HTTP 404: ${url}`);
      if (entry.type !== 'blob' || entry.mode !== '100644') throw new Error('Invalid previous activation entry');
      const blob = await api(`git/blobs/${entry.sha}`);
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('Invalid previous activation blob');
      const bytes = Buffer.from(blob.content, 'base64');
      if (bytes.length !== blob.size) throw new Error('Previous activation blob size mismatch');
      return bytes;
    },
    async commit(expectedHead, files, message, beforeWrite) {
      if (!/^[a-f0-9]{40}$/.test(expectedHead)) throw new Error('Expected full old commit');
      for (const path of Object.keys(files)) {
        if (!/^stable\/[a-zA-Z0-9/_.-]+$/.test(path) || path.split('/').some(part => part === '.' || part === '..' || !part)) throw new Error('Invalid stable path');
      }
      if (!beforeWrite && Object.keys(files).some(isConfiguredActivationPath)) {
        throw new Error('Configured activation requires a registered write guard');
      }
      // Recheck immediately before constructing the single-parent update.
      if (await this.head() !== expectedHead) throw new Error('ACTIVATION_CONFLICT: remote head changed');
      const parent = await api(`git/commits/${expectedHead}`);
      const tree = [];
      for (const [path, bytes] of Object.entries(files)) {
        const blob = await api('git/blobs', { content: bytes.toString('base64'), encoding: 'base64' });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const createdTree = await api('git/trees', { base_tree: parent.tree.sha, tree });
      const commit = await api('git/commits', { message, tree: createdTree.sha, parents: [expectedHead] });
      if (beforeWrite) {
        if (await this.head() !== expectedHead) throw new Error('ACTIVATION_CONFLICT: remote head changed');
        await beforeWrite();
      }
      // The caller knows this identity before PATCH, so even a lost reply can be reconciled.
      try {
        await request(['api', `repos/${ARTIFACT_REPOSITORY}/git/refs/heads/${branch}`, '--method', 'PATCH', '--input', '-'],
          { sha: commit.sha, force: false });
      } catch (error) {
        throw new ActivationWriteError(commit.sha, error);
      }
      return commit.sha;
    },
  };
}
export class ActivationWriteError extends Error {
  constructor(public readonly attemptedCommit: string, cause: unknown) {
    super(`Activation write response uncertain: ${String(cause)}`, { cause });
  }
}
