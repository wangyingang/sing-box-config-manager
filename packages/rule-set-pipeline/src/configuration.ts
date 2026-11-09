import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isMap, parseDocument, visit } from 'yaml';
import { USAGES, type Usage } from './projection.js';
import { ARTIFACT_REPOSITORY } from './publication.js';
import { CHINA_IP_INPUT, type CommitInput } from './github-commit.js';
import { V2FLY_RELEASE_INPUT, type ReleaseInput } from './release.js';

type SourceInput = ReleaseInput | CommitInput;
type ConfiguredUsage = { artifact: 'domains' | 'route' } | { unavailable: 'empty' };

export function configuredLayout(format: SourceInput['input']['format']) {
  return format === 'cidr-text'
    ? { stem: 'route', dns: 'dns-response', unavailable: 'dns-query' } as const
    : { stem: 'domains', dns: 'dns-query', unavailable: 'dns-response' } as const;
}
export interface RuleDefinition { id: string; source: string; list: string; stablePath: string; usages: Record<Usage, ConfiguredUsage> }
export interface BuildConfiguration {
  schemaVersion: 2;
  sources: Record<string, SourceInput>;
  target: { repository: typeof ARTIFACT_REPOSITORY; branch: string };
  ruleSets: RuleDefinition[];
}

const logicalId = /^[a-z][a-z0-9-]*$/;
const stablePath = /^stable\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const acceptanceBranch = /^acceptance-[a-zA-Z0-9._-]+$/;

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, fields: string[], label: string) {
  const record = mapping(value, label);
  if (Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`${label} fields are invalid`);
  }
  return record;
}

export function parseRuleDefinition(input: unknown, format: SourceInput['input']['format'] = 'plain-yaml'): RuleDefinition {
  const { id, source, list, stablePath: path, usages } = exact(input, ['id', 'source', 'list', 'stablePath', 'usages'], 'rule definition');
  if (typeof id !== 'string' || !logicalId.test(id)) throw new Error(`Invalid logical ID: ${String(id)}`);
  if (typeof source !== 'string' || !logicalId.test(source)) throw new Error(`Invalid source ID: ${String(source)}`);
  if (typeof list !== 'string' || (format === 'cidr-text' ? list !== 'all' : !/^[a-z0-9][a-z0-9!._-]*$/.test(list))) {
    throw new Error(`Invalid ${format} list: ${String(list)}`);
  }
  if (typeof path !== 'string' || !stablePath.test(path)) {
    throw new Error(`Invalid stable path: ${String(path)}`);
  }
  const declared = exact(usages, [...USAGES], 'usages');
  const layout = configuredLayout(format);
  function usage(key: Usage): ConfiguredUsage {
    if (key === layout.unavailable) {
      if (exact(declared[key], ['unavailable'], key).unavailable !== 'empty') throw new Error(`Invalid ${format} usage: ${key}`);
      return { unavailable: 'empty' };
    }
    const artifact = layout.stem;
    if (exact(declared[key], ['artifact'], key).artifact !== artifact) throw new Error(`Invalid ${format} usage: ${key}`);
    return { artifact };
  }
  return { id, source, list, stablePath: path, usages: { route: usage('route'), 'dns-query': usage('dns-query'), 'dns-response': usage('dns-response') } };
}

function parseSource(input: unknown): SourceInput {
  if (isDeepStrictEqual(input, CHINA_IP_INPUT)) return structuredClone(CHINA_IP_INPUT);
  const source = exact(input, ['repository', 'version', 'input'], 'source');
  const file = exact(source.input, ['format', 'asset', 'checksum'], 'source input');
  const trusted = V2FLY_RELEASE_INPUT;
  if (source.repository !== trusted.repository || source.version !== trusted.version || file.format !== trusted.input.format
    || file.asset !== trusted.input.asset || file.checksum !== trusted.input.checksum) throw new Error('Unsupported or untrusted source');
  return { repository: source.repository, version: source.version, input: { format: file.format, asset: file.asset, checksum: file.checksum } };
}

/** Validate every definition before source access or output directory creation. */
export function parseBuildConfiguration(input: string): BuildConfiguration {
  const document = parseDocument(input, { uniqueKeys: true, stringKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(`Invalid build configuration YAML: ${document.errors[0]?.message ?? document.warnings[0]?.message}`);
  let alias = false;
  visit(document, { Alias() { alias = true; } });
  if (alias || !isMap(document.contents)) throw new Error('Invalid build configuration YAML');
  const raw = exact(document.toJS(), ['schemaVersion', 'sources', 'target', 'ruleSets'], 'configuration');
  if (raw.schemaVersion !== 2) throw new Error('Unsupported configuration version');
  const target = exact(raw.target, ['repository', 'branch'], 'target');
  if (target.repository !== ARTIFACT_REPOSITORY || typeof target.branch !== 'string'
    || (target.branch !== 'main' && !acceptanceBranch.test(target.branch))) {
    throw new Error('Target repository or branch is outside the trusted publication target');
  }
  const declarations = Object.entries(mapping(raw.sources, 'sources'));
  if (!declarations.length) throw new Error('At least one source must be declared');
  const sources = Object.fromEntries(declarations.map(([id, source]) => {
    if (!logicalId.test(id)) throw new Error(`Invalid source ID: ${id}`);
    return [id, parseSource(source)];
  }));
  if (!Array.isArray(raw.ruleSets) || !raw.ruleSets.length) throw new Error('ruleSets must be a nonempty sequence');
  const ids = new Set<string>(), paths = new Set<string>();
  const ruleSets = raw.ruleSets.map(entry => {
    const { source } = mapping(entry, 'rule definition');
    if (typeof source !== 'string' || !Object.hasOwn(sources, source)) throw new Error(`Unknown source: ${String(source)}`);
    const rule = parseRuleDefinition(entry, sources[source].input.format);
    if (ids.has(rule.id)) throw new Error(`Duplicate logical ID: ${rule.id}`);
    const path = rule.stablePath;
    if ([...paths].some(other => other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`))) {
      throw new Error(`Conflicting stable path: ${path}`);
    }
    ids.add(rule.id); paths.add(path);
    return rule;
  });
  return { schemaVersion: 2, sources, target: { repository: target.repository, branch: target.branch }, ruleSets };
}

export function configuredInput(configuration: BuildConfiguration, definitions: readonly RuleDefinition[]) {
  const first = definitions[0];
  if (!first) throw new Error('Select at least one rule set');
  const source = configuration.sources[first.source];
  if (definitions.some(rule => !isDeepStrictEqual(source, configuration.sources[rule.source]))) {
    throw new Error('Select rule sets from one source');
  }
  return source;
}

export function configuredReleaseInput(configuration: BuildConfiguration, definitions: readonly RuleDefinition[]): ReleaseInput {
  const source = configuredInput(configuration, definitions);
  if (source.version !== 'latest-release') throw new Error('Select rule sets from one Release source');
  return source;
}

export function readOfficialConfiguration() {
  // Source runs from src/; the package build runs from dist/src/.
  return readFileSync(new URL(import.meta.url.endsWith('.ts') ? '../config/rulesets.yml' : '../../config/rulesets.yml', import.meta.url), 'utf8');
}

export function configuredProjections({ stablePath, usages }: RuleDefinition, branch: string) {
  const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/${stablePath}`;
  function projection(usage: ConfiguredUsage) {
    if ('unavailable' in usage) return { unavailable: usage.unavailable } as const;
    return { formats: {
      binary: { url: `${prefix}/${usage.artifact}.srs`, requiredCapabilities: [] },
      source: { url: `${prefix}/${usage.artifact}.json`, requiredCapabilities: [] },
    } };
  }
  return { route: projection(usages.route), 'dns-query': projection(usages['dns-query']), 'dns-response': projection(usages['dns-response']) };
}

export function configuredSubscriptions({ ruleSets, target }: BuildConfiguration) {
  return Object.fromEntries(ruleSets.map(rule => [rule.id, {
    schemaVersion: 2, systemRuleSetId: rule.id, targetVersion: '1.14.4', sourceFormatVersion: 4,
    projections: configuredProjections(rule, target.branch),
  }]));
}
