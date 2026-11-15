import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { promises as fs, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import { WorkspaceRegistrationStore } from '../platform/src/platform/workspace/registration/store.ts';
import * as atomic from '../platform/src/platform/utils/atomic-json-store.ts';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'native-scope-durability-')); owned.push(home);
  const root = join(home, 'project'); const other = join(home, 'other');
  mkdirSync(root); mkdirSync(other);
  const path = join(home, 'state', 'nested', 'registry.json');
  const make = () => new WorkspaceRegistrationStore({ path, homeDir: home, daemonStateDir: join(home, 'state'), probe: () => ({}) });
  return { home, root, other, path, make };
}

/** Preserve the reviewer's failure point: FileHandle.sync on the directory AFTER rename. */
function failDirectorySync(directory: string) {
  const open = fs.open.bind(fs);
  return spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (String(path) !== directory || flags !== 'r') return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') return async () => { throw new Error('fixture directory sync failed after rename'); };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

describe('required native workspace publication durability', () => {
  test('PersistentStore keeps default behavior but required mode propagates post-rename directory sync failures', async () => {
    const f = fixture(); const store = new PersistentStore<{ value: string }>(f.path);
    const failure = failDirectorySync(dirname(f.path));
    try {
      await expect(store.persist({ value: 'default compatibility' })).resolves.toBeUndefined();
      await expect(store.persist({ value: 'strict visible bytes' }, { durable: true })).rejects.toThrow('directory sync failed after rename');
      expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ value: 'strict visible bytes' });
    } finally { failure.mockRestore(); }
  });

  test('required directory durability covers every ancestor, including newly created directory entries', async () => {
    const f = fixture(); const store = new PersistentStore<{ value: number }>(f.path);
    const visited: string[] = []; const open = fs.open.bind(fs);
    const observed = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (flags === 'r') visited.push(String(path));
      return open(path, flags, mode);
    });
    try { await store.persist({ value: 1 }, { durable: true }); } finally { observed.mockRestore(); }
    for (let directory = dirname(f.path);; directory = dirname(directory)) {
      expect(visited).toContain(directory);
      if (dirname(directory) === directory) break;
    }
  });

  test('a failed write fails that call only; the next read confirms the visible bytes and uses them', async () => {
    const f = fixture(); const store = f.make(); const failure = failDirectorySync(dirname(f.path));
    try { await expect(store.add(f.root)).rejects.toThrow('directory sync failed after rename'); } finally { failure.mockRestore(); }
    // New bytes may be visible: they are never rolled back or deleted.
    const visible = JSON.parse(readFileSync(f.path, 'utf8'));
    expect(visible.workspaces[0].nativeScope.id).toMatch(/^workspace:/);
    expect(store.currentScope(f.root).scopeId).toBe(visible.workspaces[0].nativeScope.id);
  });

  test('a failed removal fails that call only; other scopes stay usable and a new registration is a new scope', async () => {
    const f = fixture(); const store = f.make(); await store.add(f.root); await store.add(f.other);
    const old = store.currentScope(f.root); const other = store.currentScope(f.other);
    const failure = failDirectorySync(dirname(f.path));
    try { await expect(store.remove(f.root)).rejects.toThrow('directory sync failed after rename'); } finally { failure.mockRestore(); }
    expect(JSON.parse(readFileSync(f.path, 'utf8')).workspaces.some((row: { root: string }) => row.root === f.root)).toBe(false);
    expect(store.currentScope(f.other).scopeId).toBe(other.scopeId);
    await store.add(f.root);
    expect(store.currentScope(f.root).scopeId).not.toBe(old.scopeId);
  });

  test('a failed durability confirmation refuses that read only, as retryable', async () => {
    const f = fixture(); await f.make().add(f.root);
    const store = f.make();
    const confirmation = spyOn(atomic, 'confirmFileDurable').mockImplementation(() => { throw new Error('fixture durability uncertainty'); });
    try {
      let refusal: unknown;
      try { store.currentScope(f.root); } catch (error) { refusal = error; }
      expect(refusal).toMatchObject({ reason: 'retry', retryable: true });
    } finally { confirmation.mockRestore(); }
    expect(store.currentScope(f.root).root).toBe(f.root);
  });

  test('bytes replaced during confirmation are refused for that read', async () => {
    const f = fixture(); const store = f.make(); await store.add(f.root);
    const confirm = atomic.confirmFileDurable;
    const changed = spyOn(atomic, 'confirmFileDurable').mockImplementation((path) => {
      confirm(path);
      const bytes = JSON.parse(readFileSync(path, 'utf8'));
      bytes.scopeGeneration += 1;
      writeFileSync(path, JSON.stringify(bytes)); // Owned fixture simulates another writer.
    });
    try { expect(() => f.make().currentScope(f.root)).toThrow('retry'); } finally { changed.mockRestore(); }
  });

  test('durability is confirmed once per register file, not on every read', async () => {
    const f = fixture(); await f.make().add(f.root);
    const store = f.make();
    const confirmation = spyOn(atomic, 'confirmFileDurable');
    try {
      store.currentScope(f.root); store.currentScope(f.root); store.currentScope(f.root);
      expect(confirmation).toHaveBeenCalledTimes(1);
      await store.add(f.other); // a new file: the next read confirms it once
      confirmation.mockClear();
      store.currentScope(f.root); store.currentScope(f.root);
      expect(confirmation).toHaveBeenCalledTimes(1);
    } finally { confirmation.mockRestore(); }
  });
});
