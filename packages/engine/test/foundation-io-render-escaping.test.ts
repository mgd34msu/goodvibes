import { expect, test } from 'bun:test';
import { renderType } from '../scripts/foundation-io-render.ts';

test('a string enum member with a quote or backslash renders as a valid literal', () => {
  const rendered = renderType({ type: 'string', enum: ['a"b', 'c\\d'] });
  expect(rendered).toBe('"a\\"b" | "c\\\\d"');
  expect(JSON.parse(rendered.split(' | ')[0]!)).toBe('a"b');
});

test('plain string enum members render unchanged and sorted', () => {
  expect(renderType({ type: 'string', enum: ['b', 'a'] })).toBe('"a" | "b"');
});
