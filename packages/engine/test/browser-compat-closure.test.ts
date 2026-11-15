import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { findNodeOnlyImports } from '../scripts/browser-compat-check.ts';

function reader(files: Record<string, string>) {
  return (path: string) => files[path];
}

const dist = (name: string) => resolve('/virtual/dist', name);

test('a node import two files deep from an entry is reported with its chain', () => {
  const files = {
    [dist('browser.js')]: "export * from './client.js';\n",
    [dist('client.js')]: "import { helper } from './deep/helper.js';\nexport { helper };\n",
    [dist('deep/helper.js')]: "import fs from 'node:fs';\nexport const helper = fs;\n",
  };
  const offenders = findNodeOnlyImports(dist('browser.js'), reader(files));
  expect(offenders).toHaveLength(1);
  expect(offenders[0]).toContain('./client.js -> ./deep/helper.js');
});

test('a multi-line import closing with a node specifier is reported', () => {
  const files = {
    [dist('a.js')]: "import { x } from './b.js';\n",
    [dist('b.js')]: "import {\n  readFileSync,\n} from 'node:fs';\n",
  };
  expect(findNodeOnlyImports(dist('a.js'), reader(files))).toHaveLength(1);
});

test('a string that only mentions require of a node module is not an import', () => {
  const files = {
    [dist('a.js')]: "import { x } from './b.js';\n",
    [dist('b.js')]: "const program = 'const w = require(\"node:worker_threads\")';\nexport const x = program;\n",
  };
  expect(findNodeOnlyImports(dist('a.js'), reader(files))).toEqual([]);
});

test('a cycle terminates and a clean closure reports nothing', () => {
  const files = {
    [dist('a.js')]: "import './b.js';\n",
    [dist('b.js')]: "import './a.js';\n",
  };
  expect(findNodeOnlyImports(dist('a.js'), reader(files))).toEqual([]);
});
