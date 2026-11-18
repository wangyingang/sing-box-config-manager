import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from './release.js';
import { projectTerms, renderRuleJson, USAGES, type BuildTerm, type Usage } from './projection.js';

const exec = promisify(execFile);
export interface NativeTool { path: string; version: '1.14.4'; identity: string; sha256: string }
export interface NativeStep { args: string[]; stdout: string; stderr: string }
export const NATIVE_VALIDATION_POLICY = 'native-compile-load-v1';
export interface NativeValidation { status: 'passed'; policy: typeof NATIVE_VALIDATION_POLICY; steps: NativeStep[] }
export type BuiltArtifact = {
  file: string; sha256: string; bytes: number; requiredCapabilities: []; content: Buffer;
} & ({ format: 'source'; termCount: number } | { format: 'binary'; termCount?: never });
export interface NativeBuild {
  status: 'built-validated'; tool: NativeTool; buildId: string;
  artifacts: BuiltArtifact[];
  usages: Record<Usage, { artifactFiles: string[] } | { status: 'unavailable'; reason: 'empty' }>;
  validation: NativeValidation;
}
export class NativeBuildError extends Error {
  constructor(message: string, public readonly steps: NativeStep[] = []) { super(message); }
}

export async function inspectBinary(binary: string): Promise<NativeTool> {
  if (!isAbsolute(binary)) throw new NativeBuildError('An explicit absolute sing-box 1.14.4 binary path is required');
  try {
    const path = await realpath(binary);
    const { stdout } = await exec(path, ['version'], { timeout: 30_000 });
    if (!/^sing-box version 1\.14\.4\r?\n/.test(stdout)) throw new Error(`Expected sing-box 1.14.4, got ${stdout.trim()}`);
    return { path, version: '1.14.4', identity: stdout.trim(), sha256: sha256(await readFile(path)) };
  } catch (error) { throw new NativeBuildError(`Binary validation failed: ${error instanceof Error ? error.message : error}`); }
}

export function nativeBuildIdentity(toolSha256: string, terms: readonly BuildTerm[]) {
  return sha256(JSON.stringify({ policy: NATIVE_VALIDATION_POLICY, sourceFormat: 4, tool: toolSha256, terms }));
}

export function nativeArtifactCommands(source: string, srs: string): string[][] {
  // match initializes both formats, including the Go regexp engine.
  return [
    ['rule-set', 'compile', source, '-o', srs],
    ['rule-set', 'match', source, 'native-validation.invalid', '--format', 'source'],
    ['rule-set', 'match', srs, 'native-validation.invalid', '--format', 'binary'],
  ];
}

/** Local validated bytes only: no remote URLs, publication or activation state. */
export function buildNative(terms: readonly BuildTerm[], binary: string): Promise<NativeBuild> {
  return validateNative(terms, binary);
}

export interface NativeBuildOptions { binary: string; nativeBuild?: typeof buildNative }

function copyBuild({ artifacts, ...record }: NativeBuild): NativeBuild {
  return { ...structuredClone(record), artifacts: artifacts.map(artifact => ({
    ...artifact, requiredCapabilities: [], content: Buffer.from(artifact.content),
  })) };
}

/**
 * Share only completed native builds within one rules operation. The normalized
 * route terms determine all rendered projections and their formats and filenames.
 * Callers still compare their actual JSON/SRS bytes with the validated output.
 */
export function createOperationNativeBuilder(): typeof buildNative {
  const passed = new Map<string, NativeBuild>();
  return (terms, binary) => validateNative(terms, binary, passed);
}

async function validateNative(terms: readonly BuildTerm[], binary: string, passed?: Map<string, NativeBuild>) {
  const projections = projectTerms(terms);
  const tool = await inspectBinary(binary);
  const id = nativeBuildIdentity(tool.sha256, projections.route);
  const previous = passed?.get(id);
  if (previous) return { ...copyBuild(previous), tool };
  const built = await buildWithTool(projections, tool, id);
  passed?.set(id, copyBuild(built));
  return built;
}

async function buildWithTool(projections: ReturnType<typeof projectTerms>, tool: NativeTool, buildId: string): Promise<NativeBuild> {
  const directory = await mkdtemp(join(tmpdir(), 'rule-native-'));
  const steps: NativeStep[] = [];
  const run = async (args: string[]) => {
    try {
      const { stdout, stderr } = await exec(tool.path, args, { cwd: directory, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      steps.push({ args, stdout, stderr });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      steps.push({ args, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message });
      throw new NativeBuildError(`Native command failed: ${args.join(' ')}: ${failure.stderr ?? failure.message}`, steps);
    }
  };
  const artifacts: BuiltArtifact[] = [];
  const usages = {} as NativeBuild['usages'];
  const filesByContent = new Map<string, string[]>();
  try {
    for (const usage of USAGES) {
      const projected = projections[usage];
      if (!projected.length) { usages[usage] = { status: 'unavailable', reason: 'empty' }; continue; }
      const json = renderRuleJson(projected);
      const existing = filesByContent.get(json);
      if (existing) { usages[usage] = { artifactFiles: existing }; continue; }
      const stem = usage === 'route' && projected.every(term => term.type !== 'ip_cidr') ? 'domains' : usage;
      const source = `${stem}.json`, srs = `${stem}.srs`;
      await writeFile(join(directory, source), json);
      for (const args of nativeArtifactCommands(source, srs)) await run(args);
      for (const [file, format] of [[source, 'source'], [srs, 'binary']] as const) {
        const content = await readFile(join(directory, file));
        const metadata = { file, sha256: sha256(content), bytes: content.length, requiredCapabilities: [] as [], content };
        artifacts.push(format === 'source' ? { ...metadata, format, termCount: projected.length } : { ...metadata, format });
      }
      const files = [source, srs];
      filesByContent.set(json, files);
      usages[usage] = { artifactFiles: files };
    }
    // Guard against a binary replaced during validation; no passed record on drift.
    if (sha256(await readFile(tool.path)) !== tool.sha256) throw new NativeBuildError('Binary changed during build', steps);
    return { status: 'built-validated', tool, buildId, artifacts, usages,
      validation: { status: 'passed', policy: NATIVE_VALIDATION_POLICY, steps } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
