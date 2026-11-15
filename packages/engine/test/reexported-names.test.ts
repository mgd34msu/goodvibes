import { describe, expect, test } from 'bun:test';
import { reexportedNames } from '../scripts/reexported-names.ts';

const FROM = './generated/types.js';

describe('reexportedNames', () => {
  test('reads named value and type re-exports from the module', () => {
    const names = reexportedNames(`export type { A, B as C } from '${FROM}';\nexport { D } from '${FROM}';`, FROM);
    expect([...names!].sort()).toEqual(['A', 'C', 'D']);
  });

  test('a name only mentioned in a comment, an import or another module is not a re-export', () => {
    const text = [`// export type { Gone } from '${FROM}'`, `import type { Gone } from '${FROM}';`, "export type { Other } from './other.js';"].join('\n');
    expect(reexportedNames(text, FROM)!.has('Gone')).toBe(false);
  });

  test('a star export covers every name', () => {
    expect(reexportedNames(`export * from '${FROM}';`, FROM)).toBeNull();
  });
});
