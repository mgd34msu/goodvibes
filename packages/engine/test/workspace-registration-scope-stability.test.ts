/** Registry writes for other roots must not invalidate a root's native scope; the worktree probe must not block the event loop; a legacy register folds into a migrated one. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkspaceRegistrationStore } from '../platform/src/platform/workspace/registration/store.ts';
import { foldLegacyWorkspaceRegister } from '../platform/src/platform/workspace/registration/fold-legacy-register.ts';
import { probeWorktreeLinkAsync } from '../platform/src/platform/workspace/registration/worktree-link.ts';

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'scope-stability-'));
  fixtures.push(home);
  const make = (name: string) => { const dir = join(home, name); mkdirSync(dir, { recursive: true }); return dir; };
  const dirs = { a: make('a'), b: make('b'), c: make('c') };
  const path = join(home, 'state', 'workspaces.json');
  const store = new WorkspaceRegistrationStore({ path, homeDir: home, daemonStateDir: join(home, 'state'), probe: () => ({}) });
  return { home, dirs, path, store };
}

describe('native scope revision', () => {
  test('registering, declining or removing other roots leaves a root scope unchanged', async () => {
    const { dirs: { a, b, c }, store } = fixture();
    await store.add(a);
    const before = store.currentScope(a);
    await store.add(b);
    await store.decline(c);
    await store.remove(b);
    expect(store.currentScope(a)).toEqual(before);
    await store.add(a, { checkpointEligible: true });
    expect(store.currentScope(a)).toEqual(before);
  });

  test('a decline or a nearer registration inside the root changes its scope', async () => {
    const { dirs: { a }, store } = fixture();
    const inner = join(a, 'inner'); mkdirSync(inner);
    await store.add(a);
    const before = store.currentScope(a);
    await store.decline(inner);
    expect(store.currentScope(a).scopeRevision).not.toBe(before.scopeRevision);
    const afterDecline = store.currentScope(a);
    await store.add(inner);
    expect(store.currentScope(a).scopeRevision).not.toBe(afterDecline.scopeRevision);
  });

  test('removing and re-registering the same root yields a different scope', async () => {
    const { dirs: { a }, store } = fixture();
    await store.add(a);
    const before = store.currentScope(a);
    await store.remove(a);
    await store.add(a);
    const after = store.currentScope(a);
    expect(after.scopeId).not.toBe(before.scopeId);
    expect(after.scopeRevision).not.toBe(before.scopeRevision);
  });

  test('a scope captured before an unrelated registration is still current afterwards', async () => {
    const { dirs: { a, b }, store } = fixture();
    await store.add(a);
    const scope = store.currentScope(a);
    await store.add(b);
    await expect(store.withCurrentScope(scope, async (assertCurrent) => { assertCurrent(); return 'done'; })).resolves.toBe('done');
  });
});

describe('worktree link probe', () => {
  test('the default probe lets the event loop run while git works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-async-'));
    fixtures.push(dir);
    expect(spawnSync('git', ['init', '--quiet'], { cwd: dir }).status).toBe(0);
    // A blocking probe finishes before the next event-loop turn; a non-blocking one cannot.
    const outcome = await Promise.race([
      probeWorktreeLinkAsync(dir).then(() => 'probe'),
      new Promise<string>((resolve) => setImmediate(() => resolve('event loop')))]);
    expect(outcome).toBe('event loop');
  });

  test('a store built without a probe resolves worktrees through the non-blocking probe', () => {
    const home = mkdtempSync(join(tmpdir(), 'probe-default-'));
    fixtures.push(home);
    const store = new WorkspaceRegistrationStore({ path: join(home, 'state', 'workspaces.json'), homeDir: home, daemonStateDir: join(home, 'state') });
    expect(Reflect.get(store, 'probe')).toBe(probeWorktreeLinkAsync);
  });
});

describe('legacy register fold into a migrated register', () => {
  const legacyRow = (root: string) => ({ root, registeredAt: '2026-01-01T00:00:00.000Z' });

  test('a legacy file whose roots are already registered is accepted so it can be retired', async () => {
    const { dirs: { a }, home, store } = fixture();
    await store.add(a);
    const legacyPath = join(home, 'legacy.json');
    writeFileSync(legacyPath, JSON.stringify({ version: 1, workspaces: [legacyRow(a)], declines: [] }));
    const sharedPath = join(home, 'state', 'workspaces.json');
    const result = await foldLegacyWorkspaceRegister({ legacyPath, sharedPath });
    expect(result).toMatchObject({ added: 0, updated: 0 });
  });

  test('a legacy root the migrated register lacks is refused by name, never dropped', async () => {
    const { dirs: { a, b }, home, store } = fixture();
    await store.add(a);
    const legacyPath = join(home, 'legacy.json');
    writeFileSync(legacyPath, JSON.stringify({ version: 1, workspaces: [legacyRow(a), legacyRow(b)], declines: [] }));
    await expect(foldLegacyWorkspaceRegister({ legacyPath, sharedPath: join(home, 'state', 'workspaces.json') })).rejects.toThrow(b);
  });
});
