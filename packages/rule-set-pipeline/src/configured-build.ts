import { readFile } from 'node:fs/promises';
import { isMap, isSeq, parseDocument, visit } from 'yaml';
import yamlPackage from 'yaml/package.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };
import { convertRules } from './convert.js';
import { buildNative, type NativeBuild } from './native.js';
import { readRelease, sha256, type ReleaseOptions } from './release.js';
import { diagnostic, emptyReport, type ConversionReport, type SourceRecord } from './types.js';
import { readLists } from './yaml-input.js';

export interface RuleDefinition { id: string; list: string; stablePath: string }
export interface BuildConfiguration {
  schemaVersion: 1;
  source: 'v2fly/domain-list-community';
  target: { repository: 'wangyingang/sing-box-rule-artifacts'; branch: string };
  ruleSets: RuleDefinition[];
}

function requireExactFields(value: unknown, expected: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== expected.sort().join(',')) throw new Error(`${label} fields are invalid`);
  return record;
}

/** Validate every definition before source access or output directory creation. */
export function parseBuildConfiguration(input: string): BuildConfiguration {
  const document = parseDocument(input, { uniqueKeys: true, stringKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(`Invalid build configuration YAML: ${document.errors[0]?.message ?? document.warnings[0]?.message}`);
  let alias = false;
  visit(document, { Alias() { alias = true; } });
  if (alias || !isMap(document.contents)) throw new Error('Invalid build configuration YAML');
  const raw = requireExactFields(document.toJS(), ['schemaVersion', 'source', 'target', 'ruleSets'], 'configuration');
  if (raw.schemaVersion !== 1 || raw.source !== 'v2fly/domain-list-community') throw new Error('Unsupported configuration version or source');
  const target = requireExactFields(raw.target, ['repository', 'branch'], 'target');
  if (target.repository !== 'wangyingang/sing-box-rule-artifacts' ||
      (target.branch !== 'main' && !(typeof target.branch === 'string' && /^acceptance-[a-zA-Z0-9._-]+$/.test(target.branch)))) {
    throw new Error('Target repository or branch is outside the trusted publication target');
  }
  if (!isSeq(document.contents.get('ruleSets', true)) || !Array.isArray(raw.ruleSets) || raw.ruleSets.length === 0) {
    throw new Error('ruleSets must be a nonempty sequence');
  }
  const ids = new Set<string>(), paths: string[] = [];
  const ruleSets = raw.ruleSets.map((entry, index) => {
    const rule = requireExactFields(entry, ['id', 'list', 'stablePath'], `ruleSets[${index}]`);
    if (typeof rule.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(rule.id) || ids.has(rule.id)) throw new Error(`Duplicate or invalid logical ID: ${String(rule.id)}`);
    if (typeof rule.list !== 'string' || !/^[a-z0-9][a-z0-9!._-]*$/.test(rule.list)) throw new Error(`Invalid V2Fly list: ${String(rule.list)}`);
    if (typeof rule.stablePath !== 'string' || !/^stable\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(rule.stablePath) ||
        rule.stablePath.split('/').some(segment => segment === '.' || segment === '..') ||
        (rule.stablePath as string === 'stable/activation.json') || (rule.stablePath as string).startsWith('stable/activation.json/') ||
        paths.some(path => path === rule.stablePath || path.startsWith(`${rule.stablePath}/`) || (rule.stablePath as string).startsWith(`${path}/`))) {
      throw new Error(`Invalid or conflicting stable path: ${String(rule.stablePath)}`);
    }
    ids.add(rule.id); paths.push(rule.stablePath);
    return { id: rule.id, list: rule.list, stablePath: rule.stablePath };
  });
  return { schemaVersion: 1, source: 'v2fly/domain-list-community',
    target: { repository: 'wangyingang/sing-box-rule-artifacts', branch: target.branch as string }, ruleSets };
}

export type ConfiguredResult = { id: string; definition: RuleDefinition; status: 'failed'; report: ConversionReport; error: string }
  | { id: string; definition: RuleDefinition; status: 'built-validated'; report: ConversionReport; native: NativeBuild; buildId: string };

export async function configuredBuildTools() {
  const implementationSha256 = sha256(Buffer.concat(await Promise.all(
    ['configured-build', 'release', 'yaml-input', 'convert', 'types', 'projection', 'native', 'semantics'].map(name =>
      readFile(new URL(`./${name}.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url))),
  )));
  return { pipeline: packageInfo.version, implementationSha256, conversionPolicy: 'v2fly-domain-v1',
    node: process.versions.node, yaml: yamlPackage.version, sourceFormat: 4 };
}

export async function buildConfiguredRelease(options: {
  configuration: string; release: ReleaseOptions; binary: string; selectedIds?: string[];
}): Promise<{ source: SourceRecord; configuration: BuildConfiguration; tools: Record<string, string | number>; results: ConfiguredResult[] }> {
  const configuration = parseBuildConfiguration(options.configuration);
  const selectedIds = options.selectedIds;
  if (selectedIds && (new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !configuration.ruleSets.some(rule => rule.id === id)))) {
    throw new Error('Selected logical ID is duplicate or unknown');
  }
  const definitions = selectedIds ? configuration.ruleSets.filter(rule => selectedIds.includes(rule.id)) : configuration.ruleSets;
  if (!definitions.length) throw new Error('At least one logical ID must be selected');
  const source = await readRelease(options.release);
  // A broken shared document is a batch failure; missing or invalid individual
  // lists remain independent results.
  const lists = readLists(source.bytes, [...new Set(definitions.map(rule => rule.list))]);
  const tools = await configuredBuildTools();
  const results: ConfiguredResult[] = [];
  for (const definition of definitions) {
    const parsed = lists.get(definition.list)!;
    let report: ConversionReport;
    if (!parsed.ok) {
      report = emptyReport(); report.inputCount = parsed.inputCount; report.diagnostics = parsed.diagnostics;
      results.push({ id: definition.id, definition, status: 'failed', report, error: 'V2Fly list is unavailable or invalid' });
      continue;
    }
    const converted = convertRules(parsed.rules);
    report = converted.report;
    report.diagnostics = report.diagnostics.map(entry => ({ ...entry, list: definition.list }));
    if (!converted.ok) {
      results.push({ id: definition.id, definition, status: 'failed', report, error: 'Rule conversion failed' });
      continue;
    }
    try {
      const native = await buildNative(converted.terms, options.binary);
      const buildId = sha256(JSON.stringify({ definition, target: configuration.target, source: source.source, tools, nativeBuildId: native.buildId,
        contracts: { sourceFormat: 4, buildRecord: 1 } }));
      results.push({ id: definition.id, definition, status: 'built-validated', report, native, buildId });
    } catch (error) {
      report.status = 'failed';
      report.diagnostics.push(diagnostic('NATIVE_FAILED', String(error), { list: definition.list }));
      results.push({ id: definition.id, definition, status: 'failed', report, error: String(error) });
    }
  }
  return { source: source.source, configuration, tools, results };
}
