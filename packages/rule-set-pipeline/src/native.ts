import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from './release.js';
import { normalizeTerms, projectTerms, renderRuleJson, USAGES, type BuildTerm, type Usage } from './projection.js';

const exec = promisify(execFile);
export interface NativeTool { path: string; version: '1.14.4'; identity: string; sha256: string }
export interface NativeStep { args: string[]; stdout: string; stderr: string }
export const NATIVE_VALIDATION_POLICY = 'native-compile-load-v1';
export interface NativeValidation { status: 'passed'; policy: typeof NATIVE_VALIDATION_POLICY; steps: NativeStep[] }
export type BuiltArtifact = {
  file: string; sha256: string; bytes: number; requiredCapabilities: []; content: Buffer;
} & ({ format: 'source'; termCount: number } | { format: 'binary'; termCount?: never });
export interface ValidatedNativeBuild {
  status: 'built-validated'; tool: NativeTool; buildId: string;
  artifacts: BuiltArtifact[];
  validation: NativeValidation;
}
export interface NativeBuild extends ValidatedNativeBuild {
  usages: Record<Usage, { artifactFiles: string[] } | { status: 'unavailable'; reason: 'empty' }>;
}

export type NativeTarget = string | { kind: 'single-artifact'; artifact: string };
type NativeLayout = { artifact: string; terms: BuildTerm[] }
  | { artifact?: string; projections: ReturnType<typeof projectTerms> };
export type NativeBuilder = (terms: readonly BuildTerm[], binary: string, target?: NativeTarget) => Promise<ValidatedNativeBuild>;

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
export async function buildNative(terms: readonly BuildTerm[], binary: string, artifact?: string): Promise<NativeBuild> {
  return requireProjectedBuild(await validateNative(terms, binary, artifact));
}

export function requireProjectedBuild(build: ValidatedNativeBuild): NativeBuild {
  if (!('usages' in build)) throw new Error('Missing legacy native usage metadata');
  return build as NativeBuild;
}

export const buildRuleArtifacts: NativeBuilder = (terms, binary, target) => validateNative(terms, binary, target);
export interface NativeBuildOptions { binary: string; nativeBuild?: NativeBuilder }

function copyBuild({ artifacts, ...record }: ValidatedNativeBuild): ValidatedNativeBuild {
  return { ...structuredClone(record), artifacts: artifacts.map(artifact => ({
    ...artifact, requiredCapabilities: [], content: Buffer.from(artifact.content),
  })) };
}

/** Share only completed builds for this tool, content and output layout within one operation. */
export function createOperationNativeBuilder(): NativeBuilder {
  const passed = new Map<string, ValidatedNativeBuild>();
  return (terms, binary, target) => validateNative(terms, binary, target, passed);
}

async function validateNative(terms: readonly BuildTerm[], binary: string, target?: NativeTarget, passed?: Map<string, ValidatedNativeBuild>) {
  const layout: NativeLayout = typeof target === 'object'
    ? { artifact: target.artifact, terms: normalizeTerms(terms) }
    : { artifact: target, projections: projectTerms(terms) };
  if ('projections' in layout && layout.artifact !== undefined
    && layout.projections['dns-query'].length && layout.projections['dns-response'].length) {
    throw new NativeBuildError('A shared artifact name requires a pure domain or pure IP rule set');
  }
  const tool = await inspectBinary(binary);
  const id = nativeBuildIdentity(tool.sha256, 'terms' in layout ? layout.terms : layout.projections.route);
  const key = JSON.stringify([id, target]);
  const previous = passed?.get(key);
  if (previous) return { ...copyBuild(previous), tool };
  const built = await buildWithTool(layout, tool, id);
  passed?.set(key, copyBuild(built));
  return built;
}

async function buildWithTool(layout: NativeLayout, tool: NativeTool, buildId: string): Promise<ValidatedNativeBuild> {
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
  const compile = async (json: string, stem: string, termCount: number) => {
    const source = `${stem}.json`, srs = `${stem}.srs`;
    await writeFile(join(directory, source), json);
    for (const args of nativeArtifactCommands(source, srs)) await run(args);
    for (const [file, format] of [[source, 'source'], [srs, 'binary']] as const) {
      const content = await readFile(join(directory, file));
      const metadata = { file, sha256: sha256(content), bytes: content.length, requiredCapabilities: [] as [], content };
      artifacts.push(format === 'source' ? { ...metadata, format, termCount } : { ...metadata, format });
    }
    return [source, srs];
  };
  try {
    let usages: NativeBuild['usages'] | undefined;
    if ('terms' in layout) await compile(renderRuleJson(layout.terms, { allowEmpty: true }), layout.artifact, layout.terms.length);
    else usages = await buildProjections(layout, compile);
    // Guard against a binary replaced during validation.
    if (sha256(await readFile(tool.path)) !== tool.sha256) throw new NativeBuildError('Binary changed during build', steps);
    return { status: 'built-validated', tool, buildId, artifacts, ...(usages && { usages }),
      validation: { status: 'passed', policy: NATIVE_VALIDATION_POLICY, steps } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function buildProjections({ projections, artifact }: Extract<NativeLayout, { projections: unknown }>,
  compile: (json: string, stem: string, termCount: number) => Promise<string[]>) {
  const usages = {} as NativeBuild['usages'];
  const filesByContent = new Map<string, string[]>();
  for (const usage of USAGES) {
    const projected = projections[usage];
    if (!projected.length) { usages[usage] = { status: 'unavailable', reason: 'empty' }; continue; }
    const json = renderRuleJson(projected);
    let files = filesByContent.get(json);
    if (!files) {
      const stem = artifact ?? (usage === 'route' && projected.every(term => term.type !== 'ip_cidr') ? 'domains' : usage);
      files = await compile(json, stem, projected.length);
      filesByContent.set(json, files);
    }
    usages[usage] = { artifactFiles: files };
  }
  return usages;
}
