/** Node-only local validation/publication adapter. Never imported by the core entrypoint. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import build from '../schemas/build.json' with { type: 'json' };
import { canonical, digest } from './json.js';
import { prepareRecipePublication } from './recipe-publication.js';
import { preparePublication, renderSubscription } from './publication.js';
import type { NativeCheck, Publication } from './publication.js';
import type { CompileInput, Result } from './types.js';

const execute = promisify(execFile);
export function createSingBoxChecker(binary: string): NativeCheck {
  // Absolute path: check runs in an isolated directory, independent of the caller's cwd.
  const executable = resolve(binary);
  return async config => {
    const directory = await mkdtemp(join(tmpdir(), 'd06-check-'));
    const options = { cwd: directory, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' as const };
    try {
      const { stdout: version } = await execute(executable, ['version'], options);
      if (version.split('\n')[0] !== 'sing-box version 1.14.4') throw new Error('binary version mismatch');
      const { stdout: schema } = await execute(executable, ['schema'], options);
      if (createHash('sha256').update(schema).digest('hex') !== build.schemaSha256) throw new Error('binary schema/build mismatch');
      await writeFile(join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
      await execute(executable, ['check', '-c', 'config.json', '-D', directory], options);
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
}

/** Commits only a prepared snapshot. The pointer changes after all checks and file writes. */
export async function commitPublication(directory: string, publication: Publication): Promise<void> {
  const snapshot = structuredClone(publication);
  if (snapshot.id !== await digest(snapshot.body) || !(await renderSubscription(snapshot, { ecs: null })).ok) {
    throw new Error('invalid publication');
  }
  await mkdir(join(directory, 'releases'), { recursive: true, mode: 0o700 });
  const artifact = join(directory, 'releases', `${snapshot.id}.json`);
  const content = canonical(snapshot) + '\n';
  try { await writeFile(artifact, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(artifact, 'utf8') !== content) throw error;
  }
  const temporary = join(directory, `.current-${randomUUID()}.json`);
  try {
    await writeFile(temporary, JSON.stringify({ id: snapshot.id }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'current.json'));
  } finally { await rm(temporary, { force: true }); }
}

export async function readPublication(directory: string): Promise<Publication> {
  const { id } = JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'));
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid publication pointer');
  const publication = JSON.parse(await readFile(join(directory, 'releases', `${id}.json`), 'utf8')) as Publication;
  if (publication.id !== id || id !== await digest(publication.body)) throw new Error('publication integrity failure');
  return publication;
}

export async function publish(input: CompileInput, options: { binary: string; directory: string }): Promise<Result<Publication>> {
  const result = await preparePublication(input, createSingBoxChecker(options.binary));
  if (result.ok) await commitPublication(options.directory, result.value);
  return result;
}

/** The Recipe adapter uses the same atomic local publisher as D06. */
export async function publishRecipe(input: unknown, options: { binary: string; directory: string }): Promise<Result<Publication>> {
  const result = await prepareRecipePublication(input, createSingBoxChecker(options.binary));
  if (result.ok) await commitPublication(options.directory, result.value);
  return result;
}
