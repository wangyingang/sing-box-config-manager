import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { baselineStageNames, stageRef } from './maintenance-baseline-transport.js';
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
  const stages = new Set(Object.values(baselineStageNames(shared)));
  stages.add('old-journal');
  if (!shared) stages.add('old-stable');
  return [...stages].map(step => branchRef(stageRef(id, step)));
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
        // Git omits up-to-date refs from the push even when their leases
        // disagree. Check the advertised transaction before it can be sent.
        const zero = '0'.repeat(40);
        const expected = changes.map(({ ref, before, after }) => `${after ?? zero} ${ref} ${before ?? zero}`).sort().join('\n');
        await writeFile(join(cwd, 'maintenance-transaction'), expected + '\n');
        await writeFile(join(cwd, 'pre-push'), `#!/bin/sh
set -eu
if ! cut -d ' ' -f 2- | LC_ALL=C sort | cmp -s maintenance-transaction -; then
  echo 'Maintenance push refused: advertised transaction differs from expected refs and heads' >&2
  exit 1
fi
`, { mode: 0o700 });
        await git(['-c', `core.hooksPath=${cwd}`, 'push', '--atomic', '--porcelain',
          ...changes.map(({ ref, before }) => `--force-with-lease=${ref}:${before ?? ''}`),
          '--', remote, ...changes.map(({ ref, after }) => `${after ?? ''}:${ref}`)], cwd);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
