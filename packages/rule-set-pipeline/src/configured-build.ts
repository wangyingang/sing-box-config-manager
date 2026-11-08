import { readFile } from 'node:fs/promises';
import ipaddrPackage from 'ipaddr.js/package.json' with { type: 'json' };
import yamlPackage from 'yaml/package.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };
import { buildNative, type NativeBuild } from './native.js';
import { readReleaseInput, sha256, type ReleaseOptions } from './release.js';
import { diagnostic, type ConversionReport, type SourceRecord } from './types.js';
import { readCommitInput, type CommitOptions, type CommitSourceRecord } from './github-commit.js';
import { configuredInput, configuredReleaseInput, parseBuildConfiguration, type BuildConfiguration, type RuleDefinition } from './configuration.js';
import { convertPlainYaml } from './plain-yaml-adapter.js';
import { convertCidrText } from './cidr-text-adapter.js';
import { USAGES, type BuildTerm } from './projection.js';

export { parseBuildConfiguration } from './configuration.js';
export type { BuildConfiguration, RuleDefinition } from './configuration.js';

export const CONFIGURED_BUILD_RECORD = 2;

export type ConfiguredResult = { id: string; definition: RuleDefinition; status: 'failed'; report: ConversionReport; error: string }
  | { id: string; definition: RuleDefinition; status: 'built-validated'; report: ConversionReport; native: NativeBuild; buildId: string };

export async function configuredBuildTools(format: 'plain-yaml' | 'cidr-text' = 'plain-yaml') {
  const files = ['configuration', 'configured-build', 'release', 'plain-yaml-adapter', 'yaml-input', 'convert',
    'types', 'projection', 'native', 'semantics'];
  if (format === 'cidr-text') files.push('github-commit', 'cidr-text-adapter');
  const implementationSha256 = sha256(Buffer.concat(await Promise.all(
    files.map(name =>
      readFile(new URL(`./${name}.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url))),
  )));
  return { pipeline: packageInfo.version, implementationSha256, conversionPolicy: format === 'cidr-text' ? 'cidr-text-v1' : 'v2fly-domain-v1',
    node: process.versions.node, yaml: yamlPackage.version, sourceFormat: 4,
    ...(format === 'cidr-text' ? { ipaddr: ipaddrPackage.version } : {}) };
}

interface BuildOptions { configuration: string; binary: string; selectedIds?: string[] }
type Converted = { ok: true; terms: readonly BuildTerm[]; report: ConversionReport }
  | { ok: false; report: ConversionReport; error: string };

function selectDefinitions(configuration: BuildConfiguration, selectedIds?: string[]) {
  if (selectedIds && (new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !configuration.ruleSets.some(rule => rule.id === id)))) {
    throw new Error('Selected logical ID is duplicate or unknown');
  }
  const definitions = selectedIds ? configuration.ruleSets.filter(rule => selectedIds.includes(rule.id)) : configuration.ruleSets;
  if (!definitions.length) throw new Error('At least one logical ID must be selected');
  return definitions;
}

export async function buildConfiguredRelease(options: BuildOptions & { release: ReleaseOptions }) {
  const configuration = parseBuildConfiguration(options.configuration);
  const definitions = selectDefinitions(configuration, options.selectedIds);
  const input = configuredReleaseInput(configuration, definitions);
  const { bytes, source } = await readReleaseInput(options.release, input);
  const lists = convertPlainYaml(bytes, definitions.map(rule => rule.list));
  return buildConfigured(configuration, definitions, options.binary, source, lists, input.input.format, input.input.asset);
}

export async function buildConfiguredCommit(options: BuildOptions & { github: CommitOptions }) {
  const configuration = parseBuildConfiguration(options.configuration);
  const definitions = selectDefinitions(configuration, options.selectedIds);
  const input = configuredInput(configuration, definitions);
  if (input.version !== 'git-branch') throw new Error('Git commit build requires a configured Git source; use --release for Release sources');
  const { bytes, source } = await readCommitInput(input, options.github);
  const list = definitions[0].list;
  const lists = new Map([[list, convertCidrText(bytes, input.input.path, list)]]);
  return buildConfigured(configuration, definitions, options.binary, source, lists, input.input.format, input.input.path);
}

async function buildConfigured<Source extends SourceRecord | CommitSourceRecord>(
  configuration: BuildConfiguration, definitions: RuleDefinition[], binary: string, source: Source,
  lists: ReadonlyMap<string, Converted>, format: 'plain-yaml' | 'cidr-text', file: string,
) {
  const tools = await configuredBuildTools(format);
  const results: ConfiguredResult[] = [];
  for (const definition of definitions) {
    const converted = lists.get(definition.list)!;
    const report = structuredClone(converted.report);
    if (!converted.ok) {
      results.push({ id: definition.id, definition, status: 'failed', report, error: converted.error });
      continue;
    }
    try {
      const native = await buildNative(converted.terms, binary);
      for (const usage of USAGES) {
        const declared = definition.usages[usage], actual = native.usages[usage];
        if ('artifact' in declared
          ? !('artifactFiles' in actual) || actual.artifactFiles.join(',') !== `${declared.artifact}.json,${declared.artifact}.srs`
          : !('reason' in actual) || actual.reason !== declared.unavailable) {
          throw new Error(`Built artifacts do not match configured usage: ${usage}`);
        }
      }
      const buildId = sha256(JSON.stringify({ definition, target: configuration.target, source, tools, nativeBuildId: native.buildId,
        contracts: { sourceFormat: 4, buildRecord: CONFIGURED_BUILD_RECORD } }));
      results.push({ id: definition.id, definition, status: 'built-validated', report, native, buildId });
    } catch (error) {
      report.status = 'failed';
      report.diagnostics.push(diagnostic('NATIVE_FAILED', String(error), { list: definition.list, file }));
      results.push({ id: definition.id, definition, status: 'failed', report, error: String(error) });
    }
  }
  return { source, configuration, tools, results };
}
