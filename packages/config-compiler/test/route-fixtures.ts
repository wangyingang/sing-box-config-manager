import { readFileSync } from 'node:fs';
import { input } from './recipe-fixtures.js';

/** Representative Route policy and Inline Rule Sets copied from the existing sanitized sample. */
export function sampleRouteInput() {
  const sample = JSON.parse(readFileSync(new URL('./fixtures/legacy/user-a-tun.json', import.meta.url), 'utf8'));
  const base = sample.fragments['1.base.json'];
  const request = input();
  const template = request.dependencies.templates[0]!;
  template.resources.outbounds!.push({ type: 'direct', tag: '直连' });
  template.routePresets = { bootstrap: structuredClone(base.route.rules) };
  request.recipe.resources.ruleSets = base.route.rule_set.map((definition: any) => ({ kind: 'inline', definition }));
  request.recipe.routeSteps = [{ id: 'bootstrap', preset: 'bootstrap' }];
  return { request, expectedRules: base.route.rules };
}
