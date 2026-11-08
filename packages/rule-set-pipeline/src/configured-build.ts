import { readFile } from 'node:fs/promises';
import yamlPackage from 'yaml/package.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };
import { buildNative, type NativeBuild } from './native.js';
import { readReleaseInput, sha256, type ReleaseOptions } from './release.js';
import { diagnostic, type ConversionReport, type SourceRecord } from './types.js';

import { configuredReleaseInput, parseBuildConfiguration, type BuildConfiguration, type RuleDefinition } from './configuration.js';
import { convertPlainYaml } from './plain-yaml-adapter.js';
import { USAGES } from './projection.js';

export { parseBuildConfiguration } from './configuration.js';
export type { BuildConfiguration, RuleDefinition } from './configuration.js';

const adapters = { 'plain-yaml': convertPlainYaml };

export const CONFIGURED_BUILD_RECORD = 2;

export type ConfiguredResult = { id: string; definition: RuleDefinition; status: 'failed'; report: ConversionReport; error: string }
  | { id: string; definition: RuleDefinition; status: 'built-validated'; report: ConversionReport; native: NativeBuild; buildId: string };

export async function configuredBuildTools() {
  const implementationSha256 = sha256(Buffer.concat(await Promise.all(
    ['configuration', 'configured-build', 'release', 'plain-yaml-adapter', 'yaml-input', 'convert', 'types', 'projection', 'native', 'semantics'].map(name =>
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
  const input = configuredReleaseInput(configuration, definitions);
  const source = await readReleaseInput(options.release, input);
  const lists = adapters[input.input.format](source.bytes, definitions.map(rule => rule.list));
  const tools = await configuredBuildTools();
  const results: ConfiguredResult[] = [];
  for (const definition of definitions) {
    const converted = lists.get(definition.list)!;
    const report = structuredClone(converted.report);
    if (!converted.ok) {
      results.push({ id: definition.id, definition, status: 'failed', report, error: converted.error });
      continue;
    }
    try {
      const native = await buildNative(converted.terms, options.binary);
      for (const usage of USAGES) {
        const declared = definition.usages[usage], actual = native.usages[usage];
        if ('artifact' in declared
          ? !('artifactFiles' in actual) || actual.artifactFiles.join(',') !== `${declared.artifact}.json,${declared.artifact}.srs`
          : !('reason' in actual) || actual.reason !== declared.unavailable) {
          throw new Error(`Built artifacts do not match configured usage: ${usage}`);
        }
      }
      const buildId = sha256(JSON.stringify({ definition, target: configuration.target, source: source.source, tools, nativeBuildId: native.buildId,
        contracts: { sourceFormat: 4, buildRecord: CONFIGURED_BUILD_RECORD } }));
      results.push({ id: definition.id, definition, status: 'built-validated', report, native, buildId });
    } catch (error) {
      report.status = 'failed';
      report.diagnostics.push(diagnostic('NATIVE_FAILED', String(error), { list: definition.list }));
      results.push({ id: definition.id, definition, status: 'failed', report, error: String(error) });
    }
  }
  return { source: source.source, configuration, tools, results };
}
