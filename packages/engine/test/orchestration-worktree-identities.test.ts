/** UNRUN native resource lifecycle regressions: actual Git and private identity
 * bookkeeping, no model answers or generated fixture expectations. */
import crypto from 'node:crypto';
import * as lockModule from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { WorktreeIdentityRegistry, WORKTREE_IDENTITY_FILE } from '../sdk/src/platform/orchestration/worktree-identities.js';
import { createWorktreeIsolationManager } from '../sdk/src/platform/orchestration/worktree-isolation.js';
import { IsolatedWorktree } from '../sdk/src/platform/agents/worktree.js';
import { GitService } from '../sdk/src/platform/git/service.js';
import { CURRENT_WORKSTREAM_SCHEMA_VERSION, emptyWorkItemUsage, type OrchestrationEvent, type WorkItem, type Workstream } from '../sdk/src/platform/orchestration/types.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities } from '../sdk/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../sdk/src/platform/runtime/self-update.js';
import type { NativeDataWriteOwner } from '../sdk/src/platform/runtime/native-reader-compatibility.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
function fixture() {
  const root = makeProjectTempDir('opaque-worktree-identity'); roots.push(root);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'fixture'); git(root, 'config', 'user.email', 'fixture@example.test'); writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(root, 'seed'), 'original'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'seed');
  return { root, common: join(root, '.git') };
}
function stream(id = 'group'): Workstream {
  const item: WorkItem = { id: 'unit', title: 'unit', task: 'task', state: 'pending', currentPhaseId: null,
    dependsOn: [], allAgentIds: [], visits: new Map(), touchedPaths: [], usage: emptyWorkItemUsage(), transportRetryCount: 0, createdAt: 0 };
  return { id, title: 'group', schemaVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION, phases: [], items: [item], isolation: 'worktree', createdAt: 0 };
}
const key = { namespace: 'private/caller-specific namespace', workstreamId: 'group', itemId: 'unit' };
function manager(root: string, events: OrchestrationEvent[] = [], writer?: NativeDataWriteOwner) {
  return createWorktreeIsolationManager({ projectRoot: root, stateNamespace: key.namespace, emit: event => events.push(event), nativeDataWriter: writer });
}

test('fresh exact tuples persist opaque labels with no checksum and concurrent managers converge before Git', async () => {
  const f = fixture(), first = new WorktreeIdentityRegistry(f.common), second = new WorktreeIdentityRegistry(f.common);
  const [a, b] = await Promise.all([first.reserve(key), second.reserve({ ...key })]);
  expect(a.branch).toBe(b.branch); expect(a.state).toBe('reserved'); expect(a.branch).toMatch(/^ws-owned\/[a-p-]+$/);
  const alternatives = await Promise.all([
    second.reserve({ ...key, namespace: `${key.namespace}/other` }),
    second.reserve({ ...key, workstreamId: `${key.workstreamId}/other` }),
    second.reserve({ ...key, itemId: `${key.itemId}/other` }),
  ]);
  expect(new Set([a.branch, ...alternatives.map(row => row.branch)]).size).toBe(4);
  expect(new WorktreeIdentityRegistry(f.common).find(key)?.branch).toBe(a.branch);
});

test('two actual processes serialize allocation of the same private tuple', async () => {
  const f = fixture();
  const moduleUrl = new URL('../sdk/src/platform/orchestration/worktree-identities.ts', import.meta.url).href;
  const source = `import { WorktreeIdentityRegistry } from ${JSON.stringify(moduleUrl)}; const row = await new WorktreeIdentityRegistry(process.argv[1]).reserve(JSON.parse(process.argv[2])); process.stdout.write(row.branch);`;
  const start = () => Bun.spawn([process.execPath, '--eval', source, f.common, JSON.stringify(key)], { stdout: 'pipe', stderr: 'pipe' });
  const one = start(), two = start();
  const [first, second, code1, code2, errors1, errors2] = await Promise.all([new Response(one.stdout).text(), new Response(two.stdout).text(), one.exited, two.exited, new Response(one.stderr).text(), new Response(two.stderr).text()]);
  expect([code1, code2, errors1, errors2]).toEqual([0, 0, '', '']); expect(first).toBe(second);
});

test('reserved existing user worktree never becomes an acquired native resource', async () => {
  const f = fixture(), registry = new WorktreeIdentityRegistry(f.common), row = await registry.reserve(key);
  const path = join(f.root, '.goodvibes', '.worktrees', row.branch);
  git(f.root, 'worktree', 'add', '-q', '-b', row.branch, path);
  writeFileSync(join(path, 'user-data'), 'preserve'); const ws = stream(), events: OrchestrationEvent[] = [], owner = manager(f.root, events);
  owner.reconcileOrphans(ws);
  expect(ws.items[0]!.worktreePath).toBeUndefined();
  expect(events).toContainEqual(expect.objectContaining({ type: 'orphan-worktree-reconciled', disposition: 'reported', path }));
  await expect(owner.ensureWorktree(ws, ws.items[0]!)).rejects.toThrow('requires recovery');
  await owner.cleanupTerminated(ws, ws.items[0]!); expect(readFileSync(join(path, 'user-data'), 'utf8')).toBe('preserve');
  expect(registry.find(key)?.state).toBe('reserved');
});

test('borrowed successful creation cannot publish a native acquisition or cleanup unrelated data', async () => {
  const f = fixture(), ws = stream(); let path = '';
  const fake = spyOn(GitService.prototype, 'worktreeAdd').mockImplementation(async target => { path = target; mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'foreign'), 'preserve'); });
  const owner = manager(f.root);
  try { await expect(owner.ensureWorktree(ws, ws.items[0]!)).rejects.toThrow(); }
  finally { fake.mockRestore(); }
  await owner.cleanupTerminated(ws, ws.items[0]!);
  expect(ws.items[0]!.worktreePath).toBeUndefined(); expect(readFileSync(join(path, 'foreign'), 'utf8')).toBe('preserve');
  expect(new WorktreeIdentityRegistry(f.common).find(key)?.state).toBe('reserved');
});

test('actual acquired row is tied to the original instance and survives native restart', async () => {
  const f = fixture(), ws = stream(), owner = manager(f.root), handle = await owner.ensureWorktree(ws, ws.items[0]!);
  const registry = new WorktreeIdentityRegistry(f.common), row = registry.find(key)!;
  expect(row.state).toBe('initialized');
  expect(() => registry.retainAcquired({ ...row }, handle.path)).toThrow();
  const resumed = stream(), restarted = manager(f.root); restarted.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreePath).toBe(handle.path); expect(resumed.items[0]!.worktreeInitialized).toBe(true);
  expect((await restarted.ensureWorktree(resumed, resumed.items[0]!)).path).toBe(handle.path);
});

test('linked repository roots resolve the same actual Git common directory and private tuple', async () => {
  const f = fixture(), linked = join(f.root, '.goodvibes', 'linked'); git(f.root, 'worktree', 'add', '-q', '-b', 'linked-root', linked);
  const a = stream(), b = stream(); const first = await manager(f.root).ensureWorktree(a, a.items[0]!);
  const second = await manager(linked).ensureWorktree(b, b.items[0]!);
  expect(second.path).toBe(first.path); expect(b.items[0]!.worktreeBranch).toBe(a.items[0]!.worktreeBranch);
});

test('equal item IDs in separate workstreams retain independent instances, diffs and cleanup', async () => {
  const f = fixture(), a = stream('first'), b = stream('second'), owner = manager(f.root);
  const one = await owner.ensureWorktree(a, a.items[0]!), two = await owner.ensureWorktree(b, b.items[0]!);
  expect(one.path).not.toBe(two.path);
  writeFileSync(join(two.path, 'second-only'), 'second'); await two.commit('second output', ['second-only']);
  expect((await owner.diffItem(a.items[0]!))?.files).not.toContain('second-only');
  expect((await owner.diffItem(b.items[0]!))?.files).toContain('second-only');
  await owner.cleanupTerminated(a, a.items[0]!); expect(existsSync(one.path)).toBe(false); expect(existsSync(two.path)).toBe(true);
});

test('late dirty work makes plain Git removal fail without destructive force escalation or false removed events', async () => {
  const f = fixture(), ws = stream(), events: OrchestrationEvent[] = [], owner = manager(f.root, events);
  const handle = await owner.ensureWorktree(ws, ws.items[0]!), original = GitService.prototype.worktreeRemove;
  const commands: string[] = [];
  const spy = spyOn(GitService.prototype, 'worktreeRemove').mockImplementation(async function (this: GitService, path, guard) {
    commands.push(path); writeFileSync(join(path, 'late-work'), 'preserve'); return original.call(this, path, guard);
  });
  try { await owner.cleanupTerminated(ws, ws.items[0]!); await owner.join(); }
  finally { spy.mockRestore(); }
  expect(commands).toEqual([handle.path]); expect(readFileSync(join(handle.path, 'late-work'), 'utf8')).toBe('preserve');
  expect(ws.items[0]!.worktreePath).toBe(handle.path); expect(ws.items[0]!.worktreeKept).toBe(true);
  expect(events.some(event => event.type === 'item-worktree-removed')).toBe(false);
});

test('retired physical acquisition refuses direct ensure as well as import and cannot be cleaned as original', async () => {
  const f = fixture(), ws = stream(), handle = await manager(f.root).ensureWorktree(ws, ws.items[0]!);
  renameSync(handle.path, `${handle.path}-retired`); mkdirSync(handle.path); writeFileSync(join(handle.path, 'foreign'), 'preserve');
  const restarted = manager(f.root);
  await expect(restarted.ensureWorktree(ws, ws.items[0]!)).rejects.toThrow();
  await restarted.cleanupTerminated(ws, ws.items[0]!); expect(readFileSync(join(handle.path, 'foreign'), 'utf8')).toBe('preserve');
});

test('original root Git discovery changes are refused before native allocation', async () => {
  const f = fixture(), ws = stream(), owner = manager(f.root); await owner.ensureWorktree(ws, ws.items[0]!);
  renameSync(join(f.root, '.git'), join(f.root, '.retired-git')); mkdirSync(join(f.root, '.git'));
  const second = stream('another'); await expect(owner.ensureWorktree(second, second.items[0]!)).rejects.toThrow();
  expect(second.items[0]!.worktreePath).toBeUndefined(); expect(existsSync(join(f.root, '.retired-git', WORKTREE_IDENTITY_FILE))).toBe(true);
});

test('future private registry is preserved on read, reserve, manager recovery and attempted allocation', async () => {
  const f = fixture(), path = join(f.common, WORKTREE_IDENTITY_FILE), bytes = '{"schema":99,"rows":[],"future":"keep"}\n';
  writeFileSync(path, bytes); chmodSync(path, 0o600);
  const registry = new WorktreeIdentityRegistry(f.common); expect(() => registry.find(key)).toThrow();
  await expect(registry.reserve(key)).rejects.toThrow(); const ws = stream(), owner = manager(f.root); owner.reconcileOrphans(ws);
  await expect(owner.ensureWorktree(ws, ws.items[0]!)).rejects.toThrow(); expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(git(f.root, 'branch', '--list', 'ws-owned/*')).toBe('');
});

test('reader declaration is required before opaque publication and a refused owner leaves Git and mapping untouched', async () => {
  const f = fixture(), path = join(f.common, WORKTREE_IDENTITY_FILE); let declarations = 0;
  const writer: NativeDataWriteOwner = { declare(format) { expect(format).toBe('worktree-opaque-identities-v1'); expect(existsSync(path)).toBe(false); declarations += 1; throw new Error('reader cohort refused'); } };
  const ws = stream(); await expect(manager(f.root, [], writer).ensureWorktree(ws, ws.items[0]!)).rejects.toThrow('reader cohort refused');
  expect(declarations).toBe(1); expect(existsSync(path)).toBe(false); expect(git(f.root, 'branch', '--list', 'ws-owned/*')).toBe('');
});

test('copied instance cannot upgrade a reservation and incomplete initializer remains recoverable but not executable', async () => {
  const f = fixture(), ws = stream(), owner = createWorktreeIsolationManager({ projectRoot: f.root, stateNamespace: key.namespace, emit() {},
    async initializeWorktree(instance) { await instance.create(); throw new Error('initialization incomplete'); } });
  await expect(owner.ensureWorktree(ws, ws.items[0]!)).rejects.toThrow('initialization incomplete');
  const registry = new WorktreeIdentityRegistry(f.common), row = registry.find(key)!;
  expect(row.state).toBe('acquired'); const copied = { path: row.creation!.path, branch: row.branch } as IsolatedWorktree;
  await expect(registry.acquired(key, copied, true)).rejects.toThrow();
  const resumed = stream(), restarted = manager(f.root); restarted.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreeInitialized).toBe(false); await expect(restarted.ensureWorktree(resumed, resumed.items[0]!)).rejects.toThrow('requires recovery');
});

// Exercise the actual installed publisher, not just a callback spy: an old
// same-version profile cannot infer support from the version string alone.
test('actual installed writer publishes the capability floor before native Git allocation', async () => {
  const f = fixture(), install = join(f.root, 'installation'); mkdirSync(install);
  const execPath = join(install, 'goodvibes-tui'), writer = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  const ws = stream(); await manager(f.root, [], writer).ensureWorktree(ws, ws.items[0]!);
  expect(() => assertNativeReaderCompatible(execPath, '3.1.1', realUpdateFileIo)).toThrow();
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
    { schema: 1, version: '3.1.2', formats: ['session-recovery-opaque-paths-v1'] })).toThrow();
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, nativeReaderCapabilities('3.1.2'))).not.toThrow();
});

test('ordinary fresh allocation and current native restore never run the old SHA namespace matcher', async () => {
  const f = fixture(), hashing = spyOn(crypto, 'createHash');
  try {
    const ws = stream(), owner = manager(f.root); await owner.ensureWorktree(ws, ws.items[0]!);
    const resumed = stream(), restarted = manager(f.root); restarted.reconcileOrphans(resumed);
    expect((await restarted.ensureWorktree(resumed, resumed.items[0]!)).path).toBe(ws.items[0]!.worktreePath);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256' || algorithm === 'sha1')).toHaveLength(0);
  } finally { hashing.mockRestore(); }
});

test('lock replacement immediately after actual native acquisition cannot be adopted as the registry lease', async () => {
  const f = fixture(), path = join(f.common, WORKTREE_IDENTITY_FILE), lock = `${path}.lock`, acquire = lockModule.tryAcquireCrossProcessLock;
  const native = spyOn(lockModule, 'tryAcquireCrossProcessLock').mockImplementation((selected, options) => {
    const release = acquire(selected, options);
    if (release && selected === lock) { const bytes = readFileSync(lock); renameSync(lock, `${lock}.original`); writeFileSync(lock, bytes); }
    return release;
  });
  try { await expect(new WorktreeIdentityRegistry(f.common).reserve(key)).rejects.toThrow(); }
  finally { native.mockRestore(); }
  expect(existsSync(path)).toBe(false); expect(existsSync(lock)).toBe(true); expect(existsSync(`${lock}.original`)).toBe(true);
});
