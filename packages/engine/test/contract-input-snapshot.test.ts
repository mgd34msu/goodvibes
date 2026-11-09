import * as crypto from 'node:crypto';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.js';
import { judgmentInputBoundary } from '../platform/src/platform/gate/boundary.js';
import { createContractInputAuthority, authorizeContractInputPath, withContractInputAuthority } from '../platform/src/platform/contract/input-authority.js';
import { defaultRepositoryMap } from '../platform/src/platform/contract/planner.js';
import type { Contract } from '../platform/src/platform/contract/types.js';
import { useGateReadings } from './_helpers/gate-readings.js';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, openSync, ftruncateSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { assertContractInputObjects, assertContractInputOwner, assertContractInputView, createContractInputViewAssertion, captureContractInput, contractInputPath, isContractInputSnapshot, materializeContractInput, initializeContractMemberWorktree } from '../platform/src/platform/contract/input-snapshot.js';

useGateReadings();
const roots: string[] = [];
function git(root: string, ...args: string[]): Buffer {
  const r = spawnSync('git', ['-C', root, ...args]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
}
function repo(format: 'sha1' | 'sha256' = 'sha1'): string {
  const root = mkdtempSync(join(tmpdir(), 'contract-input-test-')); roots.push(root);
  git(root, 'init', '-q', `--object-format=${format}`); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\nignored.txt\n');
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 1;\n');
  mkdirSync(join(root, 'removed')); writeFileSync(join(root, 'removed/deleted.ts'), 'delete me');
  git(root, 'add', '.'); git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function view(root: string, snapshot: Awaited<ReturnType<typeof captureContractInput>>): Promise<string> {
  const path = contractInputPath(snapshot);
  git(root, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--no-checkout', '-b', `input/${snapshot.id}`, path, snapshot.inputCommit);
  await materializeContractInput(snapshot, path);
  return path;
}

/** Independent writer for the persisted version-one format; production creates
 * only version two. These extra digests exercise actual old receipt recovery.
 */
function versionOneReceipt(root: string, snapshot: Awaited<ReturnType<typeof captureContractInput>>) {
  return { ...snapshot, version: 1 as const, files: snapshot.files.map(file => file.kind === 'missing' ? file : {
    ...file, digest: crypto.createHash('sha256').update(file.kind === 'symlink'
      ? readlinkSync(join(root, file.path), { encoding: 'buffer' }) : readFileSync(join(root, file.path))).digest('hex'),
  }) };
}

describe('local frozen contract input', () => {
  for (const format of ['sha1', 'sha256'] as const) {
    test(`new receipts bind exact ${format} input with only the necessary independent byte commitments`, async () => {
      const root = repo(format);
      writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 0xff, 1, 0xfe]));
      writeFileSync(join(root, 'executable.sh'), 'synthetic executable\n'); chmodSync(join(root, 'executable.sh'), 0o755);
      symlinkSync('tracked.ts', join(root, 'link.ts'));
      const snapshot = await captureContractInput(root);
      expect(snapshot.version).toBe(2);
      expect(snapshot.files.filter(file => file.kind !== 'missing').every(file =>
        format === 'sha256' ? !Object.hasOwn(file, 'digest') : typeof file.digest === 'string' && file.digest.length === 64)).toBe(true);
      expect(isContractInputSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
      for (const file of snapshot.files) if (file.kind !== 'missing') {
        expect(file.oid?.length).toBe(format === 'sha1' ? 40 : 64);
        const bytes = file.kind === 'symlink' ? readlinkSync(join(root, file.path), { encoding: 'buffer' }) : readFileSync(join(root, file.path));
        const expected = spawnSync('git', ['-C', root, 'hash-object', '--stdin', '--no-filters'], { input: bytes });
        expect(expected.status).toBe(0); expect(file.oid).toBe(expected.stdout.toString().trim());
      }
      const frozen = await view(root, snapshot);
      expect(readFileSync(join(frozen, 'binary.bin'))).toEqual(readFileSync(join(root, 'binary.bin')));
      await assertContractInputOwner(snapshot); await assertContractInputView(snapshot);
      const first = snapshot.files.find(file => file.kind === 'file')!;
      const { digest: _digest, ...withoutDigest } = first;
      expect(isContractInputSnapshot({ ...snapshot, files: snapshot.files.map(file => file === first
        ? format === 'sha1' ? withoutDigest : { ...file, digest: '0'.repeat(64) } : file) })).toBe(false);
    });
  }

  test('version-one receipts resume their recorded bytes and reject a mismatched old digest', async () => {
    const root = repo(); symlinkSync('tracked.ts', join(root, 'link.ts'));
    const current = await captureContractInput(root), old = versionOneReceipt(root, current);
    const restored = JSON.parse(JSON.stringify(old)) as typeof old;
    expect(isContractInputSnapshot(restored)).toBe(true);
    const frozen = await view(root, restored);
    expect(readFileSync(join(frozen, 'tracked.ts'))).toEqual(readFileSync(join(root, 'tracked.ts')));
    await assertContractInputOwner(restored); await assertContractInputView(restored);
    const receiptPath = join(root, '.goodvibes/version-one-receipt.json');
    writeFileSync(receiptPath, JSON.stringify(restored));
    const source = new URL('../platform/src/platform/contract/input-snapshot.ts', import.meta.url).href;
    const child = Bun.spawn([process.execPath, '--eval', `
      import { assertContractInputOwner, assertContractInputView, isContractInputSnapshot } from ${JSON.stringify(source)};
      const receipt = JSON.parse(await Bun.file(process.argv[1]).text());
      if (!isContractInputSnapshot(receipt) || receipt.version !== 1) throw new Error('Stored receipt was not restored');
      await assertContractInputOwner(receipt); await assertContractInputView(receipt);
      console.log('restored-version-one');`, receiptPath], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect([code, stdout, stderr]).toEqual([0, 'restored-version-one\n', '']);
    } finally {
      clearTimeout(timer); if (child.exitCode === null) child.kill(); await child.exited;
    }
    const corrupted = { ...restored, files: restored.files.map(file => file.path === 'tracked.ts' ? { ...file, digest: '0'.repeat(64) } : file) };
    await expect(assertContractInputOwner(corrupted)).rejects.toThrow('owner changed');
    await expect(assertContractInputView(corrupted)).rejects.toThrow('view changed');
    const destination = join(root, '.goodvibes/old-corrupt-view');
    git(root, 'worktree', 'add', '--no-checkout', '-b', 'old-corrupt-view', destination, restored.inputCommit);
    await expect(materializeContractInput(corrupted, destination)).rejects.toThrow('blob digest mismatch');
  }, 30_000);

  test('the logical index commitment hides excluded tracked names, tolerates an identical rewrite and detects flag changes', async () => {
    const root = repo(), name = 'SYNTHETIC_PRIVATE_INDEX_NAME';
    mkdirSync(join(root, '.aws')); writeFileSync(join(root, '.aws', name), 'synthetic excluded content');
    git(root, 'add', '-f', `.aws/${name}`);
    const snapshot = await captureContractInput(root), serialized = JSON.stringify(snapshot);
    expect(git(root, 'ls-files', '--stage', '-z').toString()).toContain(name);
    expect(serialized).not.toContain(name); expect(serialized).not.toContain('synthetic excluded content');
    expect(Object.hasOwn(snapshot, 'ownerIndex')).toBe(false);
    const index = readFileSync(join(root, '.git/index'));
    writeFileSync(join(root, '.git/index-identical'), index); renameSync(join(root, '.git/index-identical'), join(root, '.git/index'));
    await assertContractInputOwner(snapshot);
    git(root, 'update-index', '--assume-unchanged', 'tracked.ts');
    await expect(assertContractInputOwner(snapshot)).rejects.toThrow('index changed');
  });

  test('materialization rejects blob data altered underneath its native object ID', async () => {
    const root = repo(), payload = Buffer.from('captured payload for the immutable Git object\n');
    writeFileSync(join(root, 'captured.txt'), payload);
    const snapshot = await captureContractInput(root), oid = snapshot.files.find(file => file.path === 'captured.txt')!.oid!;
    const stored = join(root, '.git/objects', oid.slice(0, 2), oid.slice(2));
    const altered = Buffer.from(payload); altered[0] = altered[0]! ^ 1;
    chmodSync(stored, 0o600);
    writeFileSync(stored, deflateSync(Buffer.concat([Buffer.from(`blob ${altered.length}\0`), altered])));
    const destination = contractInputPath(snapshot);
    git(root, 'worktree', 'add', '--no-checkout', '-b', 'corrupt-object-view', destination, snapshot.inputCommit);
    await expect(materializeContractInput(snapshot, destination)).rejects.toThrow(/blob|object|stream/);
  });

  test('an immutable batch path requires its own byte-verified view and rejects changed file ownership', async () => {
    const root = repo(), snapshot = await captureContractInput(root), frozen = await view(root, snapshot);
    const assertView = createContractInputViewAssertion(snapshot);
    await expect(assertView.assertPath('tracked.ts')).rejects.toThrow('accessed path');
    await assertView();
    await assertView.assertPath('tracked.ts');
    const bytes = readFileSync(join(frozen, 'tracked.ts'));
    renameSync(join(frozen, 'tracked.ts'), join(frozen, 'previous.ts'));
    writeFileSync(join(frozen, 'tracked.ts'), bytes);
    unlinkSync(join(frozen, 'previous.ts'));
    await expect(assertView.assertPath('tracked.ts')).rejects.toThrow('accessed path');
    await expect(assertView()).rejects.toThrow('view changed');
  });

  test('preserves staged, unstaged, deleted, untracked, binary and executable bytes without changing owner/index/branch', async () => {
    const root = repo();
    writeFileSync(join(root, 'tracked.ts'), 'staged\n'); git(root, 'add', 'tracked.ts');
    writeFileSync(join(root, 'tracked.ts'), 'staged plus unstaged\n');
    writeFileSync(join(root, 'untracked.ts'), 'new file\n');
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 34, 0, 128]));
    writeFileSync(join(root, 'executable.sh'), 'synthetic executable\n'); chmodSync(join(root, 'executable.sh'), 0o755);
    rmSync(join(root, 'removed'), { recursive: true });
    writeFileSync(join(root, 'ignored.txt'), 'not input');
    mkdirSync(join(root, '.goodvibes')); writeFileSync(join(root, '.goodvibes/runtime'), 'not input');
    mkdirSync(join(root, '.aws')); writeFileSync(join(root, '.aws/credentials'), 'synthetic excluded marker');
    const index = readFileSync(join(root, '.git/index')); const head = git(root, 'rev-parse', 'HEAD');
    const snapshot = await captureContractInput(root);
    expect(snapshot.dirty).toBe(true); expect(isContractInputSnapshot(snapshot)).toBe(true);
    expect(snapshot.files.some((f) => f.path.startsWith('.aws') || f.path.startsWith('.goodvibes') || f.path === 'ignored.txt')).toBe(false);
    expect(snapshot.files.find((f) => f.path === 'removed/deleted.ts')?.kind).toBe('missing');
    expect(readFileSync(join(root, '.git/index'))).toEqual(index); expect(git(root, 'rev-parse', 'HEAD')).toEqual(head);
    const frozen = await view(root, snapshot);
    expect(readFileSync(join(frozen, 'tracked.ts'), 'utf8')).toBe('staged plus unstaged\n');
    expect(readFileSync(join(frozen, 'binary.bin'))).toEqual(Buffer.from([0, 255, 34, 0, 128]));
    expect(readFileSync(join(frozen, 'untracked.ts'), 'utf8')).toBe('new file\n');
    expect(lstatSync(join(frozen, 'executable.sh')).mode & 0o111).not.toBe(0);
    expect(existsSync(join(frozen, 'removed/deleted.ts'))).toBe(false);
    await assertContractInputView(snapshot); await assertContractInputOwner(snapshot);
    writeFileSync(join(root, 'tracked.ts'), 'later owner edit\n');
    expect(readFileSync(join(frozen, 'tracked.ts'), 'utf8')).toBe('staged plus unstaged\n');
    await expect(assertContractInputOwner(snapshot)).rejects.toThrow('owner changed');
  });

  test('clean generations use owner HEAD; concurrent captures have isolated ids and temporary indexes', async () => {
    const root = repo(); const index = readFileSync(join(root, '.git/index'));
    const [a, b] = await Promise.all([captureContractInput(root), captureContractInput(root)]);
    expect(a.id).not.toBe(b.id); expect(a.inputCommit).toBe(a.ownerHead); expect(a.dirty).toBe(false);
    expect(b.inputTree).toBe(a.inputTree); expect(readFileSync(join(root, '.git/index'))).toEqual(index);
    assertContractInputObjects(a, root);
  });

  test('staged-only input is dirty even when working bytes equal HEAD', async () => {
    const root = repo(); writeFileSync(join(root, 'tracked.ts'), 'staged only'); git(root, 'add', 'tracked.ts');
    writeFileSync(join(root, 'tracked.ts'), 'export const value = 1;\n');
    const snapshot = await captureContractInput(root);
    expect(snapshot.inputCommit).toBe(snapshot.ownerHead); expect(snapshot.dirty).toBe(true);
  });

  test('does not execute capture hooks or clean/smudge filters', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitattributes'), '*.ts filter=marker\n');
    git(root, 'config', 'filter.marker.clean', 'touch CAPTURE_FILTER_RAN; cat');
    git(root, 'config', 'filter.marker.smudge', 'touch CAPTURE_FILTER_RAN; cat');
    const hook = join(root, '.git/hooks/post-checkout'); writeFileSync(hook, '#!/bin/sh\ntouch CAPTURE_HOOK_RAN\n'); chmodSync(hook, 0o755);
    const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
    expect(existsSync(join(root, 'CAPTURE_FILTER_RAN'))).toBe(false); expect(existsSync(join(frozen, 'CAPTURE_FILTER_RAN'))).toBe(false);
    expect(existsSync(join(frozen, 'CAPTURE_HOOK_RAN'))).toBe(false);
  });

  test('preserves contained file symlinks and holds escaping, dangling or cyclic links', async () => {
    const root = repo(); symlinkSync('tracked.ts', join(root, 'link.ts'));
    const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
    expect(lstatSync(join(frozen, 'link.ts')).isSymbolicLink()).toBe(true);
    symlinkSync('/etc/passwd', join(root, 'outside'));
    await expect(captureContractInput(root)).rejects.toThrow('absolute or ambiguous'); unlinkSync(join(root, 'outside'));
    symlinkSync('absent', join(root, 'dangling')); await expect(captureContractInput(root)).rejects.toThrow('uncaptured'); unlinkSync(join(root, 'dangling'));
    symlinkSync('cycle-b', join(root, 'cycle-a')); symlinkSync('cycle-a', join(root, 'cycle-b'));
    await expect(captureContractInput(root)).rejects.toThrow('cycle');
  });

  test('holds FIFO, replaced file/index, cancelled and bounded captures without source mutation', async () => {
    const root = repo(); const before = readFileSync(join(root, '.git/index'));
    const fifo = spawnSync('mkfifo', [join(root, 'pipe')]); expect(fifo.status).toBe(0);
    await expect(captureContractInput(root)).rejects.toThrow('special file'); unlinkSync(join(root, 'pipe'));
    await expect(captureContractInput(root, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(captureContractInput(root, { maxBytes: 1 })).rejects.toThrow('byte bound');
    expect(readFileSync(join(root, '.git/index'))).toEqual(before);
    const snapshot = await captureContractInput(root);
    const bytes = readFileSync(join(root, 'tracked.ts')); renameSync(join(root, 'tracked.ts'), join(root, 'old')); writeFileSync(join(root, 'tracked.ts'), bytes); unlinkSync(join(root, 'old'));
    await expect(assertContractInputOwner(snapshot)).rejects.toThrow('owner changed');
    const second = await captureContractInput(root); writeFileSync(join(root, 'tracked.ts'), 'staged replacement'); git(root, 'add', 'tracked.ts');
    await expect(assertContractInputOwner(second)).rejects.toThrow('index changed');
  });

  test('receipt corruption and changed recorded view hold recovery', async () => {
    const root = repo(); const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
    expect(isContractInputSnapshot({ ...snapshot, version: 3 })).toBe(false);
    expect(isContractInputSnapshot({ ...snapshot, files: [...snapshot.files, snapshot.files[0]] })).toBe(false);
    expect(() => assertContractInputObjects({ ...snapshot, inputTree: '0'.repeat(40) }, root)).toThrow('mismatch');
    writeFileSync(join(frozen, 'tracked.ts'), 'changed snapshot');
    await expect(assertContractInputView(snapshot)).rejects.toThrow('view changed');
  });
});


test('denied captured source exports stay withheld from the repository map', async () => {
  const { defaultRepositoryMap } = await import('../platform/src/platform/contract/planner.js');
  const { createContractInputAuthority, withContractInputAuthority } = await import('../platform/src/platform/contract/input-authority.js');
  const root = repo(); writeFileSync(join(root, 'secret.ts'), 'export const SYNTHETIC_PRIVATE_EXPORT = 123;\n');
  const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
  const authority = await createContractInputAuthority({ projectRoot: root, inputSnapshot: snapshot } as import('../platform/src/platform/contract/types.js').Contract, frozen);
  const checked: string[] = [];
  const map = await withContractInputAuthority(authority, () => defaultRepositoryMap(frozen, async (path) => { checked.push(path); return !path.endsWith('/secret.ts'); }));
  expect(checked.some((path) => path === join(frozen, 'secret.ts'))).toBe(true);
  expect(map).not.toContain('SYNTHETIC_PRIVATE_EXPORT');
});

test('raw member initializer preserves captured bytes and runs neither smudge nor checkout/reference hooks', async () => {
  const { IsolatedWorktree } = await import('../platform/src/platform/agents/worktree.js');
  const root = repo();
  writeFileSync(join(root, '.gitattributes'), '*.ts filter=marker\n');
  git(root, 'config', 'filter.marker.smudge', 'touch FILTER_RAN; cat');
  for (const name of ['post-checkout', 'reference-transaction']) {
    const hook = join(root, '.git/hooks', name); writeFileSync(hook, '#!/bin/sh\ntouch HOOK_RAN\n'); chmodSync(hook, 0o755);
  }
  const snapshot = await captureContractInput(root); const frozen = await view(root, snapshot);
  const path = join(root, '.goodvibes/member');
  await initializeContractMemberWorktree(frozen, new IsolatedWorktree(frozen, path, 'member/input', `input/${snapshot.id}`));
  expect(readFileSync(join(path, 'tracked.ts'))).toEqual(readFileSync(join(frozen, 'tracked.ts')));
  for (const directory of [root, frozen, path]) {
    expect(existsSync(join(directory, 'FILTER_RAN'))).toBe(false); expect(existsSync(join(directory, 'HOOK_RAN'))).toBe(false);
  }
});


test('an observed racing source writer holds admission rather than silently selecting another generation', async () => {
  const root = repo(); let writes = 0;
  const timer = setInterval(() => { writeFileSync(join(root, 'tracked.ts'), `racing value ${++writes}\n`); }, 1);
  try { await expect(captureContractInput(root)).rejects.toThrow(/changed|replaced/); }
  finally { clearInterval(timer); }
  expect(writes).toBeGreaterThan(0);
});

test('an index replaced during capture holds even if the logical staged entries are identical', async () => {
  const root = repo(); const contents = readFileSync(join(root, '.git/index')); let swaps = 0;
  const timer = setInterval(() => {
    writeFileSync(join(root, '.git/index-swap'), contents);
    renameSync(join(root, '.git/index-swap'), join(root, '.git/index'));
    swaps++;
  }, 1);
  try { await expect(captureContractInput(root)).rejects.toMatchObject({ change: 'index' }); }
  finally { clearInterval(timer); }
  expect(swaps).toBeGreaterThan(0); expect(readFileSync(join(root, '.git/index'))).toEqual(contents);
});

test('redirected runtime storage is held before materialization', async () => {
  const { prepareContractInputParent } = await import('../platform/src/platform/contract/input-snapshot.js');
  const root = repo(); const outside = mkdtempSync(join(tmpdir(), 'contract-input-outside-')); roots.push(outside);
  symlinkSync(outside, join(root, '.goodvibes'));
  const snapshot = await captureContractInput(root);
  await expect(prepareContractInputParent(snapshot, contractInputPath(snapshot))).rejects.toThrow('redirected');
  expect(existsSync(join(outside, '.worktrees'))).toBe(false);
});


test('generated snapshot paths preserve allowed repository maps through the unchanged privacy boundary', async () => {
  const root = repo();
  // Synthetic UUID with a numeric span matching the existing deterministic floor.
  const rawId = 'ca698156-0902-4913-8e36-1da052d45109' as ReturnType<typeof crypto.randomUUID>;
  expect(judgmentInputBoundary('read', { path: join(root, rawId, 'tracked.ts') }, root).passed).toBe(false);
  const id = spyOn(crypto, 'randomUUID').mockReturnValue(rawId);
  let snapshot: Awaited<ReturnType<typeof captureContractInput>>;
  try { snapshot = await captureContractInput(root); } finally { id.mockRestore(); }
  expect(isContractInputSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
  expect(isContractInputSnapshot({ ...snapshot, id: rawId })).toBe(true);
  expect(isContractInputSnapshot({ ...snapshot, id: '../outside' })).toBe(false);
  const frozen = await view(root, snapshot);
  const manager = new PermissionManager(async () => ({ approved: true }), {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => root,
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
  } as PermissionConfigReader, new PolicyRuntimeState());
  const authority = await createContractInputAuthority({ projectRoot: root, inputSnapshot: snapshot } as Contract, frozen);
  const ownerRead = async (path: string) => (await manager.readAccess(path)) === 'allow';
  const filter = async (path: string) => {
    try { await authorizeContractInputPath(authority, path, ownerRead); return true; } catch { return false; }
  };
  const map = await withContractInputAuthority(authority, () => defaultRepositoryMap(frozen, filter, filter));
  expect(map).toContain('value');
  expect(map).not.toContain('[access-restricted]');
  expect(snapshot.id).toMatch(/^[a-z-]+$/);
  expect(await manager.readAccess(join(root, rawId, 'tracked.ts'))).toBe('allow');
});


test('large repositories retain exact files through snapshot, planner and member materialization', async () => {
  const root = repo();
  // Exceeds both former limits (32 MiB per file and 256 MiB per repository).
  const bytes = 257 * 1024 * 1024;
  const fd = openSync(join(root, 'large.bin'), 'w');
  try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
  const snapshot = await captureContractInput(root);
  expect(isContractInputSnapshot(snapshot)).toBe(true);
  const frozen = await view(root, snapshot);
  expect(lstatSync(join(frozen, 'large.bin')).size).toBe(bytes);
  await assertContractInputView(snapshot);
  const member = join(root, '.goodvibes/member');
  await initializeContractMemberWorktree(frozen, {
    path: member,
    async create(commit, checkout) {
      expect(checkout).toBe(false);
      git(root, 'worktree', 'add', '--no-checkout', '-b', 'large-member', member, commit!);
    },
  });
  expect(lstatSync(join(member, 'large.bin')).size).toBe(bytes);
  expect(git(member, 'hash-object', 'large.bin').toString().trim()).toBe(snapshot.files.find(file => file.path === 'large.bin')!.oid!);
}, 30_000);
