/** Descriptor permission regression source; not executed during coding phase. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
test.each([0, 0o777])('persisted files ignore umask %i on their original exclusive descriptor', async mask => {
  const root = mkdtempSync(join(tmpdir(), 'persistent-descriptor-permissions-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.umask(mask); cleanup.push(() => { process.umask(previous); });
  const path = join(root, 'state.json'), store = new PersistentStore<{ private: string }>(path);
  await store.persist({ private: 'retained' }); expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(await store.load()).toEqual({ private: 'retained' });
});
