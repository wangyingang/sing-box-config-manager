import yamlPackage from 'yaml/package.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };
import { convertRules, renderDomainJson } from './convert.js';
import { readRelease, sha256, SourceError, type ReleaseOptions } from './release.js';
import { diagnostic, emptyReport, TARGET_LIST, type ConversionReport, type SourceRecord } from './types.js';
import { readTargetList } from './yaml-input.js';

export { convertRules, renderDomainJson, readRelease, readTargetList };
export type { ReleaseOptions };
export type { ConversionReport, Diagnostic, InputRule, RuleTerm, SourceRecord } from './types.js';
interface Artifact { file: 'domains.json'; sha256: string; bytes: number; termCount: number }
export type BuildResult = { ok: false; status: 'failed'; report: ConversionReport; source?: SourceRecord }
  | { ok: true; status: 'built-unvalidated'; source: SourceRecord; report: ConversionReport;
    json: string; artifact: Artifact; list: string;
    tools: { pipeline: string; conversionPolicy: string; node: string; yaml: string; sourceFormat: number };
    usages: { route: Artifact; 'dns-query': Artifact; 'dns-response': { status: 'unavailable'; reason: 'empty' } } };

export async function buildRelease(options: ReleaseOptions): Promise<BuildResult> {
  let input: Awaited<ReturnType<typeof readRelease>>;
  try { input = await readRelease(options); }
  catch (error) {
    const report = emptyReport();
    report.diagnostics.push(diagnostic(error instanceof SourceError ? error.code : 'SOURCE_FAILED',
      error instanceof Error ? error.message : String(error)));
    return { ok: false, status: 'failed', report };
  }
  const parsed = readTargetList(input.bytes);
  if (!parsed.ok) {
    const report = emptyReport();
    report.inputCount = parsed.inputCount;
    report.diagnostics = parsed.diagnostics;
    return { ok: false, status: 'failed', source: input.source, report };
  }
  const converted = convertRules(parsed.rules);
  if (!converted.ok) return { ok: false, status: 'failed', source: input.source, report: converted.report };
  const json = renderDomainJson(converted.terms);
  const artifact: Artifact = { file: 'domains.json', sha256: sha256(json), bytes: Buffer.byteLength(json), termCount: converted.terms.length };
  return { ok: true, status: 'built-unvalidated', source: input.source, list: TARGET_LIST, report: converted.report,
    tools: { pipeline: packageInfo.version, conversionPolicy: 'v2fly-domain-v1', node: process.versions.node, yaml: yamlPackage.version, sourceFormat: 4 },
    json, artifact, usages: { route: artifact, 'dns-query': artifact, 'dns-response': { status: 'unavailable', reason: 'empty' } } };
}

export { buildNative, inspectBinary, NativeBuildError } from './native.js';
export type { NativeBuild, NativeTool, BuiltArtifact } from './native.js';
export { projectTerms, renderRuleJson, decodedTerms } from './projection.js';
export type { BuildTerm, Usage } from './projection.js';

export { updateRules, readUpdateState } from './update.js';
export type { UpdateOptions, UpdateState } from './update.js';
