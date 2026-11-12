import { expect, test } from 'bun:test';
import { reviewInventoryPlannerView, type ReviewInventory } from '../../platform/src/platform/contract/review-inventory.js';

interface PlannerCatalog {
  source: ReviewInventory['source'];
  errors: string[];
  totalFiles: number;
  directories: { directory: string; files: string[] }[];
  meaning: string;
}

function catalog(inventory: ReviewInventory, formerBudget?: number): PlannerCatalog {
  return JSON.parse(JSON.stringify(reviewInventoryPlannerView(inventory, formerBudget))) as PlannerCatalog;
}

function paths(view: PlannerCatalog): string[] {
  return view.directories.flatMap(({ directory, files }) => files.map(file => directory === '.' ? file : `${directory}/${file}`)).sort();
}

test('planner catalog retains exact dotfiles, extensionless files and unusual names', () => {
  const inventory: ReviewInventory = {
    source: 'filesystem',
    errors: ['unreadable: EACCES'],
    paths: ['.gitattributes', '.gitignore', '.gitleaksignore', 'packages/engine/platform/LICENSE',
      'src/.hidden', 'src/a file.unknown-extension', 'src/日本語.ts', 'src/sub/nested', 'src/quote"and\\slash'],
  };
  const original = structuredClone(inventory);
  const view = catalog(inventory);
  expect(paths(view)).toEqual([...inventory.paths].sort());
  expect(view.directories.find(entry => entry.directory === '.')).toEqual({
    directory: '.', files: ['.gitattributes', '.gitignore', '.gitleaksignore'],
  });
  expect(view.directories.find(entry => entry.directory === 'packages/engine/platform')).toEqual({
    directory: 'packages/engine/platform', files: ['LICENSE'],
  });
  expect(view.source).toBe(inventory.source);
  expect(view.errors).toEqual([...inventory.errors]);
  expect(view.totalFiles).toBe(inventory.paths.length);
  expect(inventory).toEqual(original);
});

test('large planner catalog round trips every filename regardless of former presentation budget', () => {
  const inventory: ReviewInventory = {
    source: 'git', errors: [],
    paths: Array.from({ length: 12_000 }, (_, index) => `packages/repeated/prefix/domain-${index % 30}/file-${index}.ts`)
      .concat(['.gitignore', 'packages/repeated/prefix/LICENSE']),
  };
  const view = catalog(inventory, 1);
  expect(paths(view)).toEqual([...inventory.paths].sort());
  expect(view.totalFiles).toBe(12_002);
  expect(view.directories).toHaveLength(32);
  expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(inventory.paths).length);
  expect(view).toEqual(catalog({ ...inventory, paths: [...inventory.paths].reverse() }, 0));
  expect(view).toEqual(catalog(inventory, Number.MAX_SAFE_INTEGER));
});

test('empty planner catalog keeps inventory provenance and errors', () => {
  expect(catalog({ paths: [], source: 'filesystem', errors: ['.: EACCES'] })).toMatchObject({
    source: 'filesystem', errors: ['.: EACCES'], totalFiles: 0, directories: [],
  });
});
