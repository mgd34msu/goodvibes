import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packageDirs, publicPackageDirs, ENGINE_ROOT } from '../scripts/release-shared.ts';

const manifest = (dir: string) => JSON.parse(readFileSync(resolve(ENGINE_ROOT, dir, 'package.json'), 'utf8')) as {
  name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
};

test('every released package is published after the released packages it depends on', () => {
  const manifests = publicPackageDirs.map(dir => ({ dir, ...manifest(dir) }));
  const nameToDir = new Map(manifests.map(item => [item.name, item.dir]));
  let checked = 0;
  for (const item of manifests) {
    for (const group of [item.dependencies, item.peerDependencies, item.optionalDependencies]) {
      for (const dependency of Object.keys(group ?? {})) {
        const dependencyDir = nameToDir.get(dependency);
        if (!dependencyDir) continue;
        checked += 1;
        expect(publicPackageDirs.indexOf(dependencyDir)).toBeLessThan(publicPackageDirs.indexOf(item.dir));
      }
    }
  }
  // The engine does depend on the judgment package; if that edge disappears this test must be revisited.
  expect(checked).toBeGreaterThan(0);
  expect(packageDirs.indexOf('../judgment')).toBeLessThan(packageDirs.indexOf('.'));
});

import { decideExistingTag } from '../scripts/create-release-tag.ts';

test('a tag already on the commit being released resumes at the push; a tag elsewhere conflicts', () => {
  expect(decideExistingTag(null, 'aaa')).toBe('create');
  expect(decideExistingTag('aaa', 'aaa')).toBe('resume');
  expect(decideExistingTag('bbb', 'aaa')).toBe('conflict');
});
