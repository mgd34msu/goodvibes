import { expect, test } from 'bun:test';
import { unwatchedPrefixes } from '../scripts/check-subpath-api-surface.ts';

test('a published prefix that is neither tracked nor listed as untracked is reported', () => {
  const keys = ['./platform', './platform/email', './newpkg/thing', './toolchain/x', './package.json'];
  expect(unwatchedPrefixes(keys, ['platform'], { toolchain: 'tooling', 'package.json': 'manifest' })).toEqual(['newpkg']);
});

test('every prefix being tracked or listed reports nothing', () => {
  expect(unwatchedPrefixes(['./a/x', './b/y'], ['a'], { b: 'why' })).toEqual([]);
});
