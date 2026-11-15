import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkspaceTrustManager, readPersistedWorkspaceTrust } from '../platform/src/platform/runtime/workspace-trust.ts';
import { createShellPathService } from '../platform/src/platform/runtime/shell-paths.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-trust-autonomous-')); roots.push(root);
  return new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), surfaceRoot: 'tui' });
}
test('autonomous undecided action does not write a trust decision', async () => {
  const trust = fixture(); const guard = await trust.prepareAutonomousConstraint('execute');
  expect(trust.isDecided()).toBe(false); guard(); expect(trust.isDecided()).toBe(false);
});
test('explicit restricted is deterministic and read remains available', async () => {
  const trust = fixture(); await trust.setLevel('restricted');
  await expect(trust.prepareAutonomousConstraint('execute')).rejects.toThrow('restricted');
  await expect(trust.prepareAutonomousConstraint('write')).rejects.toThrow('restricted');
  await expect(trust.prepareAutonomousConstraint('delegate')).rejects.toThrow('restricted');
  (await trust.prepareAutonomousConstraint('read'))();
});
test('trusted restricted trusted ABA revokes the original pending guard', async () => {
  const trust = fixture(); await trust.setLevel('trusted'); const guard = await trust.prepareAutonomousConstraint('execute');
  await trust.setLevel('restricted'); await trust.setLevel('trusted'); expect(() => guard()).toThrow('changed');
});
test('older persisted load cannot overwrite a newer explicit restricted decision', async () => {
  const trust = fixture();
  const store = (trust as unknown as { store: { load(): Promise<unknown> } }).store;
  let release!: (value: unknown) => void;
  const spy = spyOn(store, 'load').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  try {
    const load = trust.load(); await trust.setLevel('restricted');
    release({ level: 'trusted', decidedAt: new Date().toISOString() }); await load;
    expect(trust.getLevel()).toBe('restricted');
    await expect(trust.prepareAutonomousConstraint('execute')).rejects.toThrow('restricted');
  } finally { spy.mockRestore(); }
});

test('preparation cannot bless a trusted restricted trusted mutation while first load waits', async () => {
  const trust = fixture();
  const store = (trust as unknown as { store: { load(): Promise<unknown> } }).store;
  let release!: (value: unknown) => void;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const spy = spyOn(store, 'load').mockImplementation(() => new Promise(resolve => { release = resolve; entered(); }));
  try {
    const preparing = trust.prepareAutonomousConstraint('execute').then(() => null, error => error);
    await started;
    await trust.setLevel('trusted'); await trust.setLevel('restricted'); await trust.setLevel('trusted');
    release(null); expect(await preparing).toBeInstanceOf(Error); expect((await preparing).message).toContain('changed');
  } finally { spy.mockRestore(); }
});

test('already loaded preparation captures trust revision before its first await', async () => {
  const trust = fixture(); await trust.setLevel('trusted');
  const preparing = trust.prepareAutonomousConstraint('execute').then(() => null, error => error);
  await trust.setLevel('restricted'); await trust.setLevel('trusted');
  expect(await preparing).toBeInstanceOf(Error);
});

test('a new action cannot treat an in-flight explicit trusted mutation as settled policy', async () => {
  const trust = fixture();
  const store = (trust as unknown as { store: { save(value: unknown): Promise<void> } }).store;
  let release!: () => void;
  const spy = spyOn(store, 'save').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = trust.setLevel('trusted');
  try { await expect(trust.prepareAutonomousConstraint('execute')).rejects.toThrow('pending'); }
  finally { release(); await pending; spy.mockRestore(); }
  (await trust.prepareAutonomousConstraint('execute'))();
});

function writeTrustFile(trust: WorkspaceTrustManager, text: string): string {
  const file = (trust as unknown as { file: string }).file;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

test('a damaged trust record keeps autonomous work restricted and is reported', async () => {
  const trust = fixture();
  writeTrustFile(trust, '{"level": "restr');
  await trust.load();
  expect(trust.getLoadFault()).toContain('could not be read');
  await expect(trust.prepareAutonomousConstraint('execute')).rejects.toThrow('treated as restricted');
  (await trust.prepareAutonomousConstraint('read'))();
  // Nobody is deciding on the owner's behalf: a person at the keyboard is still asked.
  expect(trust.isDecided()).toBe(false);
});

test('a workspace that never had a trust record is not restricted by a fault', async () => {
  const trust = fixture();
  await trust.load();
  expect(trust.getLoadFault()).toBeNull();
  (await trust.prepareAutonomousConstraint('execute'))();
});

test('choosing a trust level replaces a damaged record', async () => {
  const trust = fixture();
  writeTrustFile(trust, 'not json');
  await trust.load();
  await trust.setLevel('trusted');
  expect(trust.getLoadFault()).toBeNull();
  (await trust.prepareAutonomousConstraint('execute'))();
});

test('the read-only reader says a damaged record is damaged', () => {
  const trust = fixture();
  const file = writeTrustFile(trust, 'not json');
  const view = readPersistedWorkspaceTrust({ projectGoodVibesRoot: dirname(file), resolveProjectPath: () => file }, 'tui');
  expect(view.level).toBe('undecided');
  expect(view.fault).toContain('could not be read');
});
