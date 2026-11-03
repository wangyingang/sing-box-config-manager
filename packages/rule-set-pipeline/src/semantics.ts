import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { normalizeTerms, type BuildTerm } from './projection.js';

interface IpRange { family: number; first: bigint; last: bigint }

/** Comparison only: never rewrite Rule IR or the generated source JSON. */
function ipCoverage(terms: readonly BuildTerm[]): string {
  const ranges = terms.filter(term => term.type === 'ip_cidr').map(({ value }): IpRange => {
    const [address, prefix, ...extra] = value.split('/');
    const family = isIP(address);
    const bits = family === 4 ? 32 : 128;
    if (!family || extra.length || (prefix !== undefined && !/^\d+$/.test(prefix))) {
      throw new Error(`Invalid IP CIDR: ${value}`);
    }
    const length = prefix === undefined ? bits : Number(prefix);
    if (!Number.isInteger(length) || length < 0 || length > bits) throw new Error(`Invalid IP prefix: ${value}`);
    const bytes = ipaddr.parse(address).toByteArray();
    const numeric = bytes.reduce((result, byte) => (result << 8n) | BigInt(byte), 0n);
    const hostBits = BigInt(bits - length);
    const first = (numeric >> hostBits) << hostBits;
    return { family, first, last: first + (1n << hostBits) - 1n };
  }).sort((a, b) => a.family - b.family || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  const merged: IpRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && previous.family === range.family && range.first <= previous.last + 1n) {
      if (range.last > previous.last) previous.last = range.last;
    } else merged.push({ ...range });
  }
  return JSON.stringify(merged.map(({ family, first, last }) => [family, first.toString(16), last.toString(16)]));
}

export function sameSemantics(expected: readonly BuildTerm[], actual: readonly BuildTerm[]): boolean {
  const predicates = (terms: readonly BuildTerm[]) => normalizeTerms(terms.filter(term => term.type !== 'ip_cidr'));
  return JSON.stringify(predicates(expected)) === JSON.stringify(predicates(actual))
    && ipCoverage(expected) === ipCoverage(actual);
}
