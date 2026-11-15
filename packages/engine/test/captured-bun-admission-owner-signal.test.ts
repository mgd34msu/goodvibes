/** The shared Bun admission belongs to its owner: one caller cancelling its own wait must not poison it.
 * Bubblewrap processes are synthetic, as in the sibling admission tests. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as syncFs from 'node:fs';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureContractInput, contractInputPath, materializeContractInput } from '../platform/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../platform/src/platform/contract/input-authority.js';
import type { Contract } from '../platform/src/platform/contract/types.js';
import { createCapturedExecBunRuntimeAdmission } from '../platform/src/platform/tools/exec/captured-bun-runtime-input.js';
import type { CapturedExecAuthority } from '../platform/src/platform/tools/exec/captured-exec.js';

const hostExistsSync = syncFs.existsSync;
const roots: string[] = [];
const ownedAuthorities = new Set<Parameters<typeof revokeContractInputAuthority>[0]>();
const restorers = new Set<() => void>();
function ownRestore(restore: () => void): () => void {
  let restored = false;
  const owned = () => {
    if (restored) return;
    restored = true;
    try { restore(); } finally { restorers.delete(owned); }
  };
  restorers.add(owned);
  return owned;
}
const pendingCleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  // A timed-out test does not necessarily finish its async finally block.
  // Retire pending admission work before restoring every owned global seam.
  const errors: unknown[] = [];
  for (const cleanup of [...pendingCleanups].reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  for (const authority of ownedAuthorities) {
    try { revokeContractInputAuthority(authority); } catch (error) { errors.push(error); }
  }
  ownedAuthorities.clear();
  for (const restore of [...restorers].reverse()) {
    try { restore(); } catch (error) { errors.push(error); }
  }
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Synthetic Bun fixture cleanup failed');
});
async function fixture(filter: (path: string) => boolean | Promise<boolean> = () => true, signal?: AbortSignal) {
  const dir = mkdtempSync(join(tmpdir(), 'captured-direct-bun-unit-')); roots.push(dir);
  const owner = join(dir, 'owner'); mkdirSync(owner);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) {
    const result = childProcess.spawnSync('git', ['-C', owner, ...args]);
    if (result.status !== 0) throw new Error(result.stderr.toString());
  }
  writeFileSync(join(owner, 'input.txt'), 'CAPTURED_INPUT');
  for (const args of [['add', '.'], ['commit', '-qm', 'fixture']]) childProcess.spawnSync('git', ['-C', owner, ...args]);
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot);
  const worktree = childProcess.spawnSync('git', ['-C', owner, 'worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, root, inputSnapshot.inputCommit]);
  if (worktree.status !== 0) throw new Error(worktree.stderr.toString());
  await materializeContractInput(inputSnapshot, root);
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { signal, mutable: true, branch: `input/${inputSnapshot.id}` });
  ownedAuthorities.add(authority);
  const source = join(dir, 'declared-bun'); copyFileSync('/bin/true', source); chmodSync(source, 0o755);
  return { dir, source, binding: { authority, root, readAccessFilter: async (path: string) => filter(path) } satisfies CapturedExecAuthority };
}

function boundary(onCommand?: () => void, aliases: ReadonlySet<string> = new Set()) {
  const launches: { argv: string[]; runtime: string | undefined }[] = [];
  // This is a synthetic boundary, including its fixed executable-presence
  // check. Real availability belongs to the required containment fixtures.
  const presence = spyOn(syncFs, 'existsSync').mockImplementation(path => String(path) === '/usr/bin/bwrap' || aliases.has(String(path)) || hostExistsSync(path));
  const restorePresence = ownRestore(() => presence.mockRestore());
  const original = childProcess.spawnSync;
  const sync = spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof original>) => args[0] === '/usr/bin/bwrap'
    ? { status: 0, stdout: '', stderr: '' } : original(...args)) as typeof childProcess.spawnSync);
  const restoreSync = ownRestore(() => sync.mockRestore());
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof childProcess.spawn>) => {
    const [command, argv] = args;
    if (command !== '/usr/bin/bwrap' || !Array.isArray(argv)) throw new Error('unexpected process in unit fixture');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 987654, exitCode: null, kill: () => true });
    const runtimeIndex = argv.indexOf('/captured-runtime/bin/bun');
    const runtime = runtimeIndex >= 2 && argv[runtimeIndex - 2] === '--ro-bind' ? argv[runtimeIndex - 1] : undefined;
    launches.push({ argv: [...argv], runtime: runtime && existsSync(runtime) ? readFileSync(runtime).subarray(0, 200).toString() : undefined });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(argv.includes('--print') ? 'GOODVIBES_CAPTURED_ORDINARY_BUN\n' : 'SYNTHETIC_COMMAND_OUTPUT\n'));
      if (!argv.includes('--print')) onCommand?.();
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof childProcess.spawn);
  const restoreSpawn = ownRestore(() => spawn.mockRestore());
  return { launches, restore: () => { restoreSpawn(); restoreSync(); restorePresence(); } };
}

test('a first call cancelled during admission does not poison the owner admission', async () => {
  const f = await fixture(), mock = boundary();
  try {
    const admit = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: f.source });
    const first = new AbortController();
    const cancelled = admit(first.signal);
    first.abort(new Error('caller gave up'));
    await expect(cancelled).rejects.toThrow('caller gave up');
    const token = await admit(new AbortController().signal);
    expect(token.kind).toBe('captured-exec-bun-runtime');
    // The same admission serves a third caller without another probe.
    const launches = mock.launches.length;
    expect(await admit()).toBe(token);
    expect(mock.launches).toHaveLength(launches);
  } finally { mock.restore(); }
});

test('a failed first admission stays terminal for the owner', async () => {
  const f = await fixture(path => path !== '/captured-runtime/bin/bun'), mock = boundary();
  try {
    const admit = createCapturedExecBunRuntimeAdmission(f.binding, { bunExecutable: f.source });
    await expect(admit()).rejects.toThrow('access-restricted');
    await expect(admit(new AbortController().signal)).rejects.toThrow('access-restricted');
  } finally { mock.restore(); }
});
