import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectIndex } from '../platform/src/platform/state/project-index.js';
import { createStoreRerooter } from '../platform/src/platform/runtime/code-index-services.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-swap-rollback-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function corruptIndexAt(dir: string): void {
  mkdirSync(join(dir, '.goodvibes'), { recursive: true });
  writeFileSync(join(dir, '.goodvibes', 'project-index.json'), '{not json');
}

describe('workspace swap store re-root', () => {
  test('a project index that cannot read the new location stays on the old one with its entries', async () => {
    const oldDir = tempDir();
    const newDir = tempDir();
    corruptIndexAt(newDir);
    const index = new ProjectIndex(oldDir);
    await index.load();
    index.upsertFile('src/a.ts', 10);
    const before = index.getFiles();
    await expect(index.reroot(newDir)).rejects.toThrow(/project-index\.json/);
    expect(index.baseDir).toBe(oldDir);
    expect(index.getFiles()).toEqual(before);
    await index.dispose();
  });

  test('a failed project index re-root returns the code index to the old root and rebuilds it', async () => {
    const oldDir = tempDir();
    const newDir = tempDir();
    corruptIndexAt(newDir);
    const projectIndex = new ProjectIndex(oldDir);
    await projectIndex.load();
    const reroots: string[] = [];
    let builds = 0;
    const codeIndexStore = {
      reroot: async (root: string) => { reroots.push(root); },
      stats: () => ({ lastBuild: { filesIndexed: 1 }, indexedChunks: 3 }) as unknown as ReturnType<import('../platform/src/platform/state/index.js').CodeIndexStore['stats']>,
      isBuilding: () => false,
      scheduleBuild: () => { builds += 1; },
    };
    const reroot = createStoreRerooter({ codeIndexStore, projectIndex, surfaceRoot: 'tui' });
    await expect(reroot(newDir)).rejects.toThrow(/project-index\.json/);
    expect(reroots).toEqual([newDir, oldDir]);
    expect(builds).toBe(1);
    await projectIndex.dispose();
  });

  test('a successful re-root rebuilds an index that had been built', async () => {
    const oldDir = tempDir();
    const newDir = tempDir();
    const projectIndex = new ProjectIndex(oldDir);
    await projectIndex.load();
    let builds = 0;
    const codeIndexStore = {
      reroot: async () => {},
      stats: () => ({ lastBuild: null, indexedChunks: 5 }) as unknown as ReturnType<import('../platform/src/platform/state/index.js').CodeIndexStore['stats']>,
      isBuilding: () => false,
      scheduleBuild: () => { builds += 1; },
    };
    await createStoreRerooter({ codeIndexStore, projectIndex, surfaceRoot: 'tui' })(newDir);
    expect(projectIndex.baseDir).toBe(newDir);
    expect(builds).toBe(1);
    await projectIndex.dispose();
  });

  function builtStats(built: boolean) {
    return (built ? { lastBuild: { filesIndexed: 1 }, indexedChunks: 3 } : { lastBuild: null, indexedChunks: 0 }) as unknown as ReturnType<import('../platform/src/platform/state/index.js').CodeIndexStore['stats']>;
  }

  test('when the code index cannot return to the old root either, the error names both failures and says to restart, and no rebuild is scheduled', async () => {
    const oldDir = tempDir();
    const newDir = tempDir();
    corruptIndexAt(newDir);
    const projectIndex = new ProjectIndex(oldDir);
    await projectIndex.load();
    let reroots = 0;
    let builds = 0;
    const codeIndexStore = {
      reroot: async () => { reroots += 1; if (reroots === 2) throw new Error('old index file is locked'); },
      stats: () => builtStats(true),
      isBuilding: () => false,
      scheduleBuild: () => { builds += 1; },
    };
    const error = await createStoreRerooter({ codeIndexStore, projectIndex, surfaceRoot: 'tui' })(newDir).then(() => null, (e: unknown) => e as Error);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/project-index\.json/);
    expect(error!.message).toContain('returning the code index to its previous root also failed: old index file is locked');
    expect(error!.message).toContain('restart to reopen it');
    expect(reroots).toBe(2);
    expect(builds).toBe(0);
    await projectIndex.dispose();
  });

  test('an index that was never built is not rebuilt after a failed or a successful re-root', async () => {
    const oldDir = tempDir();
    const badDir = tempDir();
    const goodDir = tempDir();
    corruptIndexAt(badDir);
    const projectIndex = new ProjectIndex(oldDir);
    await projectIndex.load();
    let builds = 0;
    const codeIndexStore = {
      reroot: async () => {},
      stats: () => builtStats(false),
      isBuilding: () => false,
      scheduleBuild: () => { builds += 1; },
    };
    const reroot = createStoreRerooter({ codeIndexStore, projectIndex, surfaceRoot: 'tui' });
    await expect(reroot(badDir)).rejects.toThrow(/project-index\.json/);
    await reroot(goodDir);
    expect(builds).toBe(0);
    await projectIndex.dispose();
  });
});
