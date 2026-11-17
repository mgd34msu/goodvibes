import { markCapturedInputPath } from './input-authority.js';
/**
 * Local, content-addressed contract input. Membership grants no read or
 * transmission permission.
 *
 * A contract's input is recorded as a git tree and commit, nothing else: the
 * tree names every captured path with its mode and blob id, so it is the
 * manifest. Capture copies the owner's index and runs `git add -A` into the
 * copy, so git's own stat cache decides which files need hashing (an unchanged
 * file is not read), then `git write-tree`. "Is the owner (or a view) still the
 * captured input" is the same computation compared with the recorded tree id;
 * a check writes nothing to the repository's objects or index. The receipt has
 * a constant size whatever the size of the repository.
 *
 * Two facts an older per-file receipt carried are not kept: a second SHA-256
 * digest of each file in SHA-1 repositories (the blobs come from the
 * repository's own object store, which git itself trusts; the receipt is local
 * and anyone who could plant a colliding blob can already write the
 * repository), and a stat identity per file (git's index stat cache does that
 * job, per check, without a record per file).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, type BigIntStats } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir, uptime } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Runtime state and known credential-store directories are never contract input, even when tracked. */
export const CONTRACT_INPUT_EXCLUSIONS = ['.git', '.goodvibes', '.ssh', '.aws', '.gnupg'] as const;
const GIT_METADATA_BYTES = 256 * 1024 * 1024;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** One file of a version 1 or 2 receipt. New receipts record no per-file entries. */
export interface ContractInputFile {
  readonly path: string;
  readonly kind: 'file' | 'symlink' | 'missing';
  readonly mode: '100644' | '100755' | '120000' | '0';
  readonly oid?: string | undefined;
  readonly digest?: string | undefined;
  readonly identity?: string | undefined;
}

/** A versioned local receipt. Native objects establish provenance, not permission. */
export interface ContractInputSnapshot {
  readonly version: 1 | 2 | 3;
  readonly id: string;
  readonly sourceRoot: string;
  readonly sourceIdentity: string;
  readonly gitIdentity: string;
  readonly ownerHead: string;
  readonly ownerRef: string;
  /** Digest of the owner's staged entries and their flags at capture. */
  readonly indexFingerprint: string;
  readonly inputTree: string;
  readonly inputCommit: string;
  readonly capturedAt: number;
  /** Includes staged-only differences, exclusions from HEAD and all working-tree differences. */
  readonly dirty: boolean;
  readonly exclusions: readonly string[];
  /** Version 1 and 2 receipts only; read for compatibility and otherwise unused (the tree is the manifest). */
  readonly files?: readonly ContractInputFile[] | undefined;
}

export interface CaptureContractInputOptions {
  readonly signal?: AbortSignal | undefined;
  /** Optional caller-selected resource budgets. Repository size is not an admission policy. */
  readonly maxBytes?: number | undefined;
  readonly maxFiles?: number | undefined;
}

function directoryIdentity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}`; }
function fileIdentity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
function safePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
function excluded(path: string, exclusions: readonly string[]): boolean { return path.split('/').some((part) => exclusions.includes(part)); }

/** Do not inherit caller Git routing, signers, editors or optional-lock behavior. */
function git(root: string, args: readonly string[], input?: Buffer, env: Readonly<Record<string, string>> = {}, allowNoMatch = false): Buffer {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'commit.gpgsign=false', ...args], {
    env: { ...inherited, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'GoodVibes Input', GIT_AUTHOR_EMAIL: 'input@goodvibes.local', GIT_COMMITTER_NAME: 'GoodVibes Input', GIT_COMMITTER_EMAIL: 'input@goodvibes.local', ...env },
    input, maxBuffer: GIT_METADATA_BYTES, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 && !(allowNoMatch && result.status === 1)) throw new Error(`contract input git ${args[0]} failed: ${result.error?.message ?? result.stderr?.toString().trim() ?? 'unknown error'}`);
  return result.stdout ?? Buffer.alloc(0);
}
function gitText(root: string, args: readonly string[], input?: Buffer, env?: Readonly<Record<string, string>>): string { return git(root, args, input, env).toString('utf8').trim(); }

function paths(root: string, exclusions: readonly string[]): string[] {
  const bytes = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('contract input contains a non-UTF-8 path');
  return [...new Set(text.split('\0').filter(Boolean))].filter((path) => {
    // Git reports an unignored nested runtime worktree as a directory ending
    // in '/'. Exclude only the canonical owned root before the stricter file
    // path check; do not normalize traversal, repeated separators or lookalikes.
    const generated = path.endsWith('/') ? path.slice(0, -1) : path;
    if (exclusions.includes('.goodvibes') && (generated === '.goodvibes' || generated.startsWith('.goodvibes/')) && safePath(generated)) return false;
    if (!safePath(path)) throw new Error('contract input contains an ambiguous path');
    return !excluded(path, exclusions);
  }).sort();
}

/** Read-only source inventory using the same Git routing and ignore rules as native input capture. */
export function listContractInputPaths(root: string, exclusions: readonly string[] = CONTRACT_INPUT_EXCLUSIONS): readonly string[] {
  return paths(root, exclusions);
}

/** Excluded names at any depth, as the file itself and as a directory. */
const EXCLUDED_PATHSPECS = CONTRACT_INPUT_EXCLUSIONS.filter((name) => name !== '.git')
  .flatMap((name) => [`**/${name}`, `**/${name}/**`]);

/**
 * The tree id of `root`'s working tree as contract input: tracked and
 * unignored files, minus the excluded names. A private copy of the index takes
 * the update, so the owner's index and staging are never written, and its stat
 * cache means only changed files are hashed. `writeObjects` stores new blobs in
 * the repository (capture, which later checks out the tree); otherwise they go
 * to a private object directory that borrows the repository's objects (a check).
 */
function workingTree(root: string, writeObjects: boolean): string {
  const index = gitText(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const objects = gitText(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const scratch = mkdtempSync(join(tmpdir(), 'goodvibes-contract-input-'));
  try {
    const scratchIndex = join(scratch, 'index');
    if (existsSync(index)) copyFileSync(index, scratchIndex);
    const env: Record<string, string> = { GIT_INDEX_FILE: scratchIndex };
    if (!writeObjects) {
      mkdirSync(join(scratch, 'objects'));
      env['GIT_OBJECT_DIRECTORY'] = join(scratch, 'objects');
      env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = objects;
    }
    git(root, ['add', '-A', '--', '.', ...EXCLUDED_PATHSPECS.map((spec) => `:(exclude,glob)${spec}`)], undefined, env);
    // Tracked files under an excluded name are dropped from the copy too.
    git(root, ['rm', '-r', '--cached', '-f', '-q', '--ignore-unmatch', '--', ...EXCLUDED_PATHSPECS.map((spec) => `:(glob)${spec}`)], undefined, env);
    const tree = gitText(root, ['write-tree'], undefined, env);
    if (!HASH.test(tree)) throw new Error('contract input tree identity is unavailable');
    return tree;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** One entry of a captured tree. */
interface TreeEntry { readonly mode: string; readonly oid: string; readonly size: number; readonly path: string }

function treeEntries(root: string, tree: string): TreeEntry[] {
  const bytes = git(root, ['ls-tree', '-r', '-l', '-z', tree]);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('contract input contains a non-UTF-8 path');
  return text.split('\0').filter(Boolean).map((entry) => {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t([\s\S]+)$/.exec(entry);
    if (match === null) throw new Error('contract input tree has an unreadable entry');
    return { mode: match[1]!, oid: match[3]!, size: match[4] === '-' ? 0 : Number(match[4]), path: match[5]! };
  });
}

/**
 * The tree may hold only regular files and symlinks at safe, non-excluded
 * paths, and every symlink must resolve inside the tree without a cycle: a
 * checked-out link must not reach outside the workspace it is checked out in.
 */
function assertTreeShape(root: string, entries: readonly TreeEntry[]): void {
  const available = new Set<string>();
  const links = new Map<string, string>();
  for (const entry of entries) {
    if (entry.mode === '160000') throw new Error(`contract input contains a submodule: ${entry.path}`);
    if (entry.mode !== '100644' && entry.mode !== '100755' && entry.mode !== '120000') throw new Error(`contract input contains an unsupported file kind: ${entry.path}`);
    if (!safePath(entry.path) || excluded(entry.path, CONTRACT_INPUT_EXCLUSIONS)) throw new Error('contract input contains an unsupported path');
    available.add(entry.path);
  }
  for (const entry of entries) {
    if (entry.mode !== '120000') continue;
    const target = git(root, ['cat-file', 'blob', entry.oid]);
    if (!Buffer.from(target.toString('utf8')).equals(target)) throw new Error(`contract input contains a non-UTF-8 symlink: ${entry.path}`);
    links.set(entry.path, target.toString('utf8'));
  }
  for (const [path, target] of links) {
    if (target.length === 0) throw new Error(`contract input contains an empty symlink: ${path}`);
    let next = path;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(next)) throw new Error(`contract input contains a symlink cycle: ${path}`);
      seen.add(next);
      const link = links.get(next);
      if (link === undefined) break;
      if (isAbsolute(link) || link.includes('\\') || link.includes('\0')) throw new Error(`contract input contains an absolute or ambiguous symlink: ${path}`);
      const destination = relative('/snapshot', resolve('/snapshot', dirname(next), link)).split(sep).join('/');
      if (!safePath(destination) || !available.has(destination)) throw new Error(`contract input symlink escapes or has an uncaptured target: ${path}`);
      next = destination;
    }
  }
}

/** The owner's staged entries and their flags. Git supplies no object id for
 * this logical state; its digest lets a later check tell a benign index rewrite
 * (same entries) from a change to what is staged. */
function indexFingerprint(root: string): string {
  return createHash('sha256').update(git(root, ['ls-files', '--stage', '-z'])).update(git(root, ['ls-files', '-v', '-z'])).digest('hex');
}
/** Older physical-only pins cannot be recomputed; their check is the tree comparison alone. */
const INDEX_OBSERVATION_PREFIX = 'git-index-v2:';
function indexObservation(value: string): string | undefined {
  if (!value.startsWith(INDEX_OBSERVATION_PREFIX)) return undefined;
  const observation = value.slice(INDEX_OBSERVATION_PREFIX.length);
  return observation === 'missing' || /^-?\d+(?::-?\d+){5}$/.test(observation) ? observation : undefined;
}

/** Owner Git operations belong to the owner, including abandoned locks that need manual recovery. */
async function assertOwnerGitIdle(root: string, signal?: AbortSignal): Promise<void> {
  const gitDir = gitText(root, ['rev-parse', '--absolute-git-dir']);
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']) {
    signal?.throwIfAborted();
    try { await lstat(join(gitDir, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error(`a Git operation is in progress in your repository (${name}); finish or abort it, then retry`);
  }
}

async function repositoryIdentity(root: string): Promise<string> {
  const gitDir = gitText(root, ['rev-parse', '--absolute-git-dir']);
  const commonDir = gitText(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const marker = await lstat(join(root, '.git'), { bigint: true });
  return [marker.isDirectory() ? directoryIdentity(marker) : fileIdentity(marker), gitDir, directoryIdentity(await lstat(gitDir, { bigint: true })), commonDir, directoryIdentity(await lstat(commonDir, { bigint: true }))].join('|');
}

const captures = new Map<string, Promise<void>>();

/** One capture per canonical root in this process. Independent processes still get distinct ids. */
export async function captureContractInput(sourceRoot: string, options: CaptureContractInputOptions = {}): Promise<ContractInputSnapshot> {
  options.signal?.throwIfAborted();
  const root = await realpath(sourceRoot);
  const previous = captures.get(root) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolveTail) => { release = resolveTail; });
  captures.set(root, tail);
  await previous;
  try { return await capture(root, options); }
  finally { release(); if (captures.get(root) === tail) captures.delete(root); }
}

async function capture(root: string, options: CaptureContractInputOptions): Promise<ContractInputSnapshot> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (gitText(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('contract input requires the repository root');
  await assertOwnerGitIdle(root, signal);
  const sourceIdentity = directoryIdentity(await lstat(root, { bigint: true }));
  const gitIdentity = await repositoryIdentity(root);
  const ownerHead = gitText(root, ['rev-parse', 'HEAD']);
  const ownerRef = gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const index = indexFingerprint(root);
  signal?.throwIfAborted();
  const inputTree = workingTree(root, true);
  const entries = treeEntries(root, inputTree);
  if (options.maxFiles !== undefined && entries.length > options.maxFiles) throw new Error('contract input exceeds caller file-count budget');
  if (options.maxBytes !== undefined && entries.reduce((total, entry) => total + entry.size, 0) > options.maxBytes) throw new Error('contract input exceeds byte bound selected by caller');
  assertTreeShape(root, entries);
  signal?.throwIfAborted();
  const headTree = gitText(root, ['rev-parse', `${ownerHead}^{tree}`]);
  const dirty = inputTree !== headTree || git(root, ['diff-index', '--cached', '--raw', '-z', ownerHead, '--']).length > 0;
  // A clean generation uses the real owner commit; synthetic input never enters clean owner history.
  const inputCommit = inputTree === headTree ? ownerHead : gitText(root, ['commit-tree', inputTree, '-p', ownerHead, '-m', 'Local contract input; not a deliverable']);
  // The owner moved while the tree was written: the capture is of no single state.
  if (gitText(root, ['rev-parse', 'HEAD']) !== ownerHead || indexFingerprint(root) !== index) throw new ContractInputOwnerChangedError('index', 'your repository changed while the contract input was captured; retry');
  // Encode generated opaque IDs without numeric runs; the privacy floor still
  // evaluates every original/captured path and must not be relaxed for UUIDs.
  return { version: 3, id: randomUUID().replace(/[0-9]/g, (digit) => String.fromCharCode(107 + Number(digit))), sourceRoot: root, sourceIdentity, gitIdentity, ownerHead, ownerRef, indexFingerprint: index, inputTree, inputCommit, capturedAt: Date.now(), dirty, exclusions: [...CONTRACT_INPUT_EXCLUSIONS] };
}

/** A working owner change can be assessed for publication without replacing
 * the original captured input or treating a repository replacement as drift. */
export class ContractInputOwnerChangedError extends Error {
  constructor(readonly change: 'head' | 'index' | 'paths' | 'file', message: string) { super(message); }
}

/** The owner switched branches since capture: publication waits for the owner, who is told how to proceed. */
export class ContractInputBranchSwitchedError extends Error {
  override readonly name = 'ContractInputBranchSwitchedError';
  constructor(readonly capturedRef: string, readonly currentRef: string) {
    super(`your repository is on ${currentRef === 'HEAD' ? 'a detached HEAD' : `branch ${currentRef}`}, but this contract started from ${capturedRef === 'HEAD' ? 'a detached HEAD' : `branch ${capturedRef}`}; switch back to ${capturedRef} to publish it`);
  }
}

/**
 * Whether the owner's repository still holds exactly the captured input: same
 * repository, branch and HEAD, same staged entries, and a working tree whose
 * tree id is the captured one. Writes nothing. Cost: about eight git processes,
 * of which `git add` hashes only files whose stat data changed.
 */
export async function assertContractInputOwner(snapshot: ContractInputSnapshot, signal?: AbortSignal): Promise<void> {
  const root = snapshot.sourceRoot;
  signal?.throwIfAborted();
  await assertOwnerGitIdle(root, signal);
  if (await realpath(root) !== root || directoryIdentity(await lstat(root, { bigint: true })) !== snapshot.sourceIdentity) throw new Error('contract input source root was replaced');
  if (await repositoryIdentity(root) !== snapshot.gitIdentity) throw new Error('contract input Git directory was replaced');
  const ref = gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (ref !== snapshot.ownerRef) throw new ContractInputBranchSwitchedError(snapshot.ownerRef, ref);
  if (gitText(root, ['rev-parse', 'HEAD']) !== snapshot.ownerHead) throw new ContractInputOwnerChangedError('head', 'your branch has new commits since the contract started');
  if (indexObservation(snapshot.indexFingerprint) === undefined && indexFingerprint(root) !== snapshot.indexFingerprint)
    throw new ContractInputOwnerChangedError('index', 'your staged changes differ from when the contract started');
  signal?.throwIfAborted();
  if (workingTree(root, false) !== snapshot.inputTree) throw new ContractInputOwnerChangedError('file', 'your files changed since the contract started');
}

/** Kept for callers of the older per-file receipt; there is no per-file proof to lend, so a caller reads the bytes itself. */
export function originalContractInputFileDigest(_file: ContractInputFile, _root: string, _path: string): { readonly digest: string; readonly assertCurrent: () => void } | undefined {
  return undefined;
}

/** Historical readers retain the recorded repository identity without requiring live owner files/HEAD. */
export async function assertContractInputGitIdentity(snapshot: ContractInputSnapshot): Promise<void> {
  if (await repositoryIdentity(snapshot.sourceRoot) !== snapshot.gitIdentity)
    throw new Error('contract input Git directory was replaced');
}

/** Device numbers can change across boots (for example on Btrfs). Rebind only
 * that component after checking the owner and the captured view. This does not
 * recapture input, reuse judgments, or accept a replacement inode.
 */
export async function restoreContractInputDevice(snapshot: ContractInputSnapshot, signal?: AbortSignal): Promise<ContractInputSnapshot> {
  const current = directoryIdentity(await lstat(snapshot.sourceRoot, { bigint: true }));
  if (current === snapshot.sourceIdentity) return snapshot;
  const previous = /^(\d+):(\d+)$/.exec(snapshot.sourceIdentity);
  const present = /^(\d+):(\d+)$/.exec(current);
  if (!previous || !present || previous[2] !== present[2] || previous[1] === present[1]
    || snapshot.capturedAt >= Date.now() - uptime() * 1000 - 5000)
    throw new Error('contract input source root was replaced');
  const replaceDevice = (value: string): string => value.startsWith(`${previous[1]}:`)
    ? `${present[1]}${value.slice(previous[1]!.length)}` : value;
  const restored: ContractInputSnapshot = {
    ...snapshot,
    sourceIdentity: current,
    gitIdentity: snapshot.gitIdentity.split('|').map(replaceDevice).join('|'),
  };
  await assertContractInputView(restored, signal);
  return restored;
}

/** Verify persisted object provenance, without recapturing today's owner tree. One `git rev-parse`. */
export function assertContractInputObjects(snapshot: ContractInputSnapshot, projectRoot: string): void {
  if (!snapshot.dirty && snapshot.inputCommit !== snapshot.ownerHead) throw new Error('clean contract input must name the recorded owner commit');
  if (resolve(projectRoot) !== snapshot.sourceRoot) throw new Error('contract input receipt belongs to a different source root');
  if (gitText(projectRoot, ['rev-parse', `${snapshot.inputCommit}^{tree}`]) !== snapshot.inputTree) throw new Error('contract input commit/tree receipt mismatch');
}

/** Check out `commit` into a worktree created without a checkout. Hooks are off; no owner file or index is touched. */
function checkOut(worktreePath: string, commit: string, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  git(worktreePath, ['read-tree', '--reset', '-u', commit]);
  signal?.throwIfAborted();
}

/** Fill a worktree created at the input commit (without a checkout) with the captured tree. */
export async function materializeContractInput(snapshot: ContractInputSnapshot, worktreePath: string, signal?: AbortSignal): Promise<void> {
  markCapturedInputPath(worktreePath);
  assertContractInputObjects(snapshot, snapshot.sourceRoot);
  checkOut(worktreePath, snapshot.inputCommit, signal);
}

/** Strict receipt validation at the persistence boundary; no receipt grants authority. */
export function isContractInputSnapshot(value: unknown): value is ContractInputSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if ((v['version'] !== 1 && v['version'] !== 2 && v['version'] !== 3) || typeof v['id'] !== 'string' || (!/^[0-9a-f-]{36}$/.test(v['id']) && !/^[a-fk-t]{8}-[a-fk-t]{4}-[a-fk-t]{4}-[a-fk-t]{4}-[a-fk-t]{12}$/.test(v['id'])) || typeof v['sourceRoot'] !== 'string' || !isAbsolute(v['sourceRoot']) || typeof v['sourceIdentity'] !== 'string' || typeof v['gitIdentity'] !== 'string' || typeof v['ownerRef'] !== 'string' || typeof v['capturedAt'] !== 'number' || !Number.isFinite(v['capturedAt']) || typeof v['dirty'] !== 'boolean') return false;
  if (!['ownerHead', 'inputTree', 'inputCommit'].every((key) => typeof v[key] === 'string' && HASH.test(v[key] as string))
    || typeof v['indexFingerprint'] !== 'string' || !(SHA256.test(v['indexFingerprint']) || v['version'] !== 1 && indexObservation(v['indexFingerprint']) !== undefined) || v['ownerIndex'] !== undefined) return false;
  if (!Array.isArray(v['exclusions']) || JSON.stringify(v['exclusions']) !== JSON.stringify(CONTRACT_INPUT_EXCLUSIONS)) return false;
  if (v['version'] === 3) return v['files'] === undefined;
  if (!Array.isArray(v['files'])) return false;
  const pathsSeen = new Set<string>();
  for (const file of v['files']) {
    if (file === null || typeof file !== 'object') return false;
    const f = file as Record<string, unknown>;
    if (typeof f['path'] !== 'string' || !safePath(f['path']) || excluded(f['path'], CONTRACT_INPUT_EXCLUSIONS) || pathsSeen.has(f['path'])) return false;
    pathsSeen.add(f['path']);
    if (f['kind'] === 'missing') { if (f['mode'] !== '0' || f['oid'] !== undefined || f['digest'] !== undefined || f['identity'] !== undefined) return false; }
    else if ((f['kind'] !== 'file' && f['kind'] !== 'symlink') || (f['kind'] === 'file' ? f['mode'] !== '100644' && f['mode'] !== '100755' : f['mode'] !== '120000') || typeof f['oid'] !== 'string' || !HASH.test(f['oid'])
      || (v['version'] === 1 || (f['oid'] as string).length === 40
        ? typeof f['digest'] !== 'string' || !SHA256.test(f['digest']) : f['digest'] !== undefined)
      || typeof f['identity'] !== 'string') return false;
  }
  return true;
}

/** Each generation has a distinct planner path, so read decisions are never reused across generations. */
export function contractInputPath(snapshot: ContractInputSnapshot): string {
  return join(snapshot.sourceRoot, '.goodvibes', '.worktrees', 'contract-input', snapshot.id);
}

/** Regular files of captured trees with their blob ids, by repository and tree id; a tree id never changes meaning, so a reading is reused. */
const treeFiles = new Map<string, ReadonlyMap<string, { readonly oid: string; readonly size: number }>>();
const TREE_FILES_KEPT = 16;

function capturedBlobs(snapshot: ContractInputSnapshot): ReadonlyMap<string, { readonly oid: string; readonly size: number }> {
  const key = `${snapshot.sourceRoot}\0${snapshot.inputTree}`;
  let blobs = treeFiles.get(key);
  if (blobs === undefined) {
    blobs = new Map(treeEntries(snapshot.sourceRoot, snapshot.inputTree)
      .filter((entry) => entry.mode === '100644' || entry.mode === '100755')
      .map((entry) => [entry.path, { oid: entry.oid, size: entry.size }] as const));
    if (treeFiles.size >= TREE_FILES_KEPT) treeFiles.delete(treeFiles.keys().next().value!);
    treeFiles.set(key, blobs);
  }
  return blobs;
}

/** Git's blob id of `bytes`, in the repository's object format (a 40-character id is SHA-1, 64 is SHA-256). */
function blobId(bytes: Buffer, idLength: number): string {
  return createHash(idLength === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** One line per path: its stat identity, or `-` when it is absent. Two or three `lstat` calls, no process. */
function statWitness(paths: readonly string[]): string {
  return paths.map((path) => {
    try { return fileIdentity(lstatSync(path, { bigint: true })); }
    catch { return '-'; }
  }).join('|');
}

/** Absolute paths of git's own files for a worktree (HEAD, its index, a ref). One `git rev-parse`. */
function gitPaths(worktreePath: string, names: readonly string[]): readonly string[] {
  return gitText(worktreePath, ['rev-parse', '--path-format=absolute', ...names.flatMap((name) => ['--git-path', name])]).split('\n');
}

/** The regular files of the captured input, from `git ls-tree` once per tree. Never a read grant. */
export function contractInputFiles(snapshot: ContractInputSnapshot): readonly string[] {
  return Object.freeze([...capturedBlobs(snapshot).keys()]);
}

/** A planner can resume only from its recorded input generation, never today's source or a result tree. */
export async function assertContractInputView(snapshot: ContractInputSnapshot, signal?: AbortSignal, viewPath = contractInputPath(snapshot)): Promise<void> {
  assertContractInputObjects(snapshot, snapshot.sourceRoot);
  signal?.throwIfAborted();
  if (gitText(viewPath, ['rev-parse', 'HEAD']) !== snapshot.inputCommit) throw new Error('contract input view no longer names the recorded commit');
  if (workingTree(viewPath, false) !== snapshot.inputTree) throw new Error('contract input view changed');
  signal?.throwIfAborted();
}

/**
 * The whole-view check of an immutable view, and a per-path check of each file
 * a tool reads. The guarantee is that nothing a tool delivers differs from the
 * captured tree. A full check records the stat identity of every captured file
 * and then compares the view's tree id with the captured one; after that the
 * whole check only compares the stat identity of the view's HEAD and index (git
 * changes one of them for any checkout, reset or staging) and runs in full
 * again when they moved. A path whose stat identity is not the recorded one
 * (an edit made in place from outside) has its bytes matched with the captured
 * blob id before it is used, so a change is caught where it would be delivered.
 */
export interface ContractInputViewAssertion {
  (): Promise<void>;
  /** The path is a captured regular file whose bytes are the captured blob. One `lstat` for an unchanged file. */
  readonly assertPath: (path: string, signal?: AbortSignal) => Promise<void>;
}
export function createContractInputViewAssertion(snapshot: ContractInputSnapshot, signal?: AbortSignal, viewPath = contractInputPath(snapshot)): ContractInputViewAssertion {
  // Stat identity of each captured file whose bytes are known to be the captured blob.
  let known = new Map<string, string>();
  let witnessFiles: readonly string[] | undefined;
  let witness: string | undefined;
  const changed = () => new Error('contract input view changed at accessed path');
  const assertPath = async (path: string, current?: AbortSignal) => {
    signal?.throwIfAborted(); current?.throwIfAborted();
    const full = join(viewPath, path);
    const stat = await lstat(full, { bigint: true });
    signal?.throwIfAborted(); current?.throwIfAborted();
    if (stat.isDirectory()) return;
    const blob = capturedBlobs(snapshot).get(path);
    if (!stat.isFile() || blob === undefined) throw changed();
    const id = fileIdentity(stat);
    if (known.get(path) === id) return;
    if (Number(stat.size) !== blob.size || blobId(await readFile(full), blob.oid.length) !== blob.oid) throw changed();
    if (fileIdentity(await lstat(full, { bigint: true })) !== id) throw changed();
    known.set(path, id);
  };
  const sweep = async (): Promise<Map<string, string>> => {
    const ids = new Map<string, string>();
    const paths = [...capturedBlobs(snapshot).keys()];
    for (let start = 0; start < paths.length; start += 64) {
      signal?.throwIfAborted();
      await Promise.all(paths.slice(start, start + 64).map(async (path) => {
        try {
          const stat = await lstat(join(viewPath, path), { bigint: true });
          if (stat.isFile()) ids.set(path, fileIdentity(stat));
        } catch { /* Absent: an access fails on its own lstat. */ }
      }));
    }
    return ids;
  };
  const whole = async (): Promise<void> => {
    signal?.throwIfAborted();
    witnessFiles ??= gitPaths(viewPath, ['HEAD', 'index']);
    const before = statWitness(witnessFiles);
    if (before === witness) return;
    // Identities first, tree second: a file changed after its identity was taken changes the tree or its identity.
    const ids = await sweep();
    await assertContractInputView(snapshot, signal, viewPath);
    if (statWitness(witnessFiles) !== before) throw new Error('contract input view changed while it was checked');
    known = ids;
    witness = before;
  };
  return Object.freeze(Object.assign(whole, { assertPath }));
}

/**
 * `assertContractExecutionView` for one member worktree, run in full only when
 * git's HEAD, the branch ref or the packed refs changed since the last full
 * run (a branch switch, a commit, a reset); otherwise three `lstat` calls.
 */
export function createContractExecutionViewAssertion(snapshot: ContractInputSnapshot, worktreePath: string, branch: string): () => void {
  let witnessFiles: readonly string[] | undefined;
  let witness: string | undefined;
  return () => {
    witnessFiles ??= gitPaths(worktreePath, ['HEAD', `refs/heads/${branch}`, 'packed-refs']);
    const before = statWitness(witnessFiles);
    if (before === witness) return;
    assertContractExecutionView(snapshot, worktreePath, branch);
    witness = statWitness(witnessFiles) === before ? before : undefined;
  };
}

/** Member worktrees start from the contract's current exact Git tree, without owner checkout hooks. */
export async function initializeContractMemberWorktree(sourceRoot: string, worktree: { readonly path: string; create(startPoint?: string, checkout?: boolean): Promise<void> }): Promise<void> {
  markCapturedInputPath(worktree.path);
  const commit = gitText(sourceRoot, ['rev-parse', 'HEAD']);
  // A link a unit committed must not reach outside the member's workspace either.
  assertTreeShape(sourceRoot, treeEntries(sourceRoot, commit));
  await worktree.create(commit, false);
  checkOut(worktree.path, commit);
}

/** A result tree must still descend from its recorded input; never adopt an unrelated workspace. */
export function assertContractExecutionView(snapshot: ContractInputSnapshot, worktreePath: string, branch: string): void {
  if (gitText(worktreePath, ['rev-parse', '--show-toplevel']) !== resolve(worktreePath) || gitText(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) throw new Error('contract execution workspace no longer names its recorded branch');
  git(worktreePath, ['merge-base', '--is-ancestor', snapshot.inputCommit, 'HEAD']);
}

/** Refuse symlinked runtime storage before creating a captured view. Never follow a redirected parent. */
export async function prepareContractInputParent(snapshot: ContractInputSnapshot, target: string): Promise<void> {
  const rel = relative(snapshot.sourceRoot, dirname(target));
  if (!safePath(rel) || !rel.startsWith('.goodvibes/')) throw new Error('contract input workspace is outside runtime storage');
  let current = snapshot.sourceRoot;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('contract input workspace parent is redirected');
  }
}
