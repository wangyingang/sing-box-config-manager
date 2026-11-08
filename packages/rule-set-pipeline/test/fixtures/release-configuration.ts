import { stringify } from 'yaml';
import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';

// These tests exercise one Release source, with no Git source or Git fixtures.
export function releaseConfiguration(branch = 'main') {
  const official = parseBuildConfiguration(readOfficialConfiguration());
  const sources = Object.fromEntries(Object.entries(official.sources).filter(([, source]) => source.version === 'latest-release'));
  return stringify({ ...official, target: { ...official.target, branch }, sources,
    ruleSets: official.ruleSets.filter(rule => Object.hasOwn(sources, rule.source)) });
}
