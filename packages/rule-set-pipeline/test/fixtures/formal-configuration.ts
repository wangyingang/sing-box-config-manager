import { stringify } from 'yaml';
import { configuredRuleInput, parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';
import type { RulesConfiguration } from '../../src/configuration.js';
import type { CommitInput } from '../../src/github-commit.js';
import type { FixedUrlInput } from '../../src/fixed-url-source.js';

export type FixtureConfiguration = Omit<RulesConfiguration, 'sources' | 'branchInputs'> & {
  sources: Record<string, FixedUrlInput | CommitInput>;
};

/** Fixtures derived from the formal definitions use one file per source. */
export function formalConfiguration(): FixtureConfiguration {
  const { branchInputs, ...configuration } = parseBuildConfiguration(readOfficialConfiguration());
  const sources: FixtureConfiguration['sources'] = {};
  for (const rule of configuration.ruleSets) {
    const input = configuredRuleInput({ sources: configuration.sources, branchInputs }, rule);
    if (input.version !== 'url' && input.version !== 'git-branch') throw new Error('Expected a v4 source');
    sources[rule.source] = input;
  }
  return { ...configuration, sources };
}

export function baselineV4Configuration(includeVoice = true) {
  const formal = formalConfiguration();
  const ids = ['openai', 'anthropic', 'google-deepmind', 'china-ip'];
  if (includeVoice) ids.push('chatgpt-voice');
  const ruleSets = formal.ruleSets.filter(rule => ids.includes(rule.id));
  return { ...formal, ruleSets, sources: Object.fromEntries(ruleSets.map(rule => [rule.source, formal.sources[rule.source]])) };
}

export function fixtureConfigurationYaml(configuration: FixtureConfiguration) {
  const sources = Object.fromEntries(Object.entries(configuration.sources).map(([id, source]) => {
    if (source.version === 'git-branch') {
      return [id, { fetch: { method: 'github-branch', repository: source.repository, branch: source.branch } }];
    }
    const { format, ...address } = source.input;
    return [id, { fetch: { method: 'url', ...address }, format }];
  }));
  const ruleSets = Object.fromEntries(configuration.ruleSets.map(({ id, source, stablePath, artifact, list, filter }) => {
    const input = configuration.sources[source];
    const data = { source, list, ...(input?.version === 'git-branch' && { file: input.input.path, format: input.input.format }) };
    const selection = filter && 'action' in filter ? { [filter.action]: { tags: { [filter.match]: filter.tags } } } : filter;
    return [id, { data, publishPath: stablePath, artifact, filter: selection }];
  }));
  return stringify({ ...configuration, sources, ruleSets }, { aliasDuplicateObjects: false });
}
