import { expect, test } from 'bun:test';
import { OwnedSelectionObservation } from '../sdk/src/platform/runtime/client/selection-observation.js';

test('selection observations retain complete values privately and retire previous lifetimes', () => {
  const owner = new OwnedSelectionObservation(), other = new OwnedSelectionObservation();
  const selected = { path: 'private credential store', token: 'synthetic credential', metadata: { generation: 1 } };
  const first = owner.observe(selected);
  expect(owner.observe(structuredClone(selected))).toBe(first);
  expect(other.observe(selected)).not.toBe(first);
  expect(first).not.toContain(selected.token); expect(first).not.toContain(selected.path);
  selected.metadata.generation = 2;
  expect(owner.observe(selected)).not.toBe(first);
  selected.metadata.generation = 1;
  const restored = owner.observe(selected); expect(restored).not.toBe(first);
  owner.retire(); expect(owner.observe(selected)).not.toBe(restored);
});

test('unadmitted selection data never runs a getter or preserves an earlier live identity', () => {
  const owner = new OwnedSelectionObservation(), original = owner.observe({ token: 'synthetic credential' });
  let getters = 0;
  const invalid = Object.defineProperty({}, 'token', { enumerable: true, get() { getters++; return 'synthetic credential'; } });
  expect(() => owner.observe(invalid)).toThrow(); expect(getters).toBe(0);
  expect(owner.observe({ token: 'synthetic credential' })).not.toBe(original);
});
