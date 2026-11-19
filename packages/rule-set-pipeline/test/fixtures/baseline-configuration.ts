import { parseBuildConfiguration, readOfficialConfiguration } from '../../src/configuration.js';

// These scenarios retain inputs and budgets for the original four or five rule sets.
export function baselineConfiguration(includeVoice = true) {
  const official = parseBuildConfiguration(readOfficialConfiguration());
  const ids = ['openai', 'anthropic', 'google-deepmind', 'china-ip'];
  if (includeVoice) ids.push('chatgpt-voice');
  return { ...official, ruleSets: official.ruleSets.filter(rule => ids.includes(rule.id)) };
}
