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

export function renderRuleJson(terms: readonly BuildTerm[], allowEmpty = false): string {
  const normalized = normalizeTerms(terms);
  if (!normalized.length && !allowEmpty) throw new Error('Cannot render an empty rule set');
  return JSON.stringify({ version: 4, rules: BUILD_TERM_TYPES.flatMap(type => {
    const values = normalized.filter(term => term.type === type).map(term => term.value);
    return values.length ? [{ [type]: values }] : [];
  }) }, null, 2) + '\n';
}

/** Read generated Source Format v4 without flattening AND/logical rules into OR. */
export function readSourceTerms(value: unknown, allowEmpty = false): BuildTerm[] {
  return normalizeTerms(readIndependentTerms(value, allowEmpty));
}

export function readIndependentTerms(value: unknown, allowEmpty = false): BuildTerm[] {
  const source = value as { version?: unknown; rules?: unknown };
  if (!source || source.version !== 4
      || !Array.isArray(source.rules) || !allowEmpty && !source.rules.length) throw new Error('Invalid candidate source rules');
  const terms: BuildTerm[] = [];
  for (const rule of source.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Invalid candidate rule');
    const entries = Object.entries(rule);
    if (entries.length !== 1) throw new Error('Candidate rule is not an independent OR predicate');
    const [type, values] = entries[0];
    if (!buildTermType(type)) throw new Error(`Unexpected rule field ${type}`);
    if (!Array.isArray(values) || !values.length) throw new Error('Invalid rule values');
    for (const value of values) {
      if (typeof value !== 'string' || !value) throw new Error('Invalid rule value');
      terms.push({ type, value });
    }
  }
  return terms;
}

function buildTermType(type: string): type is BuildTerm['type'] {
  return (BUILD_TERM_TYPES as readonly string[]).includes(type);
}
