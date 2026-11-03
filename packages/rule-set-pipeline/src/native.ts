import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { sameSemantics } from './semantics.js';
import { sha256 } from './release.js';
import { decodedTerms, projectTerms, renderRuleJson, USAGES, type BuildTerm, type Usage } from './projection.js';

const exec = promisify(execFile);
export interface NativeTool { path: string; version: '1.14.4'; identity: string; sha256: string }
export interface NativeStep { args: string[]; stdout: string; stderr: string }
export interface BuiltArtifact {
  file: string; format: 'source' | 'binary'; sha256: string; bytes: number; termCount: number;
  requiredCapabilities: []; content: Buffer;
}
export interface NativeBuild {
  status: 'built-validated'; tool: NativeTool; buildId: string;
  artifacts: BuiltArtifact[];
  usages: Record<Usage, { artifactFiles: string[] } | { status: 'unavailable'; reason: 'empty' }>;
  validation: { status: 'passed'; semanticRoundTrip: true; steps: NativeStep[] };
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

/** Local validated bytes only: no remote URLs, publication or activation state. */
export async function buildNative(terms: readonly BuildTerm[], binary: string): Promise<NativeBuild> {
  const projections = projectTerms(terms);
  const tool = await inspectBinary(binary);
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
      const source = `${stem}.json`, srs = `${stem}.srs`, decoded = `${stem}.decoded.json`;
      await writeFile(join(directory, source), json);
      await run(['rule-set', 'compile', source, '-o', srs]);
      await run(['rule-set', 'decompile', srs, '-o', decoded]);
      let decodedProjection: BuildTerm[];
      try {
        decodedProjection = decodedTerms(JSON.parse(await readFile(join(directory, decoded), 'utf8')));
        if (!sameSemantics(projected, decodedProjection)) {
          throw new Error('Decoded semantics differ from projected Rule IR');
        }
      } catch (error) { throw new NativeBuildError(`Semantic round trip failed: ${String(error)}`, steps); }
      // match loads and initializes the actual file (including the Go regexp engine),
      // unlike configuration-only check. A non-match is a successful load too.
      for (const [file, format] of [[source, 'source'], [srs, 'binary']] as const) {
        await run(['rule-set', 'match', file, 'native-validation.invalid', '--format', format]);
        const content = await readFile(join(directory, file));
        artifacts.push({ file, format, sha256: sha256(content), bytes: content.length,
          termCount: format === 'source' ? projected.length : decodedProjection.length, requiredCapabilities: [], content });
      }
      const files = [source, srs];
      filesByContent.set(json, files);
      usages[usage] = { artifactFiles: files };
    }
    // Guard against a binary replaced during validation; no passed record on drift.
    if (sha256(await readFile(tool.path)) !== tool.sha256) throw new NativeBuildError('Binary changed during build', steps);
    const buildId = sha256(JSON.stringify({ policy: 'native-projection-v2', sourceFormat: 4,
      tool: tool.sha256, terms: projections.route }));
    return { status: 'built-validated', tool, buildId, artifacts, usages,
      validation: { status: 'passed', semanticRoundTrip: true, steps } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
