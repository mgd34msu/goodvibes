/**
 * What the import graph finds, and when it says it is out of date.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportGraph, extractRelativeSpecifiersForTest } from '../platform/src/platform/intelligence/import-graph.ts';

describe('relative import extraction', () => {
  test('finds an import list wrapped over several lines, and each other form once', () => {
    const source = [
      "import {",
      "  alpha,",
      "  beta,",
      "} from './wrapped';",
      "export {",
      "  gamma,",
      "} from './reexported.js';",
      "import './side-effect';",
      "const lazy = import('./lazy');",
      "const legacy = require('./legacy');",
      "import left from 'external-package';",
      "import again from './wrapped';",
    ].join('\n');
    expect(extractRelativeSpecifiersForTest(source).sort()).toEqual(
      ['./lazy', './legacy', './reexported.js', './side-effect', './wrapped'],
    );
  });

  test('a dependent that imports through a wrapped list is reported', () => {
    const graph = new ImportGraph();
    graph.buildFromFilesForTest({
      '/p/a.ts': 'export const a = 1;\n',
      '/p/b.ts': "import {\n  a,\n  a2,\n} from './a';\n",
    });
    expect(graph.findDependents('/p/a.ts')).toEqual(['/p/b.ts']);
  });
});

describe('import graph staleness', () => {
  test('an edit announced while a build is running leaves the graph marked stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'import-graph-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'src', 'b.ts'), "import { a } from './a';\n");
      const graph = new ImportGraph();
      const building = graph.build(root);
      graph.markDirty();
      await building;
      expect(graph.stats().dirty).toBe(true);
      await graph.build(root);
      expect(graph.stats().dirty).toBe(false);
      expect(graph.findDependents(join(root, 'src', 'a.ts'))).toEqual([join(root, 'src', 'b.ts')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
