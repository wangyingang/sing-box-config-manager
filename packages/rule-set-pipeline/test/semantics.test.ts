import assert from 'node:assert/strict';
import test from 'node:test';
import { sameSemantics } from '../src/semantics.js';
import { type BuildTerm } from '../src/index.js';

const ip = (...values: string[]): BuildTerm[] => values.map(value => ({ type: 'ip_cidr', value }));

test('IP semantics tolerate adjacent, contained, canonicalized and duplicate coverage', () => {
  for (const [expected, actual] of [
    [ip('192.0.2.0/25', '192.0.2.128/25'), ip('192.0.2.0/24')],
    [ip('192.0.2.0/24', '192.0.2.0/25'), ip('192.0.2.0/24')],
    [ip('192.0.2.1/24', '192.0.2.0/24'), ip('192.0.2.0/24')],
    [ip('2001:db8::/33', '2001:db8:8000::/33'), ip('2001:db8::/32')],
    [ip('2001:0db8:0000::/32'), ip('2001:db8::/32')],
    [ip('0.0.0.0/1', '128.0.0.0/1'), ip('0.0.0.0/0')],
    [ip('::/1', '8000::/1'), ip('::/0')],
    [ip('192.0.2.1'), ip('192.0.2.1/32')],
  ]) {
    assert.equal(sameSemantics(expected, actual), true);
    assert.equal(sameSemantics(actual, expected), true);
  }
});

test('IP comparison detects missing halves, widened networks, holes and address family changes', () => {
  for (const [expected, actual] of [
    [ip('192.0.2.0/25'), ip('192.0.2.0/24')],
    [ip('192.0.2.0/24'), ip('192.0.2.0/23')],
    [ip('192.0.2.0/26', '192.0.2.128/25'), ip('192.0.2.0/24')],
    [ip('2001:db8::/33'), ip('2001:db8::/32')],
    [ip('192.0.2.0/24'), ip('::ffff:192.0.2.0/120')],
    [ip('0.0.0.0/0'), ip('::/0')],
    [ip('192.0.2.1/32'), ip('192.0.2.0/32')],
  ]) assert.equal(sameSemantics(expected, actual), false);
  assert.equal(sameSemantics(ip('192.0.2.0/24'), []), false);
});

test('term field order is irrelevant while domain type and value changes still fail', () => {
  const expected: BuildTerm[] = [{ type: 'domain_suffix', value: 'example.test' }, ...ip('192.0.2.0/24')];
  assert.equal(sameSemantics(expected, expected.map(({ type, value }) => ({ value, type })).reverse()), true);
  assert.equal(sameSemantics(expected, [{ type: 'domain', value: 'example.test' }, ...ip('192.0.2.0/24')]), false);
  assert.equal(sameSemantics(expected, [{ type: 'domain_suffix', value: 'other.test' }, ...ip('192.0.2.0/24')]), false);
  for (const value of ['not-a-cidr', '192.0.2.1/33', '::/129', '192.0.2.1/-1', '::/32/junk']) {
    assert.throws(() => sameSemantics(ip(value), ip(value)));
  }
});
