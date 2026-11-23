import { readFileSync } from 'node:fs';
import { parseProjectedConfiguration } from '../../src/configuration.js';

export function readV3Fixture() {
  return readFileSync(new URL('./rulesets-v3.yml', import.meta.url), 'utf8');
}

// These scenarios retain inputs and budgets for the original four or five rule sets.
export function baselineConfiguration(includeVoice = true) {
  const official = parseProjectedConfiguration(readV3Fixture());
  const ids = ['openai', 'anthropic', 'google-deepmind', 'china-ip'];
  if (includeVoice) ids.push('chatgpt-voice');
  return { ...official, ruleSets: official.ruleSets.filter(rule => ids.includes(rule.id)) };
}
