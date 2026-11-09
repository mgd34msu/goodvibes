/** Regression source intentionally UNRUN during the coding-first pass. */
import { expect, test } from 'bun:test';
import { isCompiledBunModuleUrl } from '../platform/src/platform/utils/bun-module.js';

test.each(['file:///workspace/main.ts', 'file:///workspace/$bunfs-demo/main.ts', 'file:///workspace/$bunfs/root/main.ts', 'https://host/$bunfs/root/main.ts', 'not a file URL'])('ordinary module location %s does not select installed native companions', location => {
  expect(isCompiledBunModuleUrl(location)).toBe(false);
});
test.each(['file:///$bunfs/root/main.js', 'file:///$bunfs/root/products/agent/src/main.ts'])('actual compiler location %s selects the bundled path', location => {
  expect(isCompiledBunModuleUrl(location)).toBe(true);
});
