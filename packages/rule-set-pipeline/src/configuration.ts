import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { reservedArtifactBasename, validArtifactBasename } from './artifact-path.js';
import { validRepository, validBranch, validInputPath, validInputFile } from './source-input.js';
import { LineCounter, parseDocument, visit } from 'yaml';
import { USAGES, type Usage } from './projection.js';
import { ARTIFACT_REPOSITORY } from './publication.js';
import { CHINA_IP_INPUT, isCommitInputFormat, type CommitInput } from './github-commit.js';
import { OPENAI_VOICE_FILE, OPENAI_VOICE_URL, type OpenAiVoiceInput } from './openai-voice-source.js';
import { V2FLY_RELEASE_INPUT, type ReleaseInput } from './release.js';
import { validFixedUrl, type FixedUrlInput } from './fixed-url-source.js';
import { validClashRuleType, type ClashTypeFilter } from './clash-rule-list-adapter.js';
import { validateRulesConfigurationV4 } from './rules-configuration-v4.js';
import { singleArtifactPaths } from './stable-rule-paths.js';

export type SourceInput = ReleaseInput | CommitInput | OpenAiVoiceInput | FixedUrlInput;
export type SourceFormat = SourceInput['input']['format'];
type GitHubBranchSource = { version: 'github-branch'; repository: string; branch: string };
type ConfiguredSource = SourceInput | GitHubBranchSource;
type AvailableUsage = { artifact: string };
type ConfiguredUsage = AvailableUsage | { unavailable: 'empty' };
type DnsUsage = Exclude<Usage, 'route'>;
type ProjectedFormat = Exclude<SourceFormat, 'sing-box-source-json' | 'sing-box-domain-srs' | 'v2fly-dlc-yaml' | 'clash-rule-list'>;

export function isProjectedFormat(format: SourceFormat): format is ProjectedFormat {
  return format !== 'sing-box-source-json' && format !== 'sing-box-domain-srs' && format !== 'v2fly-dlc-yaml' && format !== 'clash-rule-list';
}

const formatCapabilities = {
  'plain-yaml': { dns: 'dns-query', namedLists: true },
  'domain-suffix-text': { dns: 'dns-query', namedLists: false },
  'typed-domain-text': { dns: 'dns-query', namedLists: false },
  'sing-box-domain-json': { dns: 'dns-query', namedLists: false },
  'cidr-text': { dns: 'dns-response', namedLists: false },
  'openai-voice-json': { dns: 'dns-response', namedLists: false },
} as const satisfies Record<ProjectedFormat, { dns: DnsUsage; namedLists: boolean }>;

export function configuredUsages(format: ProjectedFormat) {
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

export type DlcTagFilter = {
  action: 'include' | 'exclude';
  match: 'allOf' | 'anyOf';
  tags: string[];
};

interface SingleArtifactLocation extends RuleLocation {
  artifact: string;
}

export interface DlcRuleDefinition extends SingleArtifactLocation {
  list: string;
  filter?: DlcTagFilter;
}

export type SingleArtifactDefinition = DlcRuleDefinition | (SingleArtifactLocation & { list?: never; filter?: ClashTypeFilter });

export type RuleDefinition = ProjectedRuleDefinition | SingleArtifactDefinition;
export interface BuildConfiguration {
  schemaVersion: 3 | 4;
  candidateRetentionDays: number;
  sources: Record<string, ConfiguredSource>;
  branchInputs?: Record<string, CommitInput>;
  target: { repository: typeof ARTIFACT_REPOSITORY; branch: string };
  ruleSets: RuleDefinition[];
}

export type RulesConfiguration = Omit<BuildConfiguration, 'schemaVersion' | 'ruleSets'> & {
  schemaVersion: 4;
  ruleSets: SingleArtifactDefinition[];
};
type ProjectedSourceInput = ReleaseInput | OpenAiVoiceInput | (Omit<CommitInput, 'input'> & {
  input: { format: Extract<CommitInput['input']['format'], ProjectedFormat>; path: string };
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

function exact(value: unknown, fields: string[], label: string, optional: string[] = []) {
  const record = mapping(value, label);
  if (Object.keys(record).some(key => !fields.includes(key) && !optional.includes(key))
    || fields.some(key => !Object.hasOwn(record, key))) {
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

function tagFilter(action: unknown, match: unknown, tags: unknown): DlcTagFilter {
  if ((action !== 'include' && action !== 'exclude') || (match !== 'allOf' && match !== 'anyOf')
    || !Array.isArray(tags) || !tags.length || tags.some(tag => typeof tag !== 'string' || !/^[a-zA-Z0-9!]+$/.test(tag))) {
    throw new Error('Invalid DLC tag filter');
  }
  return { action, match, tags: [...new Set<string>(tags)].sort() };
}

function parseTagFilter(input: unknown): DlcTagFilter {
  const filter = mapping(input, 'filter');
  const [action] = Object.keys(filter);
  if (action !== 'include' && action !== 'exclude') throw new Error('Invalid DLC tag filter action');
  const { tags } = exact(exact(filter, [action], 'filter')[action], ['tags'], 'filter condition');
  const condition = mapping(tags, 'tag condition');
  const [match] = Object.keys(condition);
  if (match !== 'allOf' && match !== 'anyOf') throw new Error('Invalid DLC tag filter condition');
  return tagFilter(action, match, exact(condition, [match], 'tag condition')[match]);
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
  const named = format === 'v2fly-dlc-yaml';
  const clash = format === 'clash-rule-list';
  const label = 'rule definition';
  if (!named && !clash && Object.hasOwn(mapping(input, label), 'filter')) {
    throw new Error(`${label} fields are invalid: filter is not supported for ${format}`);
  }
  const definition = exact(input, ['id', 'source', 'stablePath', 'artifact', ...(named ? ['list'] : [])],
    label, named || clash ? ['filter'] : []);
  const location = ruleLocation(definition, 'publishPath');
  if (!validArtifactBasename(definition.artifact) || reservedArtifactBasename(definition.artifact)) {
    throw new Error(`Invalid artifact basename: ${String(definition.artifact)}`);
  }
  const base = { ...location, artifact: definition.artifact };
  if (!named) {
    return clash && Object.hasOwn(definition, 'filter') ? { ...base, filter: parseClashTypeFilter(definition.filter) } : base;
  }
  const { list } = definition;
  if (typeof list !== 'string' || !/^[a-z0-9][a-z0-9!._-]*$/.test(list)) throw new Error(`Invalid DLC list: ${String(list)}`);
  if (!Object.hasOwn(definition, 'filter')) return { ...base, list };
  const { action, match, tags } = exact(definition.filter, ['action', 'match', 'tags'], 'DLC tag filter');
  return { ...base, list, filter: tagFilter(action, match, tags) };
}

export function parseStoredRuleDefinition(input: unknown, format: SourceFormat): RuleDefinition {
  if (Object.hasOwn(mapping(input, 'rule definition'), 'artifact')) return parseSingleArtifactDefinition(input, format);
  if (!isProjectedFormat(format)) throw new Error(`${format} requires a single artifact`);
  return parseRuleDefinition(input, format);
}

export function parseRuleDefinition(input: unknown, format: ProjectedFormat = 'plain-yaml'): ProjectedRuleDefinition {
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
    const { format, url, sha256Url } = exact(declaration, ['format', 'url'], 'URL input', ['sha256Url']);
    if (format !== 'sing-box-source-json' && format !== 'v2fly-dlc-yaml' && format !== 'openai-voice-json') {
      throw new Error(`Unsupported URL input format: ${String(format)}`);
    }
    if (!validFixedUrl(url) || (sha256Url !== undefined && (!validFixedUrl(sha256Url) || sha256Url === url))) {
      throw new Error(`Invalid ${format} HTTPS input`);
    }
    return { version: 'url', input: { format, url, ...(sha256Url && { sha256Url }) } };
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

function configureV4(raw: ReturnType<typeof validateRulesConfigurationV4>): RulesConfiguration {
  const sources = Object.fromEntries<ConfiguredSource>(Object.entries(raw.sources).map(([id, { fetch, format }]) => {
    if (fetch.method === 'github-branch') {
      return [id, { version: 'github-branch', repository: fetch.repository, branch: fetch.branch }];
    }
    return [id, parseSource({ version: 'url', input: { format, url: fetch.url,
      ...(fetch.sha256Url !== undefined && { sha256Url: fetch.sha256Url }) } })];
  }));
  const branchInputs: Record<string, CommitInput> = Object.create(null);
  const ruleSets = Object.entries(raw.ruleSets).map(([id, { data, publishPath, artifact, filter }]) => {
    const source = sources[data.source];
    if (source.version === 'github-branch') {
      // Whole-configuration validation requires a file and format at this selection.
      branchInputs[id] = { repository: source.repository, version: 'git-branch', branch: source.branch,
        input: { format: data.format!, path: data.file! } };
    }
    const { format } = configuredRuleInput({ sources, branchInputs }, { id, source: data.source }).input;
    return parseSingleArtifactDefinition({
      id, source: data.source, stablePath: publishPath, artifact, ...(data.list !== undefined && { list: data.list }),
      ...(filter !== undefined && { filter: format === 'v2fly-dlc-yaml' ? parseTagFilter(filter) : filter }),
    }, format);
  });
  return { schemaVersion: 4, candidateRetentionDays: raw.candidateRetentionDays, sources, target: raw.target, ruleSets,
    ...(Object.keys(branchInputs).length && { branchInputs }) };
}

function readConfigurationYaml(input: string) {
  const lines = new LineCounter();
  const document = parseDocument(input, { uniqueKeys: true, stringKeys: true, lineCounter: lines, prettyErrors: false });
  const yamlDiagnostics = [...document.errors, ...document.warnings].map(error => {
    const { line, col } = lines.linePos(error.pos[0]);
    return `${line}:${col} ${error.message}`;
  });
  visit(document, { Alias(_key, node) {
    const { line, col } = lines.linePos(node.range?.[0] ?? 0);
    yamlDiagnostics.push(`${line}:${col} YAML aliases are not allowed`);
  } });
  if (yamlDiagnostics.length) throw new Error(`Invalid build configuration YAML:\n${yamlDiagnostics.join('\n')}`);
  return { document, lines, value: document.toJS() };
}

/** Validate every definition before source access or output directory creation. */
export function parseBuildConfiguration(input: string): RulesConfiguration {
  const { document, lines, value } = readConfigurationYaml(input);
  return configureV4(validateRulesConfigurationV4(document, lines, value));
}

/** Only used by the legacy build and historical evidence readers. */
export function parseProjectedConfiguration(input: string): ProjectedConfiguration {
  const { document, value } = readConfigurationYaml(input);
  if (document.get('schemaVersion') !== 3) throw new Error('Projected rule operations require configuration v3');
  const raw = exact(value, ['schemaVersion', 'candidateRetentionDays', 'sources', 'target', 'ruleSets'], 'configuration');
  if (!Number.isSafeInteger(raw.candidateRetentionDays) || Number(raw.candidateRetentionDays) <= 0) throw new Error('candidateRetentionDays must be a positive integer');
  const target = exact(raw.target, ['repository', 'branch'], 'target');
  if (target.repository !== ARTIFACT_REPOSITORY || typeof target.branch !== 'string'
    || (target.branch !== 'main' && !acceptanceBranch.test(target.branch))) {
    throw new Error('Target repository or branch is outside the trusted publication target');
  }
  const declarations = Object.entries(mapping(raw.sources, 'sources'));
  const sources = Object.fromEntries<ProjectedSourceInput>(declarations.map(([id, source]) => {
    if (!logicalId.test(id)) throw new Error(`Invalid source ID: ${id}`);
    const parsed = parseSource(source);
    if (parsed.version === 'url') throw new Error('URL sources require configuration v4');
    if (parsed.version !== 'git-branch') return [id, parsed] as const;
    const { format, path } = parsed.input;
    if (!isProjectedFormat(format)) throw new Error(`${format} requires configuration v4`);
    return [id, { ...parsed, input: { format, path } }] as const;
  }));
  const entries = raw.ruleSets;
  if (!Array.isArray(entries)) throw new Error('ruleSets must be an explicit sequence');
  const ids = new Set<string>(), paths = new Set<string>();
  const ruleSets = entries.map(entry => {
    const { id, source } = mapping(entry, 'rule definition');
    if (typeof source !== 'string' || !Object.hasOwn(sources, source)) {
      throw new Error(`Rule set ${String(id)}: unknown source ${String(source)}`);
    }
    const input = sources[source].input;
    let rule: ProjectedRuleDefinition;
    try {
      if (!isProjectedFormat(input.format)) throw new Error(`${input.format} requires configuration v4`);
      rule = parseRuleDefinition(entry, input.format);
    } catch (error) {
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
  return { schemaVersion: 3, candidateRetentionDays: Number(raw.candidateRetentionDays), sources,
    target: { repository: target.repository, branch: target.branch }, ruleSets };
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
  const prefix = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${branch}/`;
  const [source, binary] = singleArtifactPaths(definition.stablePath, definition.artifact);
  return { schemaVersion: 3, systemRuleSetId: definition.id, targetVersion: '1.14.4', sourceFormatVersion: 4,
    formats: { source: { url: prefix + source }, binary: { url: prefix + binary } } };
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
