import { readFile } from 'node:fs/promises';
import ipaddrPackage from 'ipaddr.js/package.json' with { type: 'json' };
import yamlPackage from 'yaml/package.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };
import { buildRuleArtifacts, decompileRuleBinary, invalidNativeSourceRules, NativeBuildError, requireProjectedBuild,
  type NativeBuilder, type NativeBuild, type ValidatedNativeBuild, type NativeBuildOptions } from './native.js';
import { readReleaseInput, sha256, SourceError, type ReleaseOptions } from './release.js';
import { diagnostic, type RuleConversionReport, type ConversionReport } from './types.js';
import { readCommitInput, type CommitOptions } from './github-commit.js';
import { configuredInput, configuredReleaseInput, nativeTargetForRule, parseProjectedConfiguration, type BuildConfiguration, type ProjectedRuleDefinition, type RuleDefinition, type SourceFormat } from './configuration.js';
import { convertClashRuleList } from './clash-rule-list-adapter.js';
import { convertOpenAiVoice } from './openai-voice-source.js';
import { convertDlcYaml, convertPlainYaml } from './plain-yaml-adapter.js';
import { convertDomainSuffixText } from './domain-suffix-text-adapter.js';
import { convertTypedDomainText } from './typed-domain-text-adapter.js';
import { convertSingBoxDomainJson } from './sing-box-domain-json-adapter.js';
import { convertCidrText } from './cidr-text-adapter.js';
import { USAGES, type BuildRule } from './projection.js';
import { convertDecodedSrs, convertSingBoxSourceJson, NATIVE_SOURCE_CONVERSION_POLICY, SRS_CONVERSION_POLICY, noConvertedRules, recordRejectedSourceRule,
  sourceBuildRules, sourceConversionReport, sourceRuleType, type SourceRuleEntries } from './sing-box-source-json-adapter.js';
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
  if (format === 'sing-box-source-json') files.push('sing-box-source-json-adapter');
  if (format === 'sing-box-srs') files.push('github-commit', 'sing-box-source-json-adapter');
  if (format === 'sing-box-source-json' || format === 'v2fly-dlc-yaml' || format === 'openai-voice-json') files.push('fixed-url-source');
  const implementationSha256 = sha256(Buffer.concat(await Promise.all(
    files.map(name =>
      readFile(new URL(`./${name}.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url))),
  )));
  return { pipeline: packageInfo.version, implementationSha256, conversionPolicy: format === 'sing-box-source-json' ? NATIVE_SOURCE_CONVERSION_POLICY
    : format === 'sing-box-srs' ? SRS_CONVERSION_POLICY
      : format === 'plain-yaml' ? 'v2fly-domain-v1' : `${format}-v1`,
    node: process.versions.node, yaml: yamlPackage.version, sourceFormat: 4,
    ...(format === 'cidr-text' || format === 'openai-voice-json' || format === 'clash-rule-list' ? { ipaddr: ipaddrPackage.version } : {}) };
}

interface BuildOptions { configuration: string; binary: string; selectedIds?: string[] }
type Converted = { ok: true; terms: readonly BuildRule[]; sourceEntries?: SourceRuleEntries; report: RuleConversionReport }
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
  const conversionsByRuleId = convertInput(bytes, definitions, input.input.format, input.input.asset);
  return buildProjectedConfiguration(configuration, definitions, { binary: options.binary }, source, conversionsByRuleId, input.input.format, input.input.asset);
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
  const conversionsByRuleId = convertInput(bytes, definitions, input.input.format, input.input.path);
  return buildProjectedConfiguration(configuration, definitions, { binary: options.binary }, source, conversionsByRuleId, input.input.format, input.input.path);
}

const wholeFileConverters = {
  'cidr-text': convertCidrText,
  'domain-suffix-text': convertDomainSuffixText,
  'typed-domain-text': convertTypedDomainText,
  'sing-box-domain-json': convertSingBoxDomainJson,
};

export async function convertRulesInput(bytes: Uint8Array, definitions: RuleDefinition[], format: SourceFormat, file: string,
  binary: () => string): Promise<ReadonlyMap<string, Converted>> {
  if (format !== 'sing-box-srs') return convertInput(bytes, definitions, format, file);
  try {
    const decoded: unknown = JSON.parse(await decompileRuleBinary(bytes, binary()));
    const converted = convertDecodedSrs(decoded);
    return new Map(definitions.map(({ id }) => [id, converted]));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot convert SRS input ${file}: ${detail}`, { cause: error });
  }
}

export function convertInput(bytes: Uint8Array, definitions: RuleDefinition[], format: Exclude<SourceFormat, 'sing-box-srs'>,
  file: string): ReadonlyMap<string, Converted> {
  if (format === 'sing-box-source-json') {
    const converted = convertSingBoxSourceJson(bytes, file);
    return new Map(definitions.map(({ id }) => [id, converted]));
  }
  if (format === 'clash-rule-list') {
    const selections = new Map<string | undefined, Converted>();
    return new Map(definitions.map(rule => {
      const filter = 'artifact' in rule && rule.list === undefined ? rule.filter : undefined;
      const key = filter && JSON.stringify(filter);
      let converted = selections.get(key);
      if (!converted) {
        converted = convertClashRuleList(bytes, file, filter);
        selections.set(key, converted);
      }
      return [rule.id, converted];
    }));
  }
  if (format === 'v2fly-dlc-yaml') {
    return convertDlcYaml(bytes, definitions.map(rule => {
      if (!('artifact' in rule) || rule.list === undefined) throw new Error(`Missing DLC list for ${rule.id}`);
      return rule;
    }), file);
  }
  if (format === 'plain-yaml') {
    const converted = convertPlainYaml(bytes, definitions.map(rule => rule.list!));
    return new Map(definitions.map(({ id, list }) => [id, converted.get(list!)!]));
  }
  const list = definitions[0].list;
  const converted = (() => {
    if (format === 'openai-voice-json') return convertOpenAiVoice(bytes, file, list);
    if (format === 'cidr-text' || format === 'domain-suffix-text') return wholeFileConverters[format](bytes, file, list);
    if (list === undefined) throw new Error(`Missing list selection for ${definitions[0].id}`);
    return wholeFileConverters[format](bytes, file, list);
  })();
  return new Map(definitions.map(({ id }) => [id, converted]));
}

async function buildProjectedConfiguration<Source extends RuleSource>(
  configuration: BuildConfiguration, definitions: ProjectedRuleDefinition[], options: NativeBuildOptions,
  source: Source, conversionsByRuleId: ReadonlyMap<string, Converted>, format: SourceFormat, file: string,
) {
  const built = await buildConfigured(configuration, definitions, options, source, conversionsByRuleId, format, file);
  const results = built.results.map((result): ConfiguredResult<ProjectedRuleDefinition, NativeBuild, ConversionReport> => {
    if (!('usageCounts' in result.report)) throw new Error('Missing legacy conversion usage counts');
    const report = result.report as ConversionReport;
    return result.status === 'failed' ? { ...result, report } : { ...result, report, native: requireProjectedBuild(result.native) };
  });
  return { ...built, results };
}

async function buildConvertedRules(converted: Extract<Converted, { ok: true }>, report: RuleConversionReport, file: string,
  nativeBuild: NativeBuilder, binary: string, target: ReturnType<typeof nativeTargetForRule>) {
  try {
    return await nativeBuild(converted.terms, binary, target);
  } catch (error) {
    const entries = converted.sourceEntries;
    const failedStep = error instanceof NativeBuildError && error.steps.at(-1);
    const sourceFailed = failedStep && (failedStep.args[1] === 'compile' || failedStep.args.at(-1) === 'source');
    if (!entries?.accepted.length || !sourceFailed) throw error;
    // Probe the original rule boundaries, before any wrapper for a lone survivor.
    const invalid = await invalidNativeSourceRules(entries.accepted.map(({ rule }) => ({ type: 'headless', rule })), binary);
    if (!invalid.size) throw error;
    const accepted = entries.accepted.filter(({ index, rule }, position) => {
      const reason = invalid.get(position);
      if (reason === undefined) return true;
      recordRejectedSourceRule(report, file, index, sourceRuleType(rule), `rules[${index}]: ${reason}`);
      return false;
    });
    const remaining = { ...entries, accepted };
    sourceConversionReport(report, remaining);
    if (accepted.length) return nativeBuild(sourceBuildRules(remaining), binary, target);
  }
}

export async function buildConfigured<Source extends RuleSource, Definition extends RuleDefinition>(
  configuration: BuildConfiguration, definitions: Definition[], { binary, nativeBuild = buildRuleArtifacts }: NativeBuildOptions,
  source: Source, conversionsByRuleId: ReadonlyMap<string, Converted>, format: SourceFormat, file: string,
) {
  const tools = await configuredBuildTools(format);
  const results: ConfiguredResult<Definition>[] = [];
  for (const definition of definitions) {
    const converted = conversionsByRuleId.get(definition.id)!;
    const report = structuredClone(converted.report);
    if ('artifact' in definition && 'usageCounts' in report) delete report.usageCounts;
    if (!converted.ok) {
      results.push({ id: definition.id, definition, status: 'failed', report, error: converted.error });
      continue;
    }
    try {
      const native = await buildConvertedRules(converted, report, file, nativeBuild, binary, nativeTargetForRule(definition));
      if (!native) {
        results.push({ id: definition.id, definition, status: 'failed', report, error: noConvertedRules(file, report) });
        continue;
      }
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
