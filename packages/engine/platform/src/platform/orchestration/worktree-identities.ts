/** Private exact tuple bookkeeping for Git resources. Labels grant no tool
 * authority, and a reservation never proves that Git actually created a tree. */
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { captureExistingDirectory, writeFileAtomic } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { tryAcquireCrossProcessLock, assertCrossProcessLockCurrent } from '../workspace/checkpoint/cross-process-lock.js';
import { readIsolatedWorktreeCreation, type IsolatedWorktree } from '../agents/worktree.js';
import type { GitWorktreeCreationFacts } from '../git/service.js';
import type { NativeDataWriteOwner } from '../runtime/native-reader-compatibility.js';

export const WORKTREE_IDENTITY_FILE = 'goodvibes-worktree-identities-v1.json';
const BRANCH = /^ws-owned\/[0-9a-p]{8}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{12}$/;
export interface WorktreeIdentityKey { readonly namespace: string | null; readonly workstreamId: string; readonly itemId: string }
export interface StoredWorktreeIdentity extends WorktreeIdentityKey {
  readonly branch: string;
  readonly state: 'reserved' | 'acquired' | 'initialized';
  readonly creation?: GitWorktreeCreationFacts;
}
interface Registry { readonly schema: 1; readonly rows: readonly StoredWorktreeIdentity[] }
const RESTART = 'Restart the contract or workstream; its worktrees and branches are kept.';
const STORE_NEXT = `Move ${WORKTREE_IDENTITY_FILE} out of the repository's git directory to start a new record (the worktrees it named are then reported as unattributed), or restart the work.`;
/** A refusal that says what was observed and what to do; nothing was changed. */
const refused = (observed: string, next = RESTART) => new Error(`Worktree isolation refused: ${observed}; nothing was changed. ${next}`);
const unreadableStore = (what: string) => refused(`the worktree record store ${WORKTREE_IDENTITY_FILE} ${what}`, STORE_NEXT);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameKey = (a: WorktreeIdentityKey, b: WorktreeIdentityKey) => a.namespace === b.namespace && a.workstreamId === b.workstreamId && a.itemId === b.itemId;
const tuple = (key: WorktreeIdentityKey) => JSON.stringify([key.namespace, key.workstreamId, key.itemId]);
const missing = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
function keySnapshot(key: WorktreeIdentityKey): WorktreeIdentityKey {
  const { namespace, workstreamId, itemId } = key;
  if (namespace !== null && typeof namespace !== 'string' || typeof workstreamId !== 'string' || typeof itemId !== 'string') throw unreadableStore('has an entry without a workstream and item id');
  return Object.freeze({ namespace, workstreamId, itemId });
}
function directoryStamp(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw refused(`${path} is no longer a plain directory`);
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
}
function nativePath(value: unknown): value is string { return typeof value === 'string' && isAbsolute(value) && resolve(value) === value; }
function parseCreation(value: unknown): GitWorktreeCreationFacts {
  if (!record(value) || !exact(value, ['schema', 'path', 'branch', 'worktree', 'administration', 'gitFile', 'head'])
    || value['schema'] !== 1 || !nativePath(value['path']) || typeof value['branch'] !== 'string' || !BRANCH.test(value['branch'])) throw unreadableStore('has a creation record it cannot read');
  const worktree = value['worktree'], administration = value['administration'], gitFile = value['gitFile'], head = value['head'];
  for (const directory of [worktree, administration]) {
    if (!record(directory) || !exact(directory, ['path', 'physical']) || !nativePath(directory['path'])
      || typeof directory['physical'] !== 'string' || !/^[0-9]+(?::[0-9]+){5}$/.test(directory['physical'])) throw unreadableStore('has a creation record with an unreadable directory');
    Object.freeze(directory);
  }
  if (!record(gitFile) || !exact(gitFile, ['path', 'physical', 'contents']) || !nativePath(gitFile['path'])
    || typeof gitFile['physical'] !== 'string' || !/^[0-9]+(?::[0-9]+){9}$/.test(gitFile['physical'])
    || typeof gitFile['contents'] !== 'string' || !gitFile['contents'].startsWith('gitdir: ') || !gitFile['contents'].endsWith('\n')) throw unreadableStore('has a creation record with an unreadable .git file');
  if (!record(head) || !exact(head, ['path', 'physical']) || !nativePath(head['path'])
    || typeof head['physical'] !== 'string' || !/^[0-9]+(?::[0-9]+){9}$/.test(head['physical'])) throw unreadableStore('has a creation record with an unreadable HEAD');
  // The preceding closed structural checks narrow the private saved format.
  const result = value as unknown as GitWorktreeCreationFacts;
  if (result.gitFile.path !== join(result.worktree.path, '.git') || result.head.path !== join(result.administration.path, 'HEAD')) throw unreadableStore('has a creation record whose paths do not belong together');
  Object.freeze(gitFile); Object.freeze(head); return Object.freeze(result);
}
function parseRegistry(bytes: Buffer): Registry {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw unreadableStore('is not valid JSON'); }
  if (!record(value) || !exact(value, ['schema', 'rows']) || value['schema'] !== 1 || !Array.isArray(value['rows'])) throw unreadableStore('is not in the format this version writes');
  const keys = new Set<string>(), branches = new Set<string>();
  const rows = value['rows'].map((raw: unknown): StoredWorktreeIdentity => {
    if (!record(raw) || !exact(raw, raw['state'] === 'reserved'
      ? ['namespace', 'workstreamId', 'itemId', 'branch', 'state'] : ['namespace', 'workstreamId', 'itemId', 'branch', 'state', 'creation'])
      || raw['namespace'] !== null && typeof raw['namespace'] !== 'string' || typeof raw['workstreamId'] !== 'string'
      || typeof raw['itemId'] !== 'string' || typeof raw['branch'] !== 'string' || !BRANCH.test(raw['branch'])
      || !['reserved', 'acquired', 'initialized'].includes(String(raw['state']))) throw unreadableStore('has an entry it cannot read');
    const key = keySnapshot(raw as unknown as WorktreeIdentityKey), serialized = tuple(key);
    if (keys.has(serialized) || branches.has(raw['branch'])) throw unreadableStore(`names the item or branch ${String(raw['branch'])} twice`);
    keys.add(serialized); branches.add(raw['branch']);
    if (raw['state'] === 'reserved') return Object.freeze({ ...key, branch: raw['branch'], state: 'reserved' });
    const creation = parseCreation(raw['creation']);
    if (creation.branch !== raw['branch']) throw unreadableStore(`has an entry for ${String(raw['branch'])} whose creation record names ${creation.branch}`);
    return Object.freeze({ ...key, branch: raw['branch'], state: raw['state'] as 'acquired' | 'initialized', creation });
  });
  return Object.freeze({ schema: 1, rows: Object.freeze(rows) });
}
function terminatedLine(bytes: Buffer): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw refused('a git pointer file is not UTF-8'); }
  if (!text.endsWith('\n')) throw refused('a git pointer file has an incomplete line');
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
        || process.geteuid && stat.uid !== BigInt(process.geteuid())) throw refused(`the worktree record store ${this.path} is not a private single-link file owned by this user (mode 600)`, `Check who changed ${this.path}; set it back to mode 600 owned by you, or move it aside to start a new record.`);
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
      const ownerChanged = () => refused('the owner of the worktree record store changed while it was being written');
      const writer = this.writer, declare = this.declare;
      if (writer.declare !== declare || !declare) throw ownerChanged();
      assertSynchronousJudgmentGuard(() => declare.call(writer, 'worktree-opaque-identities-v1'), ownerChanged);
      if (this.writer.declare !== this.declare) throw ownerChanged();
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
        if (Date.now() >= deadline) throw refused(`another process held the worktree record store lock ${lock} for 5 seconds`, 'Wait for the other run to finish its worktree step, then run the item again.');
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
      const heldRelease = release;
      if (!heldRelease) throw refused('the worktree record store lock was not held');
      currentOwner(); assertCrossProcessLockCurrent(heldRelease); const source = this.read();
      const current = () => {
        currentOwner();
        assertCrossProcessLockCurrent(heldRelease);
        let physical: string | null;
        try { physical = fileObservationIdentity(this.path); } catch (error) { if (!missing(error)) throw error; physical = null; }
        if (physical !== source.physical) throw refused('another process changed the worktree record store while this one was updating it', 'Run the item again; it reads the new record.');
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
      const branch = `ws-owned/${crypto.randomUUID()}`;
      if (registry.rows.some(row => row.branch === branch)) throw refused(`the new branch name ${branch} is already recorded`, 'Run the item again; a new name is drawn.');
      const row = Object.freeze({ ...key, branch, state: 'reserved' as const });
      return { value: row, rows: [...registry.rows, row] };
    });
  }
  /** Drop the row of a resource that no longer exists. Absent rows are a no-op (nothing is written). */
  release(key: WorktreeIdentityKey): Promise<void> {
    key = keySnapshot(key);
    return this.change(registry => {
      if (!registry.rows.some(row => sameKey(row, key))) return { value: undefined };
      return { value: undefined, rows: registry.rows.filter(row => !sameKey(row, key)) };
    });
  }
  async acquired(key: WorktreeIdentityKey, instance: IsolatedWorktree, initialized: boolean): Promise<StoredWorktreeIdentity> {
    key = keySnapshot(key);
    const proof = readIsolatedWorktreeCreation(instance);
    if (!proof) throw refused(`the worktree ${instance.path} carries no record of how it was created`);
    const current = () => { proof.assertCurrent(); this.assertCommonBinding(proof.facts); };
    current();
    return this.change(registry => {
      const index = registry.rows.findIndex(row => sameKey(row, key)), previous = registry.rows[index];
      if (!previous || previous.branch !== instance.branch) throw refused(`the record for item ${key.itemId} names ${previous?.branch ?? 'no branch'}, not ${instance.branch}`);
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
    if (realpathSync(resolve(facts.administration.path, terminatedLine(commonFile.bytes))) !== this.parent.canonical) throw refused(`the worktree ${facts.worktree.path} now belongs to another repository`);
    const backlink = readFileObservation(join(facts.administration.path, 'gitdir'));
    if (realpathSync(resolve(facts.administration.path, terminatedLine(backlink.bytes))) !== realpathSync(facts.gitFile.path)) throw refused(`git's record of the worktree ${facts.worktree.path} points elsewhere (it was moved or replaced)`, `Run git worktree repair, or remove it with git worktree remove --force ${facts.worktree.path}, then run the item again.`);
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
        if (next === cursor) throw refused(`${path} is not inside a git repository`, 'Run the work in a git repository, or without worktree isolation.'); cursor = next; continue;
      }
      if (stat.isDirectory() || stat.isSymbolicLink() && lstatSync(realpathSync(marker)).isDirectory()) {
        const common = captureExistingDirectory(marker);
        if (common.canonical !== this.parent.canonical) throw refused(`${path}'s git directory is not the repository this work started in`);
        headPath = join(common.canonical, 'HEAD');
        markerGuard = () => common.assertCurrent();
      } else {
        const git = readFileObservation(marker), text = terminatedLine(git.bytes);
        if (!text.startsWith('gitdir: ')) throw refused(`${marker} is not a git pointer file`);
        const admin = captureExistingDirectory(resolve(cursor, text.slice('gitdir: '.length)));
        headPath = join(admin.canonical, 'HEAD');
        if (admin.canonical === this.parent.canonical) {
          markerGuard = () => { admin.assertCurrent(); if (fileObservationIdentity(marker) !== git.physical) throw refused(`${marker} was replaced since this work started`); };
        } else {
          const commonPath = join(admin.canonical, 'commondir'), common = readFileObservation(commonPath);
          if (realpathSync(resolve(admin.canonical, terminatedLine(common.bytes))) !== this.parent.canonical) throw refused(`${path}'s git directory is not the repository this work started in`);
          markerGuard = () => {
            admin.assertCurrent();
            if (fileObservationIdentity(marker) !== git.physical || fileObservationIdentity(commonPath) !== common.physical) throw refused(`${marker} or its git directory was replaced since this work started`);
          };
        }
      }
      break;
    }
    // The base is compared by what HEAD names (its branch, or a detached commit), not by the
    // HEAD file's inode: git rewrites that file on every switch, so switching away and back must pass.
    const originalHead = terminatedLine(readFileObservation(headPath).bytes);
    const named = (head: string) => head.startsWith('ref: refs/heads/') ? `branch ${head.slice('ref: refs/heads/'.length)}` : `commit ${head.replace(/^ref: /u, '')}`;
    const current = () => {
      this.parent.assertCurrent(); root.assertCurrent(); markerGuard();
      const changed = environmentKeys.find((key, index) => process.env[key] !== environment[index]);
      if (changed !== undefined) throw refused(`the ${changed} environment variable changed since this work started`, `Restore ${changed} to what it was, or restart the work.`);
      const head = terminatedLine(readFileObservation(headPath).bytes);
      if (head !== originalHead) throw refused(`the project is now on ${named(head)}, but this work started on ${named(originalHead)}`, `Switch back to ${named(originalHead)} (git switch), or restart the work from the current branch.`);
      for (const marker of absent) {
        try { lstatSync(marker); } catch (error) { if (missing(error)) continue; throw error; }
        throw refused(`a new git repository appeared at ${marker} inside the project`, `Remove ${marker} or restart the work.`);
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
    if (!text.startsWith('gitdir: ')) throw refused(`${gitPath} is not a git worktree pointer file`, `Remove the worktree at ${path}, then run the item again.`);
    const admin = captureExistingDirectory(resolve(dirname(gitPath), text.slice('gitdir: '.length))), headPath = join(admin.canonical, 'HEAD');
    const head = readFileObservation(headPath);
    if (terminatedLine(head.bytes) !== `ref: refs/heads/${branch}`) throw refused(`the worktree ${path} is no longer on its branch ${branch}`, `Switch it back with git -C ${path} switch ${branch}, or remove the worktree and run the item again.`);
    const facts: GitWorktreeCreationFacts = { schema: 1, path, branch,
      worktree: { path: root.canonical, physical: directoryStamp(root.canonical) },
      administration: { path: admin.canonical, physical: directoryStamp(admin.canonical) },
      gitFile: { path: gitPath, physical: git.physical, contents: `${text}\n` }, head: { path: headPath, physical: head.physical } };
    const current = () => {
      this.parent.assertCurrent(); root.assertCurrent(); admin.assertCurrent();
      if (fileObservationIdentity(gitPath) !== git.physical) throw refused(`the worktree ${path}'s .git file was replaced`);
      if (terminatedLine(readFileObservation(headPath).bytes) !== `ref: refs/heads/${branch}`) throw refused(`the worktree ${path} is no longer on its branch ${branch}`, `Switch it back with git -C ${path} switch ${branch}, or remove the worktree and run the item again.`);
      this.assertCommonBinding(facts);
    };
    current(); return current;
  }

  /**
   * Compare a privately read acquired record with the actual registered tree:
   * the recorded path, the recorded .git pointer, git's own binding of that
   * pointer to this repository, and the owned branch. Inode and device stamps
   * recorded at creation are not compared (a project copied back or restored
   * from a backup has new ones and the same worktree); the stamps read here
   * guard the rest of this run against a replacement.
   * This does not turn a plain supplied DTO into a fresh creation token.
   */
  retainAcquired(row: StoredWorktreeIdentity, path: string): () => void {
    if (!this.owned.has(row) || row.state === 'reserved' || !row.creation) throw refused(`item ${row.itemId}'s worktree record was not read from the record store or never finished creating`);
    const facts = row.creation, root = captureExistingDirectory(path), admin = captureExistingDirectory(facts.administration.path);
    const moved = () => refused(`the worktree ${facts.worktree.path} was moved or replaced since it was created`, `Remove it with git worktree remove --force ${facts.worktree.path}, then run the item again.`);
    if (root.canonical !== facts.worktree.path || admin.canonical !== facts.administration.path
      || `${terminatedLine(readFileObservation(facts.gitFile.path).bytes)}\n` !== facts.gitFile.contents) throw moved();
    const stamps = { worktree: directoryStamp(root.canonical), administration: directoryStamp(admin.canonical), gitFile: fileObservationIdentity(facts.gitFile.path) };
    const current = () => {
      this.parent.assertCurrent(); root.assertCurrent(); admin.assertCurrent();
      if (directoryStamp(root.canonical) !== stamps.worktree || directoryStamp(admin.canonical) !== stamps.administration
        || fileObservationIdentity(facts.gitFile.path) !== stamps.gitFile) throw moved();
      if (terminatedLine(readFileObservation(facts.head.path).bytes) !== `ref: refs/heads/${facts.branch}`) {
        throw refused(`the worktree ${facts.worktree.path} is no longer on its branch ${facts.branch}`, `Switch it back with git -C ${facts.worktree.path} switch ${facts.branch}, or remove the worktree and run the item again.`);
      }
      this.assertCommonBinding(facts);
    };
    current(); return current;
  }
}
