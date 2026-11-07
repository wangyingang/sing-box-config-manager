import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stageRef } from './maintenance-baseline-transport.js';
import { ARTIFACT_REPOSITORY } from './publication.js';

export interface Ref { ref: string; head: string }
export interface RefChange { ref: string; before?: string; after?: string }
export interface MaintenanceRefTransport {
  list(): Promise<Ref[]>;
  /** Compare and update the whole set, or leave it unchanged. */
  update(changes: RefChange[]): Promise<void>;
}

export const branchRef = (branch: string) => `refs/heads/${branch}`;

export function cleanupRefNames(id: string, shared: boolean) {
  return ['files', 'metadata', 'evidence', 'journal', 'old-journal',
    ...shared ? [] : ['stable-root', 'stable', 'old-stable']].map(step => branchRef(stageRef(id, step)));
}

export function gitMaintenanceRefs(remote = `https://github.com/${ARTIFACT_REPOSITORY}.git`): MaintenanceRefTransport {
  const git = async (args: string[], cwd?: string) => (await promisify(execFile)('git', [
    '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args,
  ], { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;

  return {
    async list() {
      const output = await git(['ls-remote', '--refs', '--', remote]);
      return output.trim().split('\n').filter(Boolean).map(line => {
        const [head, ref] = line.split('\t');
        if (!/^[a-f0-9]{40}$/.test(head) || !ref?.startsWith('refs/')) throw new Error('Invalid remote ref');
        return { ref, head };
      });
    },
    async update(changes) {
      if (!changes.length) return;
      if (new Set(changes.map(change => change.ref)).size !== changes.length
        || changes.some(({ ref, before, after }) => !/^refs\/heads\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ref)
          || before === after || [before, after].some(head => head !== undefined && !/^[a-f0-9]{40}$/.test(head)))) {
        throw new Error('Invalid maintenance ref changes');
      }
      const cwd = await mkdtemp(join(tmpdir(), 'rule-maintenance-git-'));
      try {
        await git(['init', '--bare'], cwd);
        const objects = [...new Set(changes.flatMap(({ after }) => after ? [after] : []))];
        if (objects.length) await git(['fetch', '--no-tags', '--', remote, ...objects], cwd);
        await git(['push', '--atomic', '--porcelain',
          ...changes.map(({ ref, before }) => `--force-with-lease=${ref}:${before ?? ''}`),
          '--', remote, ...changes.map(({ ref, after }) => `${after ?? ''}:${ref}`)], cwd);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
