import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { validRepository, validBranch, validInputPath, validInputFile } from './source-input.js';
import { isMap, parseDocument, visit } from 'yaml';
import { USAGES, type Usage } from './projection.js';
import { ARTIFACT_REPOSITORY } from './publication.js';
import { CHINA_IP_INPUT, type CommitInput } from './github-commit.js';
import { OPENAI_VOICE_URL, type OpenAiVoiceInput } from './openai-voice-source.js';
import { V2FLY_RELEASE_INPUT, type ReleaseInput } from './release.js';

export type SourceInput = ReleaseInput | CommitInput | OpenAiVoiceInput;
export type SourceFormat = SourceInput['input']['format'];
type ConfiguredUsage = { artifact: 'domains' | 'route' } | { unavailable: 'empty' };

export function configuredLayout(format: SourceFormat) {
  return format !== 'plain-yaml'
    ? { stem: 'route', dns: 'dns-response', unavailable: 'dns-query' } as const
    : { stem: 'domains', dns: 'dns-query', unavailable: 'dns-response' } as const;
}
export interface RuleDefinition { id: string; source: string; list: string; stablePath: string; usages: Record<Usage, ConfiguredUsage> }
export interface BuildConfiguration {
  schemaVersion: 3;
  candidateRetentionDays: number;
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

export function parseRuleDefinition(input: unknown, format: SourceFormat = 'plain-yaml'): RuleDefinition {
  const { id, source, list, stablePath: path, usages } = exact(input, ['id', 'source', 'list', 'stablePath', 'usages'], 'rule definition');
  if (typeof id !== 'string' || !logicalId.test(id)) throw new Error(`Invalid logical ID: ${String(id)}`);
  if (typeof source !== 'string' || !logicalId.test(source)) throw new Error(`Invalid source ID: ${String(source)}`);
  if (typeof list !== 'string' || (format !== 'plain-yaml' ? list !== 'all' : !/^[a-z0-9][a-z0-9!._-]*$/.test(list))) {
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

export function parseSource(input: unknown): SourceInput {
  const raw = mapping(input, 'source');
  if (raw.version === 'openai-voice') {
    const source = exact(raw, ['version', 'input'], 'ChatGPT Voice source');
    const file = exact(source.input, ['format', 'url'], 'ChatGPT Voice input');
    if (file.format !== 'openai-voice-json' || file.url !== OPENAI_VOICE_URL) throw new Error('Invalid official ChatGPT Voice input');
    return { version: 'openai-voice', input: { format: 'openai-voice-json', url: OPENAI_VOICE_URL } };
  }
  const source = exact(raw, raw.version === 'git-branch' ? ['repository', 'version', 'branch', 'input'] : ['repository', 'version', 'input'], 'source');
  if (!validRepository(source.repository)) throw new Error('Invalid GitHub source repository');
  const file = mapping(source.input, 'source input');
  if (file.format !== 'plain-yaml' && file.format !== 'cidr-text') throw new Error('Unsupported input format');
  if (source.version === 'latest-release') {
    exact(file, ['format', 'asset', 'checksum'], 'Release input');
    if (!validInputFile(file.asset) || !validInputFile(file.checksum) || file.asset === file.checksum) throw new Error('Invalid Release asset or checksum');
    return { repository: source.repository, version: 'latest-release', input: { format: file.format, asset: file.asset, checksum: file.checksum } };
  }
  if (source.version === 'git-branch') {
    exact(file, ['format', 'path'], 'Git input');
    if (!validBranch(source.branch) || !validInputPath(file.path)) throw new Error('Invalid Git branch or input path');
    return { repository: source.repository, version: 'git-branch', branch: source.branch, input: { format: file.format, path: file.path } };
  }
  throw new Error('Unsupported source acquisition method');
}

/** Validate every definition before source access or output directory creation. */
export function parseBuildConfiguration(input: string): BuildConfiguration {
  const document = parseDocument(input, { uniqueKeys: true, stringKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(`Invalid build configuration YAML: ${document.errors[0]?.message ?? document.warnings[0]?.message}`);
  let alias = false;
  visit(document, { Alias() { alias = true; } });
  if (alias || !isMap(document.contents)) throw new Error('Invalid build configuration YAML');
  const raw = exact(document.toJS(), ['schemaVersion', 'candidateRetentionDays', 'sources', 'target', 'ruleSets'], 'configuration');
  if (raw.schemaVersion !== 3) throw new Error('Unsupported configuration version');
  if (!Number.isSafeInteger(raw.candidateRetentionDays) || Number(raw.candidateRetentionDays) <= 0) throw new Error('candidateRetentionDays must be a positive integer');
  const target = exact(raw.target, ['repository', 'branch'], 'target');
  if (target.repository !== ARTIFACT_REPOSITORY || typeof target.branch !== 'string'
    || (target.branch !== 'main' && !acceptanceBranch.test(target.branch))) {
    throw new Error('Target repository or branch is outside the trusted publication target');
  }
  const declarations = Object.entries(mapping(raw.sources, 'sources'));
  const sources = Object.fromEntries(declarations.map(([id, source]) => {
    if (!logicalId.test(id)) throw new Error(`Invalid source ID: ${id}`);
    return [id, parseSource(source)];
  }));
  if (!Array.isArray(raw.ruleSets)) throw new Error('ruleSets must be an explicit sequence');
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
  return { schemaVersion: 3, candidateRetentionDays: Number(raw.candidateRetentionDays), sources, target: { repository: target.repository, branch: target.branch }, ruleSets };
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

/** Read-only support for the one-time conversion of pre-operations journals. */
export function parseHistoricalConfiguration(input: string): BuildConfiguration {
  const document = parseDocument(input);
  if (document.get('schemaVersion') !== 2) return parseBuildConfiguration(input);
  document.set('schemaVersion', 3);
  // The old configuration had no retention policy. This value is only used to
  // validate old source/definition records; it is never accepted as policy.
  document.set('candidateRetentionDays', 1);
  return parseBuildConfiguration(document.toString());
}
