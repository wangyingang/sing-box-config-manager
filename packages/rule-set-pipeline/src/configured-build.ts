import { readFile } from 'node:fs/promises';
import ipaddrPackage from 'ipaddr.js/package.json' with { type: 'json' };
import yamlPackage from 'yaml/package.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };
import { buildRuleArtifacts, requireProjectedBuild, type NativeBuild, type ValidatedNativeBuild, type NativeBuildOptions } from './native.js';
import { readReleaseInput, sha256, SourceError, type ReleaseOptions } from './release.js';
import { diagnostic, type RuleConversionReport, type ConversionReport } from './types.js';
import { readCommitInput, type CommitOptions } from './github-commit.js';
import { configuredInput, configuredReleaseInput, nativeTargetForRule, parseProjectedConfiguration, type BuildConfiguration, type ProjectedRuleDefinition, type RuleDefinition, type SourceFormat } from './configuration.js';
import { convertClashRuleList } from './clash-rule-list-adapter.js';
import { convertOpenAiVoice } from './openai-voice-source.js';
import { convertPlainYaml } from './plain-yaml-adapter.js';
import { convertDomainSuffixText } from './domain-suffix-text-adapter.js';
import { convertTypedDomainText } from './typed-domain-text-adapter.js';
import { convertSingBoxDomainJson } from './sing-box-domain-json-adapter.js';
import { convertCidrText } from './cidr-text-adapter.js';
import { USAGES, type BuildTerm } from './projection.js';
import { convertSingBoxSourceJson } from './sing-box-source-json-adapter.js';
import type { RuleSource } from './rules-model.js';

export { parseBuildConfiguration } from './configuration.js';
export type { BuildConfiguration, RuleDefinition } from './configuration.js';

export const CONFIGURED_BUILD_RECORD = 3;

export function configuredBuildIdentity(identity: object) {
  return sha256(JSON.stringify(identity, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value));
}

export type ConfiguredResult<Definition = RuleDefinition, Built = ValidatedNativeBuild, Report = RuleConversionReport> =
  { id: string; definition: Definition; report: Report }
  & ({ status: 'failed'; error: string } | { status: 'built-validated'; native: Built; buildId: string });

export async function configuredBuildTools(format: SourceFormat = 'plain-yaml') {
  const files = ['artifact-path', 'source-input', 'configuration', 'configured-build', 'release', 'plain-yaml-adapter', 'yaml-input', 'convert',
    'types', 'projection', 'native'];
  if (format === 'clash-rule-list') files.push('github-commit', 'clash-rule-list-adapter', 'cidr-text-adapter');
  if (format === 'cidr-text') files.push('github-commit', 'cidr-text-adapter');
  if (format === 'domain-suffix-text') files.push('github-commit', 'domain-suffix-text-adapter');
  if (format === 'typed-domain-text') files.push('github-commit', 'typed-domain-text-adapter');
  if (format === 'sing-box-domain-json') files.push('github-commit', 'sing-box-domain-json-adapter');
  if (format === 'openai-voice-json') files.push('openai-voice-source', 'cidr-text-adapter');
  if (format === 'sing-box-source-json') files.push('fixed-url-source', 'sing-box-source-json-adapter');
  const implementationSha256 = sha256(Buffer.concat(await Promise.all(
    files.map(name =>
      readFile(new URL(`./${name}.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url))),
  )));
  return { pipeline: packageInfo.version, implementationSha256, conversionPolicy: format === 'plain-yaml' ? 'v2fly-domain-v1' : `${format}-v1`,
    node: process.versions.node, yaml: yamlPackage.version, sourceFormat: 4,
    ...(format === 'cidr-text' || format === 'openai-voice-json' || format === 'clash-rule-list' ? { ipaddr: ipaddrPackage.version } : {}) };
}

interface BuildOptions { configuration: string; binary: string; selectedIds?: string[] }
type Converted = { ok: true; terms: readonly BuildTerm[]; report: RuleConversionReport }
  | { ok: false; report: RuleConversionReport; error: string };

function selectDefinitions<Definition extends RuleDefinition>(configuration: { ruleSets: Definition[] }, selectedIds?: string[]) {
  if (selectedIds && (new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !configuration.ruleSets.some(rule => rule.id === id)))) {
    throw new Error('Selected logical ID is duplicate or unknown');
  }
  const definitions = selectedIds ? configuration.ruleSets.filter(rule => selectedIds.includes(rule.id)) : configuration.ruleSets;
  if (!definitions.length) throw new Error('At least one logical ID must be selected');
  return definitions;
}

export async function buildConfiguredRelease(options: BuildOptions & { release: ReleaseOptions }) {
  const configuration = parseProjectedConfiguration(options.configuration);
  const definitions = selectDefinitions(configuration, options.selectedIds);
  const input = configuredReleaseInput(configuration, definitions);
  const { bytes, source } = await readReleaseInput(options.release, input);
  const conversionFor = convertInput(bytes, definitions, input.input.format, input.input.asset);
  return buildProjectedConfiguration(configuration, definitions, { binary: options.binary }, source, conversionFor, input.input.format, input.input.asset);
}

export async function buildConfiguredCommit(options: BuildOptions & { github: CommitOptions }) {
  const configuration = parseProjectedConfiguration(options.configuration);
  const definitions = selectDefinitions(configuration, options.selectedIds);
  const input = configuredInput(configuration, definitions);
  if (input.version !== 'git-branch') throw new Error('Git commit build requires a configured Git source; use --release for Release sources');
  const { bytes, source } = await readCommitInput(input, options.github).catch((error: unknown) => {
    if (!(error instanceof SourceError)) throw error;
    const ids = definitions.map(rule => rule.id).join(', ');
    throw new SourceError(error.code, `Rule set(s) ${ids}, Git input ${input.input.path}: ${error.message}`);
  });
  const conversionFor = convertInput(bytes, definitions, input.input.format, input.input.path);
  return buildProjectedConfiguration(configuration, definitions, { binary: options.binary }, source, conversionFor, input.input.format, input.input.path);
}

const wholeFileConverters = {
  'cidr-text': convertCidrText,
  'domain-suffix-text': convertDomainSuffixText,
  'typed-domain-text': convertTypedDomainText,
  'sing-box-domain-json': convertSingBoxDomainJson,
  'openai-voice-json': convertOpenAiVoice,
};

function conversionKey(rule: RuleDefinition) {
  return 'filter' in rule && rule.filter ? JSON.stringify(rule.filter) : rule.list;
}

type ConversionLookup = (rule: RuleDefinition) => Converted;

export function convertInput(bytes: Uint8Array, definitions: RuleDefinition[], format: SourceFormat, file: string): ConversionLookup {
  const conversions = convertSelections(bytes, definitions, format, file);
  return rule => {
    const result = conversions.get(conversionKey(rule));
    if (!result) throw new Error(`Missing conversion for rule set ${rule.id}`);
    return result;
  };
}

function convertSelections(bytes: Uint8Array, definitions: RuleDefinition[], format: SourceFormat, file: string): ReadonlyMap<string | undefined, Converted> {
  if (format === 'sing-box-source-json') return new Map([[undefined, convertSingBoxSourceJson(bytes, file)]]);
  if (format === 'clash-rule-list') {
    const converted = new Map<string | undefined, Converted>();
    for (const rule of definitions) {
      const key = conversionKey(rule);
      if (!converted.has(key)) converted.set(key, convertClashRuleList(bytes, file, 'filter' in rule ? rule.filter : undefined));
    }
    return converted;
  }
  if ((format === 'cidr-text' || format === 'domain-suffix-text') && definitions[0].list === undefined) {
    const converted = wholeFileConverters[format](bytes, file);
    const { usageCounts: _legacy, ...report } = converted.report;
    return new Map([[undefined, { ...converted, report }]]);
  }
  const lists = definitions.map(rule => {
    if (rule.list === undefined) throw new Error(`Missing list selection for ${rule.id}`);
    return rule.list;
  });
  if (format === 'plain-yaml') return convertPlainYaml(bytes, lists);
  const convert = wholeFileConverters[format];
  return new Map([...new Set(lists)].map(list => [list, convert(bytes, file, list)]));
}

async function buildProjectedConfiguration<Source extends RuleSource>(
  configuration: BuildConfiguration, definitions: ProjectedRuleDefinition[], options: NativeBuildOptions,
  source: Source, conversionFor: ConversionLookup, format: SourceFormat, file: string,
) {
  const built = await buildConfigured(configuration, definitions, options, source, conversionFor, format, file);
  const results = built.results.map((result): ConfiguredResult<ProjectedRuleDefinition, NativeBuild, ConversionReport> => {
    if (!('usageCounts' in result.report)) throw new Error('Missing legacy conversion usage counts');
    const report = result.report as ConversionReport;
    return result.status === 'failed' ? { ...result, report } : { ...result, report, native: requireProjectedBuild(result.native) };
  });
  return { ...built, results };
}

export async function buildConfigured<Source extends RuleSource, Definition extends RuleDefinition>(
  configuration: BuildConfiguration, definitions: Definition[], { binary, nativeBuild = buildRuleArtifacts }: NativeBuildOptions,
  source: Source, conversionFor: ConversionLookup, format: SourceFormat, file: string,
) {
  const tools = await configuredBuildTools(format);
  const results: ConfiguredResult<Definition>[] = [];
  for (const definition of definitions) {
    const converted = conversionFor(definition);
    const report = structuredClone(converted.report);
    if (!converted.ok) {
      results.push({ id: definition.id, definition, status: 'failed', report, error: converted.error });
      continue;
    }
    try {
      const native = await nativeBuild(converted.terms, binary, nativeTargetForRule(definition));
      if ('usages' in definition) {
        const projected = requireProjectedBuild(native);
        for (const usage of USAGES) {
          const declared = definition.usages[usage], actual = projected.usages[usage];
          if ('artifact' in declared
            ? !('artifactFiles' in actual) || actual.artifactFiles.join(',') !== `${declared.artifact}.json,${declared.artifact}.srs`
            : !('reason' in actual) || actual.reason !== declared.unavailable) {
            throw new Error(`Built artifacts do not match configured usage: ${usage}`);
          }
        }
      }
      const buildId = configuredBuildIdentity({ definition, target: configuration.target, source, tools, nativeBuildId: native.buildId,
        contracts: { sourceFormat: 4, buildRecord: CONFIGURED_BUILD_RECORD } });
      results.push({ id: definition.id, definition, status: 'built-validated', report, native, buildId });
    } catch (error) {
      report.status = 'failed';
      report.diagnostics.push(diagnostic('NATIVE_FAILED', String(error), { list: definition.list ?? '', file }));
      results.push({ id: definition.id, definition, status: 'failed', report, error: String(error) });
    }
  }
  return { source, configuration, tools, results };
}
