/** Local equality of captured knowledge values; no model comparison. */
import { expect, test } from 'bun:test';
import { observeKnowledgeValue } from '../platform/src/platform/knowledge/local-value-observation.js';

test('one captured original compares complete nested data and preserves key/scalar distinctions', () => {
  const original = { a: { unset: undefined, number: -0 }, b: [1, 2] }, selected = observeKnowledgeValue(original);
  expect(selected.matches({ a: { unset: undefined, number: -0 }, b: [1, 2] })).toBe(true);
  original.b[1] = 3; expect(selected.matches(original)).toBe(false);
  expect(selected.matches({ a: { number: -0 }, b: [1, 2] })).toBe(false);
  expect(selected.matches({ a: { unset: undefined, number: 0 }, b: [1, 2] })).toBe(false);
  expect(selected.matches({ b: [1, 2], a: { unset: undefined, number: -0 } })).toBe(false);
});

test('descriptor guards do not invoke current getters, proxies or original proxy traps', () => {
  const selected = observeKnowledgeValue({ label: 'original' }); let effects = 0;
  const accessor = Object.defineProperty({}, 'label', { enumerable: true, get() { effects++; return 'original'; } });
  const proxy = new Proxy({ label: 'original' }, { getPrototypeOf(target) { effects++; return Reflect.getPrototypeOf(target); }, ownKeys(target) { effects++; return Reflect.ownKeys(target); } });
  expect(selected.matches(accessor)).toBe(false); expect(selected.matches(proxy)).toBe(false);
  expect(() => observeKnowledgeValue(proxy)).toThrow(); expect(effects).toBe(0);
});

test('large and deep local records gain no arbitrary comparison cap or recursion failure', () => {
  const values = Array.from({ length: 30_001 }, (_, index) => index), selected = observeKnowledgeValue(values);
  expect(selected.matches(values)).toBe(true);
  let deep: { next?: object } = {}, root = deep;
  for (let index = 0; index < 10_001; index++) { const next = {}; deep.next = next; deep = next; }
  expect(observeKnowledgeValue(root).matches(root)).toBe(true);
});
