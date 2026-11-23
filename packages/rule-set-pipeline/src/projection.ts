import { TERM_TYPES, type RuleTerm } from './types.js';

const PROJECTED_TERM_TYPES = [...TERM_TYPES, 'ip_cidr'] as const;
const PORT_TYPES = ['source_port', 'port'] as const;
const TRANSPORT_STRING_TYPES = ['source_ip_cidr', 'source_port_range', 'port_range'] as const;
const BUILD_TERM_TYPES = [...PROJECTED_TERM_TYPES, ...TRANSPORT_STRING_TYPES, ...PORT_TYPES] as const;
export type BuildTerm = RuleTerm | { type: 'ip_cidr' | (typeof TRANSPORT_STRING_TYPES)[number]; value: string }
  | { type: (typeof PORT_TYPES)[number]; value: number };
export const USAGES = ['route', 'dns-query', 'dns-response'] as const;
export type Usage = typeof USAGES[number];

/** Only exact duplicates are removed. No CIDR aggregation or predicate rewriting. */
export function normalizeTerms(terms: readonly RuleTerm[]): RuleTerm[];
export function normalizeTerms(terms: readonly BuildTerm[]): BuildTerm[];
export function normalizeTerms(terms: readonly BuildTerm[]): BuildTerm[] {
  const normalized = new Map<string, BuildTerm>();
  for (const term of terms) {
    const valid = buildTerm(term.type, term.value, true);
    if (!valid) throw new Error('Invalid or empty Rule IR term');
    normalized.set(JSON.stringify([valid.type, valid.value]), valid);
  }
  return [...normalized.values()]
    .sort((a, b) => BUILD_TERM_TYPES.indexOf(a.type) - BUILD_TERM_TYPES.indexOf(b.type)
      || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

export function projectTerms(terms: readonly BuildTerm[]): Record<Usage, BuildTerm[]> {
  const route = normalizeTerms(terms);
  if (!route.length) throw new Error('Cannot build an empty Rule IR');
  if (route.some(term => !PROJECTED_TERM_TYPES.some(type => type === term.type))) {
    throw new Error('Rule IR term requires a single artifact');
  }
  return { route, 'dns-query': route.filter(term => term.type !== 'ip_cidr'),
    'dns-response': route.filter(term => term.type === 'ip_cidr') };
}

export function renderRuleJson(terms: readonly BuildTerm[], singleArtifact = false): string {
  const normalized = normalizeTerms(terms);
  if (!normalized.length && !singleArtifact) throw new Error('Cannot render an empty rule set');
  return JSON.stringify({ version: 4, rules: BUILD_TERM_TYPES.flatMap(type => {
    const values = normalized.filter(term => term.type === type).map(term => term.value);
    return values.length ? [{ [type]: values }] : [];
  }) }, null, 2) + '\n';
}

/** Read generated Source Format v4 without flattening AND/logical rules into OR. */
export function readSourceTerms(value: unknown, singleArtifact = false): BuildTerm[] {
  return normalizeTerms(readIndependentTerms(value, singleArtifact));
}

export function readIndependentTerms(value: unknown, singleArtifact = false): BuildTerm[] {
  const source = value as { version?: unknown; rules?: unknown };
  if (!source || source.version !== 4
      || !Array.isArray(source.rules) || !singleArtifact && !source.rules.length) throw new Error('Invalid candidate source rules');
  const terms: BuildTerm[] = [];
  for (const rule of source.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Invalid candidate rule');
    const entries = Object.entries(rule);
    if (entries.length !== 1) throw new Error('Candidate rule is not an independent OR predicate');
    const [type, values] = entries[0];
    const supported = singleArtifact ? BUILD_TERM_TYPES : PROJECTED_TERM_TYPES;
    if (!supported.some(field => field === type)) throw new Error(`Unexpected rule field ${type}`);
    if (!Array.isArray(values) || !values.length) throw new Error('Invalid rule values');
    for (const value of values) {
      const term = buildTerm(type, value, singleArtifact);
      if (!term) throw new Error('Invalid rule value');
      terms.push(term);
    }
  }
  return terms;
}

function buildTerm(type: string, value: unknown, singleArtifact: boolean): BuildTerm | undefined {
  if (singleArtifact) {
    const port = PORT_TYPES.find(field => field === type);
    if (port) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535) return { type: port, value };
      return;
    }
    const transport = TRANSPORT_STRING_TYPES.find(field => field === type);
    if (transport) return typeof value === 'string' && value ? { type: transport, value } : undefined;
  }
  const projected = PROJECTED_TERM_TYPES.find(field => field === type);
  if (projected && typeof value === 'string' && value) return { type: projected, value };
}
