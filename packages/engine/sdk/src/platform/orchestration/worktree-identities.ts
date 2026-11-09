/** Private exact tuple bookkeeping for Git resources. Labels grant no tool
 * authority, and a reservation never proves that Git actually created a tree. */
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { drainOwned, opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { captureExistingDirectory, writeFileAtomic } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { tryAcquireCrossProcessLock, assertCrossProcessLockCurrent } from '../workspace/checkpoint/cross-process-lock.js';
import { readIsolatedWorktreeCreation, type IsolatedWorktree } from '../agents/worktree.js';
import type { GitWorktreeCreationFacts } from '../git/service.js';
import type { NativeDataWriteOwner } from '../runtime/native-reader-compatibility.js';

export const WORKTREE_IDENTITY_FILE = 'goodvibes-worktree-identities-v1.json';
const BRANCH = /^ws-owned\/[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/;
export interface WorktreeIdentityKey { readonly namespace: string | null; readonly workstreamId: string; readonly itemId: string }
export interface StoredWorktreeIdentity extends WorktreeIdentityKey {
  readonly branch: string;
  readonly state: 'reserved' | 'acquired' | 'initialized';
  readonly creation?: GitWorktreeCreationFacts;
}
interface Registry { readonly schema: 1; readonly rows: readonly StoredWorktreeIdentity[] }
const unavailable = () => new Error('Native worktree identity is unavailable; original resources preserved');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameKey = (a: WorktreeIdentityKey, b: WorktreeIdentityKey) => a.namespace === b.namespace && a.workstreamId === b.workstreamId && a.itemId === b.itemId;
const tuple = (key: WorktreeIdentityKey) => JSON.stringify([key.namespace, key.workstreamId, key.itemId]);
const missing = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
function keySnapshot(key: WorktreeIdentityKey): WorktreeIdentityKey {
  const { namespace, workstreamId, itemId } = key;
  if (namespace !== null && typeof namespace !== 'string' || typeof workstreamId !== 'string' || typeof itemId !== 'string') throw unavailable();
  return Object.freeze({ namespace, workstreamId, itemId });
}
function directoryStamp(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
}
function nativePath(value: unknown): value is string { return typeof value === 'string' && isAbsolute(value) && resolve(value) === value; }
function parseCreation(value: unknown): GitWorktreeCreationFacts {
  if (!record(value) || !exact(value, ['schema', 'path', 'branch', 'worktree', 'administration', 'gitFile', 'head'])
    || value['schema'] !== 1 || !nativePath(value['path']) || typeof value['branch'] !== 'string' || !BRANCH.test(value['branch'])) throw unavailable();
  const worktree = value['worktree'], administration = value['administration'], gitFile = value['gitFile'], head = value['head'];
  for (const directory of [worktree, administration]) {
    if (!record(directory) || !exact(directory, ['path', 'physical']) || !nativePath(directory['path'])
      || typeof directory['physical'] !== 'string' || !/^[0-9]+(?::[0-9]+){5}$/.test(directory['physical'])) throw unavailable();
    Object.freeze(directory);
  }
  if (!record(gitFile) || !exact(gitFile, ['path', 'physical', 'contents']) || !nativePath(gitFile['path'])
    || typeof gitFile['physical'] !== 'string' || !/^[0-9]+(?::[0-9]+){9}$/.test(gitFile['physical'])
    || typeof gitFile['contents'] !== 'string' || !gitFile['contents'].startsWith('gitdir: ') || !gitFile['contents'].endsWith('\n')) throw unavailable();
  if (!record(head) || !exact(head, ['path', 'physical']) || !nativePath(head['path'])
    || typeof head['physical'] !== 'string' || !/^[0-9]+(?::[0-9]+){9}$/.test(head['physical'])) throw unavailable();
  // The preceding closed structural checks narrow the private saved format.
  const result = value as unknown as GitWorktreeCreationFacts;
  if (result.gitFile.path !== join(result.worktree.path, '.git') || result.head.path !== join(result.administration.path, 'HEAD')) throw unavailable();
  Object.freeze(gitFile); Object.freeze(head); return Object.freeze(result);
}
function parseRegistry(bytes: Buffer): Registry {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw unavailable(); }
  if (!record(value) || !exact(value, ['schema', 'rows']) || value['schema'] !== 1 || !Array.isArray(value['rows'])) throw unavailable();
  const keys = new Set<string>(), branches = new Set<string>();
  const rows = value['rows'].map((raw: unknown): StoredWorktreeIdentity => {
    if (!record(raw) || !exact(raw, raw['state'] === 'reserved'
      ? ['namespace', 'workstreamId', 'itemId', 'branch', 'state'] : ['namespace', 'workstreamId', 'itemId', 'branch', 'state', 'creation'])
      || raw['namespace'] !== null && typeof raw['namespace'] !== 'string' || typeof raw['workstreamId'] !== 'string'
      || typeof raw['itemId'] !== 'string' || typeof raw['branch'] !== 'string' || !BRANCH.test(raw['branch'])
      || !['reserved', 'acquired', 'initialized'].includes(String(raw['state']))) throw unavailable();
    const key = keySnapshot(raw as unknown as WorktreeIdentityKey), serialized = tuple(key);
    if (keys.has(serialized) || branches.has(raw['branch'])) throw unavailable();
    keys.add(serialized); branches.add(raw['branch']);
    if (raw['state'] === 'reserved') return Object.freeze({ ...key, branch: raw['branch'], state: 'reserved' });
    const creation = parseCreation(raw['creation']);
    if (creation.branch !== raw['branch']) throw unavailable();
    return Object.freeze({ ...key, branch: raw['branch'], state: raw['state'] as 'acquired' | 'initialized', creation });
  });
  return Object.freeze({ schema: 1, rows: Object.freeze(rows) });
}
function terminatedLine(bytes: Buffer): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw unavailable(); }
  if (!text.endsWith('\n')) throw unavailable();
  return text.slice(0, -1);
}

/** A closed native store read authenticates these rows; parsing a Workstream or
 * copying a saved DTO does not create an acquisition observation. */
export class WorktreeIdentityRegistry {
  private readonly parent: ReturnType<typeof captureExistingDirectory>;
  private readonly path: string;
  private readonly owned = new WeakSet<StoredWorktreeIdentity>();
  private readonly declare: NativeDataWriteOwner['declare'] | undefined;
  constructor(commonDirectory: string, private readonly writer?: NativeDataWriteOwner) {
    this.parent = captureExistingDirectory(commonDirectory);
    this.path = join(this.parent.canonical, WORKTREE_IDENTITY_FILE);
    this.declare = writer?.declare;
  }
  get commonDirectory(): string { return this.parent.canonical; }
  private read(): { readonly value: Registry; readonly physical: string | null } {
    this.parent.assertCurrent();
    try {
      const stat = lstatSync(this.path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n
        || process.geteuid && stat.uid !== BigInt(process.geteuid())) throw unavailable();
      const source = readFileObservation(this.path); this.parent.assertCurrent();
      const value = parseRegistry(source.bytes);
      for (const row of value.rows) this.owned.add(row);
      return { value, physical: source.physical };
    } catch (error) {
      if (missing(error)) { this.parent.assertCurrent(); return { value: Object.freeze({ schema: 1, rows: Object.freeze([]) }), physical: null }; }
      throw error;
    }
  }
  find(key: WorktreeIdentityKey): StoredWorktreeIdentity | undefined {
    key = keySnapshot(key); return this.read().value.rows.find(row => sameKey(row, key));
  }
  forWorkstream(namespace: string | null, workstreamId: string): readonly StoredWorktreeIdentity[] {
    return this.read().value.rows.filter(row => row.namespace === namespace && row.workstreamId === workstreamId);
  }
  private beforeWrite(): void {
    this.parent.assertCurrent();
    if (this.writer) {
      if (this.writer.declare !== this.declare || !this.declare) throw unavailable();
      const returned: unknown = this.declare.call(this.writer, 'worktree-opaque-identities-v1');
      if (returned !== undefined) { drainOwned(returned); throw unavailable(); }
      if (this.writer.declare !== this.declare) throw unavailable();
      this.parent.assertCurrent();
    }
  }
  private async change<T>(update: (registry: Registry) => { readonly value: T; readonly rows?: readonly StoredWorktreeIdentity[] }, extra: () => void = () => {}): Promise<T> {
    let release: (() => void) | null = null;
    const currentOwner = () => { this.parent.assertCurrent(); extra(); };
    const deadline = Date.now() + 5000, lock = `${this.path}.lock`;
    try {
      while (!release) {
        currentOwner(); release = tryAcquireCrossProcessLock(lock, { assertCurrent: currentOwner });
        if (release) break;
        if (Date.now() >= deadline) throw unavailable();
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
      const heldRelease = release;
      if (!heldRelease) throw unavailable();
      currentOwner(); assertCrossProcessLockCurrent(heldRelease); const source = this.read();
      const current = () => {
        currentOwner();
        assertCrossProcessLockCurrent(heldRelease);
        let physical: string | null;
        try { physical = fileObservationIdentity(this.path); } catch (error) { if (!missing(error)) throw error; physical = null; }
        if (physical !== source.physical) throw unavailable();
      };
      current(); const result = update(source.value); this.beforeWrite(); current();
      if (result.rows) {
        const next = { schema: 1 as const, rows: result.rows };
        writeFileAtomic(this.path, `${JSON.stringify(next)}\n`, { assertCurrent: current, cleanupStaleTemps: false, mkdirp: false, durable: true });
        for (const row of result.rows) this.owned.add(row);
      }
      return result.value;
    } finally { release?.(); }
  }
  reserve(key: WorktreeIdentityKey): Promise<StoredWorktreeIdentity> {
    key = keySnapshot(key);
    return this.change(registry => {
      const existing = registry.rows.find(row => sameKey(row, key));
      if (existing) return { value: existing };
      const branch = `ws-owned/${opaqueUuid()}`;
      if (registry.rows.some(row => row.branch === branch)) throw unavailable();
      const row = Object.freeze({ ...key, branch, state: 'reserved' as const });
      return { value: row, rows: [...registry.rows, row] };
    });
  }
  async acquired(key: WorktreeIdentityKey, instance: IsolatedWorktree, initialized: boolean): Promise<StoredWorktreeIdentity> {
    key = keySnapshot(key);
    const proof = readIsolatedWorktreeCreation(instance);
    if (!proof) throw unavailable();
    const current = () => { proof.assertCurrent(); this.assertCommonBinding(proof.facts); };
    current();
    return this.change(registry => {
      const index = registry.rows.findIndex(row => sameKey(row, key)), previous = registry.rows[index];
      if (!previous || previous.branch !== instance.branch) throw unavailable();
      const sameOrigin = previous.creation?.worktree.physical === proof.facts.worktree.physical
        && previous.creation.administration.physical === proof.facts.administration.physical
        && previous.creation.gitFile.physical === proof.facts.gitFile.physical && previous.creation.head.physical === proof.facts.head.physical;
      const row = Object.freeze({ ...key, branch: instance.branch, state: initialized || previous.state === 'initialized' && sameOrigin ? 'initialized' as const : 'acquired' as const, creation: proof.facts });
      return { value: row, rows: registry.rows.map((entry, i) => i === index ? row : entry) };
    }, current);
  }
  private assertCommonBinding(facts: GitWorktreeCreationFacts): void {
    this.parent.assertCurrent();
    const commonFile = readFileObservation(join(facts.administration.path, 'commondir'));
    if (realpathSync(resolve(facts.administration.path, terminatedLine(commonFile.bytes))) !== this.parent.canonical) throw unavailable();
    const backlink = readFileObservation(join(facts.administration.path, 'gitdir'));
    if (realpathSync(resolve(facts.administration.path, terminatedLine(backlink.bytes))) !== realpathSync(facts.gitFile.path)) throw unavailable();
  }
  assertCurrent(): void { this.parent.assertCurrent(); }

  /** Retain the declared root's original Git discovery markers separately
   * from an item directory that a successful cleanup legitimately removes. */
  retainRepository(path: string): () => void {
    const root = captureExistingDirectory(path), absent: string[] = [];
    const environmentKeys = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_NAMESPACE'] as const;
    const environment = environmentKeys.map(key => process.env[key]);
    let cursor = root.canonical, markerGuard: () => void, headPath: string;
    for (;;) {
      if (cursor === this.parent.canonical && cursor === root.canonical) {
        headPath = join(cursor, 'HEAD'); markerGuard = () => this.parent.assertCurrent(); break;
      }
      const marker = join(cursor, '.git');
      let stat;
      try { stat = lstatSync(marker); }
      catch (error) {
        if (!missing(error)) throw error;
        absent.push(marker); const next = dirname(cursor);
        if (next === cursor) throw unavailable(); cursor = next; continue;
      }
      if (stat.isDirectory() || stat.isSymbolicLink() && lstatSync(realpathSync(marker)).isDirectory()) {
        const common = captureExistingDirectory(marker);
        if (common.canonical !== this.parent.canonical) throw unavailable();
        headPath = join(common.canonical, 'HEAD');
        markerGuard = () => common.assertCurrent();
      } else {
        const git = readFileObservation(marker), text = terminatedLine(git.bytes);
        if (!text.startsWith('gitdir: ')) throw unavailable();
        const admin = captureExistingDirectory(resolve(cursor, text.slice('gitdir: '.length)));
        headPath = join(admin.canonical, 'HEAD');
        if (admin.canonical === this.parent.canonical) {
          markerGuard = () => { admin.assertCurrent(); if (fileObservationIdentity(marker) !== git.physical) throw unavailable(); };
        } else {
          const commonPath = join(admin.canonical, 'commondir'), common = readFileObservation(commonPath);
          if (realpathSync(resolve(admin.canonical, terminatedLine(common.bytes))) !== this.parent.canonical) throw unavailable();
          markerGuard = () => {
            admin.assertCurrent();
            if (fileObservationIdentity(marker) !== git.physical || fileObservationIdentity(commonPath) !== common.physical) throw unavailable();
          };
        }
      }
      break;
    }
    const originalHead = readFileObservation(headPath);
    const current = () => {
      this.parent.assertCurrent(); root.assertCurrent(); markerGuard();
      if (environmentKeys.some((key, index) => process.env[key] !== environment[index])) throw unavailable();
      if (fileObservationIdentity(headPath) !== originalHead.physical) throw unavailable();
      for (const marker of absent) {
        try { lstatSync(marker); } catch (error) { if (missing(error)) continue; throw error; }
        throw unavailable();
      }
    };
    current(); return current;
  }

  /** A real host-recorded old item can retain its current registered binding.
   * This restriction is not a creation receipt and never upgrades a reservation. */
  retainRecorded(path: string, branch: string): () => void {
    this.parent.assertCurrent();
    const root = captureExistingDirectory(path), gitPath = join(root.canonical, '.git'), git = readFileObservation(gitPath);
    const text = terminatedLine(git.bytes);
    if (!text.startsWith('gitdir: ')) throw unavailable();
    const admin = captureExistingDirectory(resolve(dirname(gitPath), text.slice('gitdir: '.length))), headPath = join(admin.canonical, 'HEAD');
    const head = readFileObservation(headPath);
    if (terminatedLine(head.bytes) !== `ref: refs/heads/${branch}`) throw unavailable();
    const facts: GitWorktreeCreationFacts = { schema: 1, path, branch,
      worktree: { path: root.canonical, physical: directoryStamp(root.canonical) },
      administration: { path: admin.canonical, physical: directoryStamp(admin.canonical) },
      gitFile: { path: gitPath, physical: git.physical, contents: `${text}\n` }, head: { path: headPath, physical: head.physical } };
    const current = () => {
      this.parent.assertCurrent(); root.assertCurrent(); admin.assertCurrent();
      if (fileObservationIdentity(gitPath) !== git.physical || fileObservationIdentity(headPath) !== head.physical) throw unavailable();
      this.assertCommonBinding(facts);
    };
    current(); return current;
  }

  /** Compare a privately read acquired record with the actual registered tree.
   * This does not turn a plain supplied DTO into a fresh creation token. */
  retainAcquired(row: StoredWorktreeIdentity, path: string): () => void {
    if (!this.owned.has(row) || row.state === 'reserved' || !row.creation) throw unavailable();
    const facts = row.creation, root = captureExistingDirectory(path), admin = captureExistingDirectory(facts.administration.path);
    const current = () => {
      this.parent.assertCurrent(); root.assertCurrent(); admin.assertCurrent();
      if (root.canonical !== facts.worktree.path || directoryStamp(root.canonical) !== facts.worktree.physical
        || directoryStamp(admin.canonical) !== facts.administration.physical || fileObservationIdentity(facts.gitFile.path) !== facts.gitFile.physical
        || fileObservationIdentity(facts.head.path) !== facts.head.physical) throw unavailable();
      this.assertCommonBinding(facts);
    };
    current(); return current;
  }
}
