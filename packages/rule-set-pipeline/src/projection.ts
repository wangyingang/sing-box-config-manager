import { TERM_TYPES, type RuleTerm } from './types.js';

export type BuildTerm = RuleTerm | { type: 'ip_cidr'; value: string };
export const BUILD_TERM_TYPES = [...TERM_TYPES, 'ip_cidr'] as const;
export const USAGES = ['route', 'dns-query', 'dns-response'] as const;
export type Usage = typeof USAGES[number];

/** Only exact duplicates are removed. No CIDR aggregation or predicate rewriting. */
export function normalizeTerms(terms: readonly BuildTerm[]): BuildTerm[] {
  for (const term of terms) {
    if (!BUILD_TERM_TYPES.includes(term.type) || typeof term.value !== 'string' || !term.value) {
      throw new Error('Invalid or empty Rule IR term');
    }
  }
  return [...new Map(terms.map(term => [JSON.stringify([term.type, term.value]), { type: term.type, value: term.value }])).values()]
    .sort((a, b) => BUILD_TERM_TYPES.indexOf(a.type) - BUILD_TERM_TYPES.indexOf(b.type)
      || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

export function projectTerms(terms: readonly BuildTerm[]): Record<Usage, BuildTerm[]> {
  const route = normalizeTerms(terms);
  if (!route.length) throw new Error('Cannot build an empty Rule IR');
  return { route, 'dns-query': route.filter(term => term.type !== 'ip_cidr'),
    'dns-response': route.filter(term => term.type === 'ip_cidr') };
}

export function renderRuleJson(terms: readonly BuildTerm[]): string {
  const normalized = normalizeTerms(terms);
  if (!normalized.length) throw new Error('Cannot render an empty projection');
  return JSON.stringify({ version: 4, rules: BUILD_TERM_TYPES.flatMap(type => {
    const values = normalized.filter(term => term.type === type).map(term => term.value);
    return values.length ? [{ [type]: values }] : [];
  }) }, null, 2) + '\n';
}

/** Accept decoder version/scalar changes, but never flatten AND/logical rules into OR. */
export function decodedTerms(value: unknown): BuildTerm[] {
  const source = value as { version?: unknown; rules?: unknown };
  if (!source || !Number.isInteger(source.version) || Number(source.version) < 1 || Number(source.version) > 4
      || !Array.isArray(source.rules) || !source.rules.length) throw new Error('Invalid decoded source');
  const terms: BuildTerm[] = [];
  for (const rule of source.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Invalid decoded rule');
    const entries = Object.entries(rule);
    if (entries.length !== 1) throw new Error('Decoded rule is not an independent OR predicate');
    const [type, raw] = entries[0];
    if (!BUILD_TERM_TYPES.includes(type as BuildTerm['type'])) throw new Error(`Unexpected decoded field ${type}`);
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.some(value => typeof value !== 'string' || !value)) throw new Error('Invalid decoded value');
    terms.push(...values.map(value => ({ type, value }) as BuildTerm));
  }
  return normalizeTerms(terms);
}
