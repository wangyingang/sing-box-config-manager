import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { reservedArtifactBasename, validArtifactBasename } from './artifact-path.js';
import { validRepository, validBranch, validInputPath, validInputFile } from './source-input.js';
import { isMap, parseDocument, visit } from 'yaml';
import { USAGES, type Usage } from './projection.js';
import { ARTIFACT_REPOSITORY } from './publication.js';
import { CHINA_IP_INPUT, isCommitInputFormat, type CommitInput } from './github-commit.js';
import { OPENAI_VOICE_FILE, OPENAI_VOICE_URL, type OpenAiVoiceInput } from './openai-voice-source.js';
import { V2FLY_RELEASE_INPUT, type ReleaseInput } from './release.js';
import { validFixedUrl, type FixedUrlInput } from './fixed-url-source.js';
import { validClashRuleType, type ClashTypeFilter } from './clash-rule-list-adapter.js';

export type SourceInput = ReleaseInput | CommitInput | OpenAiVoiceInput | FixedUrlInput;
export type SourceFormat = SourceInput['input']['format'];
type GitHubBranchSource = { version: 'github-branch'; repository: string; branch: string };
type ConfiguredSource = SourceInput | GitHubBranchSource;
const branchFileFormats = ['cidr-text', 'domain-suffix-text', 'clash-rule-list'] as const;
const isBranchFileFormat = (value: unknown): value is (typeof branchFileFormats)[number] =>
  branchFileFormats.some(format => format === value);
type ProjectedSourceFormat = Exclude<SourceFormat, 'sing-box-source-json' | 'clash-rule-list'>;
type AvailableUsage = { artifact: string };
type ConfiguredUsage = AvailableUsage | { unavailable: 'empty' };
type DnsUsage = Exclude<Usage, 'route'>;

const formatCapabilities = {
  'plain-yaml': { dns: 'dns-query', namedLists: true },
  'domain-suffix-text': { dns: 'dns-query', namedLists: false },
  'typed-domain-text': { dns: 'dns-query', namedLists: false },
  'sing-box-domain-json': { dns: 'dns-query', namedLists: false },
  'cidr-text': { dns: 'dns-response', namedLists: false },
  'openai-voice-json': { dns: 'dns-response', namedLists: false },
} as const satisfies Record<ProjectedSourceFormat, { dns: DnsUsage; namedLists: boolean }>;

export function configuredUsages(format: ProjectedSourceFormat) {
  const dns = formatCapabilities[format].dns;
  const unavailable = dns === 'dns-query' ? 'dns-response' : 'dns-query';
  return { dns, unavailable } as const;
}
interface RuleLocation {
  id: string;
  source: string;
  stablePath: string;
}

export interface ProjectedRuleDefinition extends RuleLocation {
  list: string;
  usages: Record<Usage, ConfiguredUsage> & { route: AvailableUsage };
}

export interface SingleArtifactDefinition extends RuleLocation {
  artifact: string;
  list?: never;
  filter?: ClashTypeFilter;
}

export type RuleDefinition = ProjectedRuleDefinition | SingleArtifactDefinition;
export interface BuildConfiguration {
  schemaVersion: 3 | 4;
  candidateRetentionDays: number;
  sources: Record<string, ConfiguredSource>;
  branchInputs?: Record<string, CommitInput>;
  target: { repository: typeof ARTIFACT_REPOSITORY; branch: string };
  ruleSets: RuleDefinition[];
}

type ProjectedSourceInput = ReleaseInput | OpenAiVoiceInput | (Omit<CommitInput, 'input'> & {
  input: { format: Exclude<CommitInput['input']['format'], 'clash-rule-list'>; path: string };
});
export type ProjectedConfiguration = Omit<BuildConfiguration, 'schemaVersion' | 'sources' | 'ruleSets' | 'branchInputs'> & {
  schemaVersion: 3; sources: Record<string, ProjectedSourceInput>; ruleSets: ProjectedRuleDefinition[];
};

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

function ruleLocation({ id, source, stablePath: path }: Record<string, unknown>, pathField: string): RuleLocation {
  if (typeof id !== 'string' || !logicalId.test(id)) throw new Error(`Invalid logical ID: ${String(id)}`);
  if (typeof source !== 'string' || !logicalId.test(source)) throw new Error(`Invalid source ID: ${String(source)}`);
  if (typeof path !== 'string' || !stablePath.test(path)) throw new Error(`Invalid ${pathField}: ${String(path)}`);
  return { id, source, stablePath: path };
}

function parseClashTypeFilter(input: unknown): ClashTypeFilter {
  const filter = mapping(input, 'filter');
  const action = Object.hasOwn(filter, 'include') ? 'include' : 'exclude';
  const { type } = exact(exact(filter, [action], 'filter')[action], ['type'], `filter ${action}`);
  const { anyOf } = exact(type, ['anyOf'], `filter ${action}.type`);
  if (!Array.isArray(anyOf) || !anyOf.length || !anyOf.every(validClashRuleType)) {
    throw new Error(`filter ${action}.type.anyOf must be a nonempty list of Clash rule types`);
  }
  const condition = { type: { anyOf: [...new Set(anyOf)].sort() } };
  return action === 'include' ? { include: condition } : { exclude: condition };
}

function parseSingleArtifactDefinition(input: unknown, format: SourceFormat): SingleArtifactDefinition {
  const fields = ['id', 'source', 'stablePath', 'artifact'];
  const hasFilter = Object.hasOwn(mapping(input, 'rule definition'), 'filter');
  if (hasFilter) fields.push('filter');
  const definition = exact(input, fields, 'rule definition');
  const location = ruleLocation(definition, 'publishPath');
  if (!validArtifactBasename(definition.artifact) || reservedArtifactBasename(definition.artifact)) {
    throw new Error(`Invalid artifact basename: ${String(definition.artifact)}`);
  }
  if (hasFilter && format !== 'clash-rule-list') throw new Error(`filter is not supported for ${format}`);
  return { ...location, artifact: definition.artifact, ...(hasFilter && { filter: parseClashTypeFilter(definition.filter) }) };
}

export function parseStoredRuleDefinition(input: unknown, format: SourceFormat): RuleDefinition {
  if (Object.hasOwn(mapping(input, 'rule definition'), 'artifact')) return parseSingleArtifactDefinition(input, format);
  if (format === 'sing-box-source-json' || format === 'clash-rule-list') throw new Error(`${format} requires a single artifact`);
  return parseRuleDefinition(input, format);
}

export function parseRuleDefinition(input: unknown, format: ProjectedSourceFormat = 'plain-yaml'): ProjectedRuleDefinition {
  const definition = exact(input, ['id', 'source', 'list', 'stablePath', 'usages'], 'rule definition');
  const { list, usages } = definition;
  const { id, source, stablePath: path } = ruleLocation(definition, 'stable path');
  if (typeof list !== 'string' || (formatCapabilities[format].namedLists ? !/^[a-z0-9][a-z0-9!._-]*$/.test(list) : list !== 'all')) {
    throw new Error(`Invalid ${format} list: ${String(list)}`);
  }
  const declared = exact(usages, [...USAGES], 'usages');
  const layout = configuredUsages(format);
  function availableUsage(key: Usage): AvailableUsage {
    const { artifact } = exact(declared[key], ['artifact'], key);
    if (!validArtifactBasename(artifact)) {
      throw new Error(`Invalid ${format} usage: ${key}: artifact must be a file basename of at most 250 characters using lowercase letters, digits, hyphens or underscores`);
    }
    if (reservedArtifactBasename(artifact) || (format === 'openai-voice-json' && `${artifact}.json` === OPENAI_VOICE_FILE)) {
      throw new Error(`Invalid ${format} usage: ${key}: artifact ${artifact} conflicts with metadata or an input snapshot`);
    }
    return { artifact };
  }
  const route = availableUsage('route');
  const dns = availableUsage(layout.dns);
  if (route.artifact !== dns.artifact) throw new Error(`Invalid ${format} usage: ${layout.dns} must share the route artifact basename`);
  if (exact(declared[layout.unavailable], ['unavailable'], layout.unavailable).unavailable !== 'empty') {
    throw new Error(`Invalid ${format} usage: ${layout.unavailable}`);
  }
  const empty = { unavailable: 'empty' } as const;
  return { id, source, list, stablePath: path, usages: { route,
    'dns-query': layout.dns === 'dns-query' ? dns : empty, 'dns-response': layout.dns === 'dns-response' ? dns : empty } };
}

export function parseSource(input: unknown): SourceInput {
  const raw = mapping(input, 'source');
  if (raw.version === 'url') {
    const { input: declaration } = exact(raw, ['version', 'input'], 'URL source');
    const { format, url } = exact(declaration, ['format', 'url'], 'URL input');
    if (format !== 'sing-box-source-json' || !validFixedUrl(url)) throw new Error('Invalid sing-box-source-json HTTPS input');
    return { version: 'url', input: { format, url } };
  }
  if (raw.version === 'openai-voice') {
    const source = exact(raw, ['version', 'input'], 'ChatGPT Voice source');
    const file = exact(source.input, ['format', 'url'], 'ChatGPT Voice input');
    if (file.format !== 'openai-voice-json' || file.url !== OPENAI_VOICE_URL) throw new Error('Invalid official ChatGPT Voice input');
    return { version: 'openai-voice', input: { format: 'openai-voice-json', url: OPENAI_VOICE_URL } };
  }
  const source = exact(raw, raw.version === 'git-branch' ? ['repository', 'version', 'branch', 'input'] : ['repository', 'version', 'input'], 'source');
  if (!validRepository(source.repository)) throw new Error('Invalid GitHub source repository');
  const file = mapping(source.input, 'source input');
  if (source.version === 'latest-release') {
    exact(file, ['format', 'asset', 'checksum'], 'Release input');
    if (file.format !== 'plain-yaml' && file.format !== 'cidr-text') throw new Error('Unsupported Release input format');
    if (!validInputFile(file.asset) || !validInputFile(file.checksum) || file.asset === file.checksum) throw new Error('Invalid Release asset or checksum');
    return { repository: source.repository, version: 'latest-release', input: { format: file.format, asset: file.asset, checksum: file.checksum } };
  }
  if (source.version === 'git-branch') {
    exact(file, ['format', 'path'], 'Git input');
    if (!isCommitInputFormat(file.format)) throw new Error('Unsupported Git input format');
    if (!validBranch(source.branch) || !validInputPath(file.path)) throw new Error('Invalid Git branch or input path');
    return { repository: source.repository, version: 'git-branch', branch: source.branch, input: { format: file.format, path: file.path } };
  }
  throw new Error('Unsupported source acquisition method');
}

function parseV4Source(input: unknown, id: string): ConfiguredSource {
  const label = `source ${id}`;
  const { fetch } = mapping(input, label);
  const { method } = mapping(fetch, `${label} fetch`);
  if (method === 'github-branch') {
    exact(input, ['fetch'], label);
    const { repository, branch } = exact(fetch, ['method', 'repository', 'branch'], `${label} fetch`);
    if (!validRepository(repository) || !validBranch(branch)) throw new Error(`Invalid GitHub repository or branch for ${label}`);
    return { version: 'github-branch', repository, branch };
  }
  if (method !== 'url') throw new Error(`Unsupported source acquisition method: ${String(method)}`);
  const { format } = exact(input, ['fetch', 'format'], label);
  const { url } = exact(fetch, ['method', 'url'], `${label} fetch`);
  return parseSource({ version: 'url', input: { format, url } });
}

/** Validate every definition before source access or output directory creation. */
export function parseBuildConfiguration(input: string): BuildConfiguration {
  const document = parseDocument(input, { uniqueKeys: true, stringKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(`Invalid build configuration YAML: ${document.errors[0]?.message ?? document.warnings[0]?.message}`);
  let alias = false;
  visit(document, { Alias() { alias = true; } });
  if (alias || !isMap(document.contents)) throw new Error('Invalid build configuration YAML');
  const raw = exact(document.toJS(), ['schemaVersion', 'candidateRetentionDays', 'sources', 'target', 'ruleSets'], 'configuration');
  if (raw.schemaVersion !== 3 && raw.schemaVersion !== 4) throw new Error('Unsupported configuration version');
  if (!Number.isSafeInteger(raw.candidateRetentionDays) || Number(raw.candidateRetentionDays) <= 0) throw new Error('candidateRetentionDays must be a positive integer');
  const target = exact(raw.target, ['repository', 'branch'], 'target');
  if (target.repository !== ARTIFACT_REPOSITORY || typeof target.branch !== 'string'
    || (target.branch !== 'main' && !acceptanceBranch.test(target.branch))) {
    throw new Error('Target repository or branch is outside the trusted publication target');
  }
  const declarations = Object.entries(mapping(raw.sources, 'sources'));
  const sources = Object.fromEntries(declarations.map(([id, source]) => {
    if (!logicalId.test(id)) throw new Error(`Invalid source ID: ${id}`);
    if (raw.schemaVersion === 4) return [id, parseV4Source(source, id)];
    const parsed = parseSource(source);
    if (parsed.version === 'url') throw new Error('URL sources require configuration v4');
    if (parsed.input.format === 'clash-rule-list') throw new Error('clash-rule-list requires configuration v4');
    return [id, parsed];
  }));
  const branchInputs: Record<string, CommitInput> = Object.create(null);
  const entries = raw.schemaVersion === 4 ? Object.entries(mapping(raw.ruleSets, 'ruleSets')).map(([id, entry]) => {
    const label = `rule set ${id}`;
    const fields = ['data', 'publishPath', 'artifact'];
    const hasFilter = Object.hasOwn(mapping(entry, label), 'filter');
    if (hasFilter) fields.push('filter');
    const { data, publishPath, artifact, filter } = exact(entry, fields, label);
    const dataLabel = `rule set ${id} data`;
    const { source } = mapping(data, dataLabel);
    if (typeof source !== 'string' || !Object.hasOwn(sources, source)) {
      throw new Error(`Rule set ${id}: unknown source ${String(source)}`);
    }
    const declaration = sources[source];
    if (declaration.version === 'github-branch') {
      const { file, format } = exact(data, ['source', 'file', 'format'], dataLabel);
      if (!validInputPath(file) || !isBranchFileFormat(format)) {
        throw new Error(`Rule set ${id}: invalid GitHub branch file or format`);
      }
      branchInputs[id] = { repository: declaration.repository, version: 'git-branch', branch: declaration.branch,
        input: { format, path: file } };
    } else exact(data, ['source'], dataLabel);
    return { id, source, stablePath: publishPath, artifact, ...(hasFilter && { filter }) };
  }) : raw.ruleSets;
  if (!Array.isArray(entries)) throw new Error('ruleSets must be an explicit sequence');
  const ids = new Set<string>(), paths = new Set<string>();
  const ruleSets = entries.map(entry => {
    const { id, source } = mapping(entry, 'rule definition');
    if (typeof source !== 'string' || !Object.hasOwn(sources, source)) {
      throw new Error(`Rule set ${String(id)}: unknown source ${String(source)}`);
    }
    const input = configuredRuleInput({ sources, branchInputs }, { id: String(id), source }).input;
    let rule: RuleDefinition;
    try {
      if (raw.schemaVersion === 4) rule = parseSingleArtifactDefinition(entry, input.format);
      else {
        if (input.format === 'sing-box-source-json' || input.format === 'clash-rule-list') throw new Error(`${input.format} requires configuration v4`);
        rule = parseRuleDefinition(entry, input.format);
      }
    }
    catch (error) {
      const file = 'path' in input ? input.path : 'asset' in input ? input.asset : input.url;
      throw new Error(`Rule set ${String(id)}, source ${source} (${file}): ${(error as Error).message}`, { cause: error });
    }
    if (ids.has(rule.id)) throw new Error(`Duplicate logical ID: ${rule.id}`);
    const path = rule.stablePath;
    if ([...paths].some(other => other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`))) {
      throw new Error(`Conflicting stable path: ${path}`);
    }
    ids.add(rule.id); paths.add(path);
    return rule;
  });
  return { schemaVersion: raw.schemaVersion, candidateRetentionDays: Number(raw.candidateRetentionDays), sources,
    target: { repository: target.repository, branch: target.branch }, ruleSets,
    ...(Object.keys(branchInputs).length && { branchInputs }) };
}

export function configuredRuleInput(configuration: Pick<BuildConfiguration, 'sources' | 'branchInputs'>,
  { id, source }: Pick<RuleDefinition, 'id' | 'source'>): SourceInput {
  const declaration = configuration.sources[source];
  if (declaration.version !== 'github-branch') return declaration;
  const input = configuration.branchInputs?.[id];
  if (!input) throw new Error(`Missing GitHub branch file for rule set ${id}`);
  return input;
}

export function configuredInput<Input extends SourceInput>(configuration: { sources: Record<string, Input> }, definitions: readonly RuleDefinition[]) {
  const first = definitions[0];
  if (!first) throw new Error('Select at least one rule set');
  const source = configuration.sources[first.source];
  if (definitions.some(rule => !isDeepStrictEqual(source, configuration.sources[rule.source]))) {
    throw new Error('Select rule sets from one source');
  }
  return source;
}

export function configuredReleaseInput(configuration: ProjectedConfiguration, definitions: readonly RuleDefinition[]): ReleaseInput {
  const source = configuredInput(configuration, definitions);
  if (source.version !== 'latest-release') throw new Error('Select rule sets from one Release source');
  return source;
}

export function parseProjectedConfiguration(input: string): ProjectedConfiguration {
  const configuration = parseBuildConfiguration(input);
  if (configuration.schemaVersion !== 3) throw new Error('Projected rule operations require configuration v3');
  return configuration as ProjectedConfiguration;
}

export function readOfficialConfiguration() {
  // Source runs from src/; the package build runs from dist/src/.
  return readFileSync(new URL(import.meta.url.endsWith('.ts') ? '../config/rulesets.yml' : '../../config/rulesets.yml', import.meta.url), 'utf8');
}

export function nativeTargetForRule(definition: RuleDefinition) {
  return 'artifact' in definition ? { artifact: definition.artifact, kind: 'single-artifact' as const } : definition.usages.route.artifact;
}

export function configuredProjections({ stablePath, usages }: ProjectedRuleDefinition, branch: string) {
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

export function artifactSubscription(definition: SingleArtifactDefinition, branch: string) {
  const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/${definition.stablePath}/${definition.artifact}`;
  return { schemaVersion: 3, systemRuleSetId: definition.id, targetVersion: '1.14.4', sourceFormatVersion: 4,
    formats: { source: { url: `${prefix}.json` }, binary: { url: `${prefix}.srs` } } };
}

export function configuredSubscription(rule: ProjectedRuleDefinition, branch: string) {
  return {
    schemaVersion: 2, systemRuleSetId: rule.id, targetVersion: '1.14.4', sourceFormatVersion: 4,
    projections: configuredProjections(rule, branch),
  };
}

export function configuredSubscriptions({ ruleSets, target }: ProjectedConfiguration) {
  return Object.fromEntries(ruleSets.map(rule => [rule.id, configuredSubscription(rule, target.branch)]));
}

/** Read-only support for the one-time conversion of pre-operations journals. */
export function parseHistoricalConfiguration(input: string): ProjectedConfiguration {
  const document = parseDocument(input);
  if (document.get('schemaVersion') !== 2) return parseProjectedConfiguration(input);
  document.set('schemaVersion', 3);
  // The old configuration had no retention policy. This value is only used to
  // validate old source/definition records; it is never accepted as policy.
  document.set('candidateRetentionDays', 1);
  return parseProjectedConfiguration(document.toString());
}
