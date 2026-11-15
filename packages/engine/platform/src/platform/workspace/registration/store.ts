/**
 * workspace/registration/store.ts
 *
 * The daemon-side registered-workspace store (user-scoped state, injectable
 * I/O) plus the impure worktree-link probe the resolver's git metadata comes
 * from.
 *
 * PERSISTENCE follows the sibling control-plane stores (PrincipalStore,
 * ChannelProfileStore …): a versioned JSON document over the shared
 * PersistentStore, which supports a `:memory:` path for deterministic tests,
 * that is the injectable-I/O seam. The persisted `workspaces` array is
 * field-identical to the agent registry so its file migrates in.
 *
 * ROOT-GUARD. `add` refuses an absurdly broad root ($HOME, the filesystem root,
 * or the daemon state dir) via the SAME broadRootReason the checkpoint manager
 * already uses, a registration store must never let automatic coverage sweep a
 * whole home directory.
 *
 * CONCURRENCY. Every mutation here is a READ-MODIFY-WRITE: `read()` loads the
 * whole document, the method edits one array, and `persist()` replaces the
 * file. `PersistentStore.persist` is one atomic replacement, so nobody sees a
 * torn file, but it does not close the window between the read and the write,
 * which is exactly what its own header says belongs to the caller that owns the
 * read. Two registrations interleaved there lose one of the two roots outright:
 * both read the same array, both append their own record, and the second write
 * replaces the first. The lost root then has no coverage and nothing says so.
 *
 * And this store, alone among the daemon's stores, is contended ACROSS
 * PROCESSES: `goodvibes register` in a project directory writes the same
 * user-scoped file the running daemon writes, so an in-process queue on its own
 * would order this process's writes and still lose the other's. Every
 * read-modify-write therefore runs under BOTH, the in-process chain and the
 * advisory lock at `<file>.lock`, which is the shape `push/subscription-store.ts`
 * already uses for the same reason.
 */

import { PersistentStore } from '../../state/persistent-store.js';
import { confirmFileDurable } from '../../utils/atomic-json-store.js';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { sep } from 'node:path';
import { acquireCrossProcessLock, CrossProcessLockBusyError, withCrossProcessLockSync } from '../checkpoint/cross-process-lock.js';
import { broadRootReason } from '../checkpoint/root-guard.js';
import { normalizeWorkspaceRoot, resolveWorkspaceRegistration } from './resolution.js';
import {
  WorkspaceRegistrationError,
  NativeWorkspaceScopeError,
  type NativeWorkspaceScope,
  type NativeWorkspaceScopeReason,
  type DeclinedWorkspaceRecord,
  type RegisteredWorkspaceRecord,
  type ResolveWorkspaceInput,
  type WorkspaceGitMetadata,
  type WorkspaceRegistrySnapshot,
  type WorkspaceResolution,
} from './types.js';
import { probeWorktreeLinkAsync } from './worktree-link.js';

interface PersistedRegistry extends Record<string, unknown> {
  version: 1 | 2;
  workspaces: RegisteredWorkspaceRecord[];
  declines: DeclinedWorkspaceRecord[];
  registryId?: string;
  scopeGeneration?: number;
}

const EPOCH = new Date(0).toISOString();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : EPOCH;
}

/** Keep one row per root: the later timestamp wins, a tie keeps the first seen. */
function dedupe<T extends { readonly root: string }>(rows: readonly T[], at: (row: T) => string): T[] {
  const byRoot = new Map<string, T>();
  for (const row of rows) {
    const seen = byRoot.get(row.root);
    if (!seen || at(row) > at(seen)) byRoot.set(row.root, row);
  }
  return [...byRoot.values()];
}

/**
 * The one definition of a valid legacy (version 1) row, applied wherever legacy
 * rows enter: reading a version 1 register and folding the pre-split copy in.
 * Roots are normalized, a missing or unparseable timestamp reads as the oldest
 * possible (the row predates the field), rows without a root are dropped, and
 * duplicate roots collapse to the later row. A version 1 row never carries a
 * native scope, even if a copied row has a similarly named field. After this,
 * promoting the document to version 2 on the first write cannot fail on an old
 * row.
 */
export function normalizeLegacyRegisterRows(workspaces: unknown, declines: unknown): {
  readonly workspaces: RegisteredWorkspaceRecord[];
  readonly declines: DeclinedWorkspaceRecord[];
} {
  const rows: RegisteredWorkspaceRecord[] = [];
  for (const row of Array.isArray(workspaces) ? workspaces as unknown[] : []) {
    if (!isObject(row) || typeof row.root !== 'string' || row.root.trim() === '') continue;
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    const origin = typeof row.origin === 'string' ? row.origin.trim() : '';
    rows.push({
      root: normalizeWorkspaceRoot(row.root.trim()),
      registeredAt: timestamp(row.registeredAt),
      ...(label ? { label } : {}),
      ...(origin ? { origin } : {}),
      ...(row.checkpointEligible === true ? { checkpointEligible: true } : {}),
    });
  }
  const declined: DeclinedWorkspaceRecord[] = [];
  for (const row of Array.isArray(declines) ? declines as unknown[] : []) {
    if (!isObject(row) || typeof row.root !== 'string' || row.root.trim() === '') continue;
    declined.push({ root: normalizeWorkspaceRoot(row.root.trim()), declinedAt: timestamp(row.declinedAt) });
  }
  return { workspaces: dedupe(rows, (row) => row.registeredAt), declines: dedupe(declined, (row) => row.declinedAt) };
}

function validate(snapshot: PersistedRegistry | null): PersistedRegistry {
  if (!snapshot) return { version: 1, workspaces: [], declines: [] };
  if ((snapshot.version !== 1 && snapshot.version !== 2) || !Array.isArray(snapshot.workspaces)) {
    throw new Error('Workspace registration store snapshot is invalid.');
  }
  if (snapshot.version === 2) {
    const generation = snapshot.scopeGeneration;
    const validGeneration = (value: unknown): value is number => typeof value === 'number'
      && Number.isSafeInteger(value) && value > 0 && value <= (generation ?? 0);
    const validRoot = (value: unknown): value is string => typeof value === 'string' && value.length > 0
      && normalizeWorkspaceRoot(value) === value;
    const validId = (value: unknown, prefix: string): value is string => typeof value === 'string'
      && new RegExp(`^${prefix}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(value);
    if (!validId(snapshot.registryId, 'workspace-registry') || !validGeneration(generation)
      || !Array.isArray(snapshot.declines)) {
      throw new Error('Workspace native scope metadata is invalid.');
    }
    const roots = new Set<string>();
    const ids = new Set<string>();
    for (const row of snapshot.workspaces) {
      if (!row || !validRoot(row.root) || typeof row.registeredAt !== 'string' || roots.has(row.root)) {
        const what = !row || typeof row.root !== 'string' ? 'a row without a root'
          : roots.has(row.root) ? `a second row for ${row.root}` : `the row for ${row.root}`;
        throw new Error(`Workspace registration is invalid: ${what} (root must be normalized and unique, registeredAt a string).`);
      }
      roots.add(row.root);
      if (row.nativeScope !== undefined) {
        const scope = row.nativeScope;
        if (!scope || !validId(scope.id, 'workspace') || !validRoot(scope.canonicalRoot)
          || !validGeneration(scope.generation) || ids.has(scope.id)) {
          throw new Error(`Workspace native incarnation is invalid for ${row.root}.`);
        }
        ids.add(scope.id);
      }
    }
    const badDecline = snapshot.declines.find((row) => !row || !validRoot(row.root) || typeof row.declinedAt !== 'string');
    if (badDecline !== undefined) {
      throw new Error(`Workspace decline is invalid${badDecline && typeof badDecline.root === 'string' ? ` for ${badDecline.root}` : ''}.`);
    }
    return snapshot;
  }
  return { version: 1, ...normalizeLegacyRegisterRows(snapshot.workspaces, snapshot.declines) };
}

/** One synchronous read of the register file, judged by the store's own rules. */
export type WorkspaceRegisterRead =
  | { readonly state: 'absent' }
  | {
    readonly state: 'ok';
    readonly version: 1 | 2;
    /** v1 rows come normalized (see normalizeLegacyRegisterRows). */
    readonly workspaces: readonly RegisteredWorkspaceRecord[];
    readonly declines: readonly DeclinedWorkspaceRecord[];
  }
  | { readonly state: 'unreadable'; readonly reason: string };

/**
 * Read the register at `path` synchronously, accepting exactly what the store
 * accepts. For callers that cannot await the store (start-up composition, the
 * per-event checkpoint gate); they take no lock, so they may see the previous
 * complete file but never a torn one (writes are one atomic rename).
 */
export function readWorkspaceRegisterSync(path: string): WorkspaceRegisterRead {
  let bytes: string;
  try {
    bytes = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    // `validate` is the runtime check of this shape; anything else throws there.
    const state = validate(JSON.parse(bytes) as PersistedRegistry | null);
    return { state: 'ok', version: state.version, workspaces: state.workspaces, declines: state.declines };
  } catch (error) {
    return { state: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Short digest of the registrations and declines at or below `root`, ignoring everything elsewhere in the registry. */
function subtreeDigest(root: string, registrations: readonly RegisteredWorkspaceRecord[], declinedRoots: readonly string[]): string {
  const within = (candidate: string): boolean => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  const rows = {
    workspaces: registrations.filter((row) => within(row.root)).map((row) => [row.root, row.nativeScope?.id ?? null]).sort(),
    declines: declinedRoots.filter(within).sort(),
  };
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

function canonicalDirectory(root: string): string | null {
  try {
    const canonical = normalizeWorkspaceRoot(realpathSync(root));
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch { return null; }
}

/**
 * Synchronous legacy boot writers cannot wait on an async lock. They take the
 * same `<file>.lock` the store's writers take and fail at once on contention,
 * before reading.
 */
export function withWorkspaceRegistrationWriteLockSync<T>(path: string, write: () => T): T {
  try { return withCrossProcessLockSync(`${path}.lock`, write); } catch (error) {
    if (!(error instanceof CrossProcessLockBusyError)) throw error;
    throw Object.assign(new Error('Workspace registry writer lock is already owned.', { cause: error }), { code: 'WORKSPACE_REGISTRY_BUSY' });
  }
}

/** Fresh prospective generation. Legacy rows remain without nativeScope. */
function advance(state: PersistedRegistry): PersistedRegistry {
  const generation = state.version === 2 ? state.scopeGeneration! + 1 : 1;
  if (!Number.isSafeInteger(generation)) throw new Error('Workspace scope generation exhausted.');
  // Removal tombstones written by earlier builds were never read; drop them.
  const { scopeTombstones: _dropped, ...rest } = state;
  return {
    ...rest, version: 2, registryId: state.version === 2 ? state.registryId! : `workspace-registry:${randomUUID()}`,
    scopeGeneration: generation,
  };
}

function fileIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

const SCOPE_REFUSALS: Record<NativeWorkspaceScopeReason, (root: string, detail?: string) => { state: string; next: readonly string[] }> = {
  'not-registered': (root) => ({ state: `${root} is not a registered workspace`,
    next: [`Register ${root} (workspaces.registrations.add, or \`goodvibes-agent workspaces register --yes\` in that directory), then retry.`] }),
  declined: (root, detail) => ({ state: `registration was declined at ${detail ?? root}`,
    next: [`Register ${root} explicitly (workspaces.registrations.add), which clears that decline, then retry.`] }),
  'registry-unreadable': (_root, detail) => ({ state: `the workspace register cannot be read${detail ? `: ${detail}` : ''}`,
    next: ['Repair or remove the bad entry in the workspace register (~/.goodvibes/shared), then retry.'] }),
  'root-missing': (root) => ({ state: `${root} is not an existing directory`,
    next: ['Run the work from an existing project directory, or recreate the directory, then retry.'] }),
  unmigrated: (root) => ({ state: `${root} was registered before native work existed and has no native scope`,
    next: [`Register ${root} again (workspaces.registrations.add); that grants its native scope. Then retry.`] }),
  changed: (root, detail) => ({ state: `the registration of ${root} changed${detail ? ` (${detail})` : ''}`,
    next: ['Start the step again so it reads the current registration.'] }),
  retry: (_root, detail) => ({ state: `the workspace register changed or could not be confirmed on disk while it was read${detail ? `: ${detail}` : ''}`,
    next: ['Retry; nothing was changed.'] }),
};

function scopeRefusal(code: NativeWorkspaceScopeError['code'], reason: NativeWorkspaceScopeReason, root: string, detail?: string): NativeWorkspaceScopeError {
  const { state, next } = SCOPE_REFUSALS[reason](root, detail);
  return new NativeWorkspaceScopeError(code, { reason, state, next });
}

/** One store per register file in this process, so its queue orders every writer and reader here. */
const openStores = new Map<string, WorkspaceRegistrationStore>();

/**
 * The process's store for `options.path`, created on first use. Every caller
 * in one process that reads or writes the shared register goes through this, so
 * the in-process queue orders all of them. `:memory:` always gets a new store.
 */
export function openWorkspaceRegistrationStore(options: WorkspaceRegistrationStoreOptions): WorkspaceRegistrationStore {
  if (options.path === ':memory:') return new WorkspaceRegistrationStore(options);
  let store = openStores.get(options.path);
  if (!store) { store = new WorkspaceRegistrationStore(options); openStores.set(options.path, store); }
  return store;
}

export interface WorkspaceRegistrationStoreOptions {
  /** Persistence path (or `:memory:` for tests). */
  readonly path: string;
  /** The user's home directory, refused as a broad root. */
  readonly homeDir: string;
  /** The daemon state directory (~/.goodvibes), refused as a broad root. */
  readonly daemonStateDir: string;
  /**
   * A second path to READ from when `path` does not exist yet, the pre-split
   * location, during the one auto-update cycle before the daemon's boot fold
   * moves the register into the shared tier. Never written to: a
   * read-modify-write that started from the fallback still persists to `path`.
   * See registration/shared-register-path.ts.
   */
  readonly fallbackReadPath?: string | undefined;
  /** Injectable worktree-link probe (sync or async); defaults to a real, non-blocking `git rev-parse` probe. */
  readonly probe?: (path: string) => WorkspaceGitMetadata | Promise<WorkspaceGitMetadata>;
}

export interface RegisterWorkspaceResult {
  readonly record: RegisteredWorkspaceRecord;
  readonly alreadyRegistered: boolean;
  /** True when this call gave an already registered root its native scope (it was registered before native work existed). */
  readonly nativeScopeGranted?: boolean;
}

export class WorkspaceRegistrationStore {
  private readonly store: PersistentStore<PersistedRegistry>;
  private readonly path: string;
  private memoryState: PersistedRegistry | null = null;
  /** Identity (device, inode, size, times) of the last register file confirmed on disk by this store. */
  private durableIdentity: string | null = null;
  /** Read-only source for the pre-split location; see fallbackReadPath. */
  private readonly fallbackStore: PersistentStore<PersistedRegistry> | null;
  private readonly homeDir: string;
  private readonly daemonStateDir: string;
  private readonly probe: (path: string) => WorkspaceGitMetadata | Promise<WorkspaceGitMetadata>;
  /** Orders read-modify-writes within this process. See the header. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceRegistrationStoreOptions) {
    this.path = options.path;
    this.store = new PersistentStore<PersistedRegistry>(options.path);
    this.fallbackStore = options.fallbackReadPath
      ? new PersistentStore<PersistedRegistry>(options.fallbackReadPath)
      : null;
    this.homeDir = options.homeDir;
    this.daemonStateDir = options.daemonStateDir;
    this.probe = options.probe ?? probeWorktreeLinkAsync;
  }

  /**
   * Run `fn` as the only read-modify-write against this file, in this process
   * AND across processes.
   *
   * The chain orders callers here; the advisory lock keeps the CLI's
   * registration from being clobbered by the daemon's, and vice versa. A
   * `:memory:` store has no file to contend on and takes the chain only.
   *
   * The chain tracks COMPLETION, never OUTCOME: `next.catch` keeps it alive
   * after a rejection, so one failed registration cannot wedge the store for
   * the life of the process, and the rejection still reaches the caller that
   * owns it and nobody else. `then(guarded, guarded)` rather than `then(guarded)`
   * for the same reason, a settled predecessor must run the next one either way.
   */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      const lockPath = this.store.lockPath;
      if (!lockPath) return fn();
      const release = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 10_000 });
      try {
        return await fn();
      } finally {
        release();
      }
    };
    const next = this.queue.then(guarded, guarded);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<PersistedRegistry> {
    const primary = await this.store.load();
    // A register that has not been folded into the shared tier yet still has to
    // be visible, or an updated product would report the operator's registered
    // workspaces as gone until the daemon next booted.
    if (primary === null && this.fallbackStore !== null) {
      return validate(await this.fallbackStore.load());
    }
    return validate(primary);
  }

  private async readForMutation(): Promise<PersistedRegistry> {
    const primary = await this.store.load();
    if (primary === null && this.fallbackStore !== null) {
      const fallback = validate(await this.fallbackStore.load());
      // A vanished authority file must not be reconstituted from a stale copy.
      // Legacy v1 coverage remains importable, without native incarnations.
      if (fallback.version === 2) throw new Error('Workspace mutation refuses a native-authority fallback registry.');
      return fallback;
    }
    return validate(primary);
  }

  private async persist(state: PersistedRegistry): Promise<void> {
    validate(state);
    // A failed write fails this call only. Bytes a failed write may have left
    // visible are confirmed on disk by the next scope read before it trusts them.
    await this.store.persist(state, { durable: state.version === 2 });
    if (this.path === ':memory:') this.memoryState = structuredClone(state);
    // The write itself made these bytes durable; the next scope read need not sync them again.
    else if (state.version === 2) {
      try { this.durableIdentity = fileIdentity(statSync(this.path, { bigint: true })); } catch { this.durableIdentity = null; }
    }
  }

  /**
   * Read the register's bytes, confirming once per file identity that they are
   * on disk: a crash can leave a renamed-in file visible before it was synced,
   * and native admission must not trust it until it is. Later reads of the same
   * file cost an open, an fstat and a read.
   */
  private readDurableBytes(root: string): string | null {
    let fd: number;
    try { fd = openSync(this.path, 'r'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw scopeRefusal('unavailable', 'registry-unreadable', root, error instanceof Error ? error.message : String(error));
    }
    let bytes: string;
    let identity: string;
    try {
      identity = fileIdentity(fstatSync(fd, { bigint: true }));
      bytes = readFileSync(fd, 'utf-8');
    } catch (error) {
      throw scopeRefusal('unavailable', 'registry-unreadable', root, error instanceof Error ? error.message : String(error));
    } finally { closeSync(fd); }
    // Writers replace the file by rename, never in place, so bytes read from a
    // file already confirmed are confirmed bytes.
    if (identity === this.durableIdentity) return bytes;
    try {
      confirmFileDurable(this.path);
      if (fileIdentity(statSync(this.path, { bigint: true })) !== identity) throw new Error('the file was replaced during the read');
    } catch (error) {
      throw scopeRefusal('unavailable', 'retry', root, error instanceof Error ? error.message : String(error));
    }
    this.durableIdentity = identity;
    return bytes;
  }

  /**
   * Strict authoritative read, deliberately without legacy fallback, corruption
   * recovery, or authority migration. No cached scope survives a removed file.
   * Worktree-link facts are not accepted as authority by this first native slice.
   * A refusal names its state and next step (NativeWorkspaceScopeError.refusal).
   */
  currentScope(root: string): NativeWorkspaceScope {
    let state: PersistedRegistry;
    let raw: PersistedRegistry | null;
    if (this.path === ':memory:') raw = this.memoryState;
    else {
      const bytes = this.readDurableBytes(root);
      try { raw = bytes === null ? null : JSON.parse(bytes) as PersistedRegistry; } catch (error) {
        throw scopeRefusal('unavailable', 'registry-unreadable', root, error instanceof Error ? error.message : String(error));
      }
    }
    if (raw === null) throw scopeRefusal('unavailable', 'not-registered', root);
    try { state = validate(raw); } catch (error) {
      throw scopeRefusal('unavailable', 'registry-unreadable', root, error instanceof Error ? error.message : String(error));
    }
    if (state.version !== 2) throw scopeRefusal('unmigrated', 'unmigrated', root);
    const canonical = canonicalDirectory(root);
    if (!canonical) throw scopeRefusal('unavailable', 'root-missing', root);
    const registrations = state.workspaces.map((row) => ({
      ...row, root: canonicalDirectory(row.root) ?? row.root,
    }));
    const declinedRoots = state.declines.map((row) => canonicalDirectory(row.root) ?? row.root);
    const resolution = resolveWorkspaceRegistration({
      path: canonical, registrations,
      declines: state.declines.map((row, index) => ({ ...row, root: declinedRoots[index]! })),
    });
    if (resolution.status === 'declined') throw scopeRefusal('unavailable', 'declined', canonical, resolution.declinedRoot ?? undefined);
    if (resolution.status !== 'covered') throw scopeRefusal('unavailable', 'not-registered', canonical);
    const matching = registrations.filter((row) => row.root === resolution.coveredBy);
    if (matching.length !== 1) {
      throw scopeRefusal('unavailable', 'registry-unreadable', canonical, `${matching.length} registrations resolve to ${resolution.coveredBy}; remove all but one with workspaces.registrations.remove`);
    }
    const registered = matching[0]!;
    const scope = registered.nativeScope;
    if (!scope) throw scopeRefusal('unmigrated', 'unmigrated', registered.root);
    if (scope.canonicalRoot !== registered.root) {
      throw scopeRefusal('changed', 'changed', registered.root, `it was registered as ${scope.canonicalRoot} and now resolves to ${registered.root}; register it again`);
    }
    const broad = broadRootReason(registered.root, this.homeDir, this.daemonStateDir);
    if (broad) throw scopeRefusal('changed', 'changed', registered.root, `it is ${broad}`);
    return Object.freeze({ root: canonical, scopeId: scope.id,
      // This root's own incarnation plus what is registered or declined inside its
      // subtree. The registry-wide generation moves on every unrelated add, remove
      // or decline and would stale every in-flight input; a nearer registration or
      // a decline below this root, and a removed-then-re-added root, still change it.
      scopeRevision: `${state.registryId!}:${scope.generation}:${subtreeDigest(registered.root, registrations, declinedRoots)}` });
  }

  /**
   * Run `callback` holding the register's writer lock, after one check that
   * `expected` is still the current scope. Every writer of the register takes
   * that lock, so nothing can change the registration while the callback runs:
   * the `assertCurrent` it is handed only says whether the callback is still
   * inside this call, with no read.
   */
  withCurrentScope<T>(expected: NativeWorkspaceScope, callback: (assertCurrent: () => void) => T | Promise<T>): Promise<T> {
    // Copy now, before queuing, so mutation of a caller's object cannot rebind it.
    const pinned = Object.freeze({ root: expected.root, scopeId: expected.scopeId, scopeRevision: expected.scopeRevision });
    return this.run(async () => {
      const current = this.currentScope(pinned.root);
      if (current.root !== pinned.root || current.scopeId !== pinned.scopeId || current.scopeRevision !== pinned.scopeRevision) {
        throw scopeRefusal('changed', 'changed', pinned.root);
      }
      let live = true;
      const assertCurrent = (): void => {
        if (!live) throw scopeRefusal('callback', 'changed', pinned.root, 'the step ran after its registration check had ended');
      };
      try {
        return await callback(assertCurrent);
      } finally { live = false; }
    });
  }

  async snapshot(): Promise<WorkspaceRegistrySnapshot> {
    const state = await this.read();
    return { workspaces: state.workspaces, declines: state.declines };
  }

  /**
   * Register a root, refusing an empty or absurdly broad one. Idempotent on
   * the normalized root, but provenance UPGRADES: re-adding an existing root
   * with `origin`/`checkpointEligible` stamps those fields (this is how the
   * checkpoint-owning consumer marks its roots on boot, including records
   * migrated before provenance existed). Absent options never strip an
   * existing stamp, one surface's plain self-recording cannot demote another
   * consumer's eligibility.
   */
  async add(
    root: string,
    opts?: { readonly label?: string; readonly origin?: string; readonly checkpointEligible?: boolean },
  ): Promise<RegisterWorkspaceResult> {
    // The root guard runs OUTSIDE the lock: it rejects on the argument alone,
    // and a refusal should not queue behind another process's write.
    const target = this.requireRegistrableRoot(root);
    return this.run(async () => {
      const state = await this.readForMutation();
      const existing = state.workspaces.find((w) => w.root === target);
      const mintScope = (generation: number): Pick<RegisteredWorkspaceRecord, 'nativeScope'> => {
        const canonicalRoot = canonicalDirectory(target);
        return canonicalRoot === null || broadRootReason(canonicalRoot, this.homeDir, this.daemonStateDir) ? {} : {
          nativeScope: { id: `workspace:${randomUUID()}`, canonicalRoot, generation },
        };
      };
      if (existing) {
        const origin = opts?.origin?.trim();
        const wantsUpgrade =
          (origin !== undefined && origin !== '' && existing.origin !== origin)
          || (opts?.checkpointEligible === true && existing.checkpointEligible !== true);
        // A root registered before native work existed gets its native scope
        // from this explicit registration; re-registering is how it is granted.
        const next = advance(state);
        const granted: Pick<RegisteredWorkspaceRecord, 'nativeScope'> = existing.nativeScope === undefined ? mintScope(next.scopeGeneration!) : {};
        const nativeScopeGranted = granted.nativeScope !== undefined;
        if (!wantsUpgrade && !nativeScopeGranted) return { record: existing, alreadyRegistered: true };
        const upgraded: RegisteredWorkspaceRecord = {
          ...existing,
          ...(origin ? { origin } : {}),
          ...(opts?.checkpointEligible === true ? { checkpointEligible: true } : {}),
          ...granted,
        };
        await this.persist({
          ...next,
          workspaces: state.workspaces.map((w) => (w.root === target ? upgraded : w)),
          declines: state.declines,
        });
        return { record: upgraded, alreadyRegistered: true, ...(nativeScopeGranted ? { nativeScopeGranted: true } : {}) };
      }

      const next = advance(state);
      const record: RegisteredWorkspaceRecord = {
        root: target,
        registeredAt: new Date().toISOString(),
        ...(opts?.label?.trim() ? { label: opts.label.trim() } : {}),
        ...(opts?.origin?.trim() ? { origin: opts.origin.trim() } : {}),
        ...(opts?.checkpointEligible === true ? { checkpointEligible: true } : {}),
        ...mintScope(next.scopeGeneration!),
      };
      // Registering a root clears any remembered decline at exactly that root.
      const declines = state.declines.filter((d) => d.root !== target);
      await this.persist({ ...next, workspaces: [...state.workspaces, record], declines });
      return { record, alreadyRegistered: false };
    });
  }

  /** Remove a registered root. Returns whether anything was removed (honest boolean, never a phantom). */
  async remove(root: string): Promise<{ readonly root: string; readonly removed: boolean }> {
    const target = normalizeWorkspaceRoot(root);
    return this.run(async () => {
      const state = await this.readForMutation();
      const workspaces = state.workspaces.filter((w) => w.root !== target);
      const removed = workspaces.length !== state.workspaces.length;
      // The generation moves, so a root registered again later gets a new scope.
      if (removed) await this.persist({ ...advance(state), workspaces });
      return { root: target, removed };
    });
  }

  /** Remember a subtree-scoped decline at a root. Idempotent. Used by prompt consumers, not a wire verb. */
  async decline(root: string): Promise<{ readonly root: string; readonly alreadyDeclined: boolean }> {
    const target = normalizeWorkspaceRoot(root);
    return this.run(async () => {
      const state = await this.readForMutation();
      if (state.declines.some((d) => d.root === target)) return { root: target, alreadyDeclined: true };
      const record: DeclinedWorkspaceRecord = { root: target, declinedAt: new Date().toISOString() };
      await this.persist({ ...advance(state), declines: [...state.declines, record] });
      return { root: target, alreadyDeclined: false };
    });
  }

  /**
   * Resolve a path against the registry. When `git` is omitted, the store probes
   * the worktree→main-repo link itself so a linked sibling worktree inherits its
   * main repo's registration.
   */
  async resolve(path: string, git?: WorkspaceGitMetadata): Promise<WorkspaceResolution> {
    const state = await this.read();
    const gitMeta = git ?? await this.probe(path);
    const input: ResolveWorkspaceInput = {
      path,
      git: gitMeta,
      registrations: state.workspaces,
      declines: state.declines,
    };
    return resolveWorkspaceRegistration(input);
  }

  private requireRegistrableRoot(root: string): string {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new WorkspaceRegistrationError('root is required');
    }
    const target = normalizeWorkspaceRoot(root);
    const broad = broadRootReason(target, this.homeDir, this.daemonStateDir);
    if (broad) {
      throw new WorkspaceRegistrationError(
        `refusing to register "${target}" because it is ${broad}: coverage flows down a root's whole subtree, ` +
          `so registering a root this broad would sweep far more than a project. Register a specific project root.`,
      );
    }
    return target;
  }
}
