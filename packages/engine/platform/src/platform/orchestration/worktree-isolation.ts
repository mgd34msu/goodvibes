/** platform-owned platform module. This implementation is maintained in goodvibes-platform. */

/**
 * WorktreeIsolationManager, the engine-side driver for `worktree` isolation
 * mode (see WorkstreamIsolation, types.ts, and IsolatedWorktree, worktree.ts).
 *
 * Owns three things the engine calls into at well-defined lifecycle points:
 *
 *   ensureWorktree()     , at an item's FIRST claim (engine.ts runItemPhase),
 *                           create its dedicated worktree if it doesn't have
 *                           one yet. Idempotent across an item's phases (a
 *                           worktree persists for the item's whole run).
 *   enqueueIntegration() , when a passed item's pipeline terminates, queue its
 *                           branch onto the SINGLE sequential integration lane
 *                           (completion order, not claim order). A conflict
 *                           keeps the worktree + branch and lets the lane
 *                           continue with the next item, never auto-resolved,
 *                           never silently dropped.
 *   cleanupTerminated()  , when an item fails or is killed, remove its
 *                           worktree ONLY if the tree is clean; a dirty tree
 *                           is KEPT (data safety) and counted against the
 *                           kept-worktree cap (oldest-first eviction).
 *   reconcileOrphans()   , at import (a resumed/crashed workstream), put any
 *                           passed item whose branch had not integrated back
 *                           on the integration lane, then find any
 *                           on-disk worktree associated with its actual records, not already
 *                           recorded on one of the imported items and either
 *                           ADOPT it (the item still has unresolved work) or
 *                           REPORT it (leave in place for the operator, NEVER
 *                           deleted on sight).
 *
 * Location + naming: each exact construction-owned namespace/workstream/item
 * tuple gets one private persisted opaque `ws-owned/<id>` branch before Git
 * allocation. The registry lives in the real shared Git common directory, so
 * linked contract worktrees agree. Reservation grants no ownership: only an
 * original native creation receipt records acquired/initialized state.
 * Existing recorded names remain authoritative. Unrecorded old name-only
 * resources are reported and preserved, never adopted from a checksum label.
 *
 * SYNCHRONOUS orphan scan (deliberate, mirrors dirty-guard.ts's
 * snapshotDirtyTree precedent): `reconcileOrphans` must resolve BEFORE the
 * engine's first tick() can claim any item, or a claim could race the async
 * git listing and create a second worktree at the same deterministic path an
 * orphan already occupies (`git worktree add` on an existing path throws).
 * importWorkstream (engine.ts) is itself a synchronous function, so
 * reconciliation is done with Bun.spawnSync, paid once per import, exactly
 * like the launch-dirty snapshot.
 */
import { isAbsolute, join, relative, sep } from 'node:path';
import { captureExistingDirectory } from '../utils/atomic-json-store.js';
import { WorktreeIdentityRegistry, type StoredWorktreeIdentity, type WorktreeIdentityKey } from './worktree-identities.js';
import type { NativeDataWriteOwner } from '../runtime/native-reader-compatibility.js';
import { GitService } from '../git/service.js';
import { IsolatedWorktree, readIsolatedWorktreeCreation, type CommitWorkingTreeResult } from '../agents/worktree.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { OwnedWork } from '../utils/owned-work.js';
import type { OrchestrationEvent, WorkItem, Workstream } from './types.js';

export interface WorktreeIsolationManagerDeps {
  readonly nativeDataWriter?: NativeDataWriteOwner | undefined;
  /** Shared with the engine so nested eviction and resumed integration are owned. */
  readonly ownedWork?: OwnedWork | undefined;
  readonly projectRoot: string;
  /** Construction-owned engine identity; isolates repository-wide Git refs across contracts. */
  readonly stateNamespace?: string | undefined;
  readonly emit: (event: OrchestrationEvent) => void;
  readonly now?: (() => number) | undefined;
  /** Bounds how many KEPT (conflict/dirty) worktrees are retained before oldest-first eviction. Default 20. */
  readonly keptWorktreeCap?: number | undefined;
  /**
   * Cold-start setup hook run once, right after a worktree is first created, so
   * an isolated agent starts with dependencies installed and carried-over
   * untracked files present instead of broken-by-default. The wiring is
   * responsible for capturing/recording the honest outcome (e.g. onto the
   * worktree registry record); a thrown/rejected setup NEVER fails worktree
   * creation, a broken setup is surfaced as a visible state, not a lost
   * worktree. Absent → today's behavior (no provisioning).
   */
  /** Optional exact-tree initializer; contract input must bypass checkout filters and hooks. */
  readonly initializeWorktree?: ((worktree: IsolatedWorktree) => Promise<void>) | undefined;
  readonly runSetup?: ((worktreePath: string) => Promise<void> | void) | undefined;
}

export interface ItemWorktreeHandle {
  readonly path: string;
  commit(message: string, paths?: string[]): Promise<CommitWorkingTreeResult>;
}

export interface WorktreeIsolationManager {
  join(): Promise<void>;
  /** Ensure this item has a dedicated worktree (idempotent, created once, at first claim). Only meaningful when workstream.isolation === 'worktree'. */
  ensureWorktree(workstream: Workstream, item: WorkItem): Promise<ItemWorktreeHandle>;
  /**
   * Enqueue a just-passed item's branch onto the sequential integration lane.
   * Resolves once THIS item's attempt (merged/conflict/empty) and any
   * resulting cleanup has settled. Callers that don't need to wait may let
   * the returned promise run fire-and-forget (errors are caught internally,
   * this never rejects).
   */
  enqueueIntegration(workstream: Workstream, item: WorkItem): Promise<void>;
  /** Fail/kill cleanup rule: remove the item's worktree if clean, else KEEP it (data safety). No-op if the item never got a worktree. Never throws. */
  cleanupTerminated(workstream: Workstream, item: WorkItem): Promise<void>;
  /**
   * Import reconciliation, see the module doc: passed items whose branch had
   * not integrated re-enter the lane, then the synchronous orphan scan. Call
   * once, right after registering an imported workstream, before start()/tick().
   */
  reconcileOrphans(workstream: Workstream): void;
  /**
   * The diff an item's worktree branch introduced over base (best-of-N candidate
   * diff). Returns null when the item has no live worktree instance (e.g. already
   * cleaned, or never claimed). Never throws.
   */
  diffItem(item: WorkItem): Promise<{ files: string[]; unifiedDiff: string; stat: string } | null>;
}

function itemWorktreeDir(projectRoot: string, branch: string): string {
  return join(projectRoot, '.goodvibes', '.worktrees', ...branch.split('/'));
}

interface KeptEntry {
  readonly workstream: Workstream;
  readonly item: WorkItem;
  readonly instance: IsolatedWorktree;
  readonly keptAt: number;
}

export function createWorktreeIsolationManager(deps: WorktreeIsolationManagerDeps): WorktreeIsolationManager {
  const now = deps.now ?? ((): number => Date.now());
  const ownedWork = deps.ownedWork ?? new OwnedWork();
  const keptCap = deps.keptWorktreeCap ?? 20;
  const reportedUnknownResources = new Set<string>();
  const rootGit = new GitService(deps.projectRoot);
  // Entity identity includes its real workstream; equal caller item IDs in
  // different streams must never borrow each other's live resource.
  const instances = new WeakMap<WorkItem, IsolatedWorktree>();
  const resourceGuards = new WeakMap<IsolatedWorktree, () => void>();
  const preparing = new WeakMap<WorkItem, Promise<ItemWorktreeHandle>>();
  let repositoryGuard: (() => void) | undefined;
  let identities: WorktreeIdentityRegistry | undefined, openingIdentities: Promise<WorktreeIdentityRegistry> | undefined;
  const identityKey = (workstream: Workstream, item: WorkItem): WorktreeIdentityKey => ({ namespace: deps.stateNamespace ?? null, workstreamId: workstream.id, itemId: item.id });
  const unavailable = () => new Error('Worktree identity is unavailable; original resources preserved');
  const commonOutput = (output: Uint8Array): string => {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(output); } catch { throw unavailable(); }
    if (!text.endsWith('\n')) throw unavailable();
    const path = text.slice(0, -1); if (!path) throw unavailable(); return path;
  };
  function identityRegistrySync(): WorktreeIdentityRegistry {
    if (identities) { repositoryGuard?.(); return identities; }
    const root = captureExistingDirectory(deps.projectRoot);
    const result = Bun.spawnSync(['git', '-C', deps.projectRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    root.assertCurrent(); if (result.exitCode !== 0) throw unavailable();
    identities = new WorktreeIdentityRegistry(commonOutput(result.stdout), deps.nativeDataWriter);
    repositoryGuard = identities.retainRepository(deps.projectRoot);
    return identities;
  }
  function identityRegistry(): Promise<WorktreeIdentityRegistry> {
    if (identities) { repositoryGuard?.(); return Promise.resolve(identities); }
    if (openingIdentities) return openingIdentities;
    const pending = (async () => {
      const root = captureExistingDirectory(deps.projectRoot);
      const child = Bun.spawn(['git', '-C', deps.projectRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { stdout: 'pipe', stderr: 'pipe' });
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);
      root.assertCurrent(); if (code !== 0) throw unavailable();
      if (!identities) { identities = new WorktreeIdentityRegistry(commonOutput(new Uint8Array(output)), deps.nativeDataWriter); repositoryGuard = identities.retainRepository(deps.projectRoot); }
      repositoryGuard?.(); return identities;
    })();
    openingIdentities = pending;
    void pending.then(() => { if (openingIdentities === pending) openingIdentities = undefined; }, () => { if (openingIdentities === pending) openingIdentities = undefined; });
    return pending;
  }
  const kept: KeptEntry[] = [];
  let baseBranchCache: string | null = null;
  let integrationLane: Promise<void> = Promise.resolve();

  /** Resolved once (Bun.spawnSync, mirroring dirty-guard.ts) since every IsolatedWorktree for this manager's lifetime merges into the SAME root-tree branch. */
  function resolveBaseBranch(): string {
    if (baseBranchCache) return baseBranchCache;
    try {
      const result = Bun.spawnSync(['git', '-C', deps.projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : '';
      baseBranchCache = branch.length > 0 && branch !== 'HEAD' ? branch : 'main';
    } catch (error) {
      logger.warn('worktree-isolation: could not resolve base branch, defaulting to "main"', { error: summarizeError(error) });
      baseBranchCache = 'main';
    }
    return baseBranchCache;
  }

  function getOrCreateInstance(workstream: Workstream, item: WorkItem, path: string, branch: string): IsolatedWorktree {
    let instance = instances.get(item);
    if (instance && (instance.path !== path || instance.branch !== branch)) throw unavailable();
    if (!instance) {
      instance = new class extends IsolatedWorktree {
        override async create(startPoint?: string, checkout = true): Promise<void> {
          if (this.path !== path || this.branch !== branch) throw unavailable();
          let failed = false, failure: unknown;
          try { await super.create(startPoint, checkout, repositoryGuard); } catch (error) { failed = true; failure = error; }
          const proof = readIsolatedWorktreeCreation(this);
          if (!proof) { if (failed) throw failure; throw unavailable(); }
          proof.assertCurrent();
          const registry = identities;
          if (!registry) throw unavailable();
          const binding = registry.retainRecorded(this.path, this.branch);
          const guard = () => { repositoryGuard?.(); proof.assertCurrent(); binding(); };
          guard(); resourceGuards.set(this, guard);
          // Own real acquisition before any registry await or initializer.
          item.worktreePath = this.path;
          item.worktreeBranch = this.branch;
          item.worktreeInitialized = false;
          instances.set(item, this);
          await registry.acquired(identityKey(workstream, item), this, false);
          if (failed) throw failure;
        }
      }(deps.projectRoot, path, branch, resolveBaseBranch());
    }
    return instance;
  }

  async function ensureWorktree(workstream: Workstream, item: WorkItem): Promise<ItemWorktreeHandle> {
    const registry = await identityRegistry(), key = identityKey(workstream, item);
    let row: StoredWorktreeIdentity | undefined = registry.find(key);
    if (!item.worktreePath && !item.worktreeBranch) {
      row = await registry.reserve(key);
      const branchForReservation = row.branch;
      const resources = await rootGit.worktreeList();
      const existing = resources.filter(resource => resource.branch === branchForReservation);
      if (existing.length > 1) throw unavailable();
      if (existing[0]) {
        if (row.state === 'reserved') throw new Error('Unproved worktree reservation requires recovery; resource preserved');
        const guard = registry.retainAcquired(row, existing[0].path);
        item.worktreePath = existing[0].path; item.worktreeBranch = row.branch;
        item.worktreeInitialized = row.state === 'initialized';
        const restored = getOrCreateInstance(workstream, item, item.worktreePath, item.worktreeBranch);
        resourceGuards.set(restored, () => { repositoryGuard?.(); guard(); });
      }
    }
    if (item.worktreeInitialized === false) throw new Error('worktree initialization did not complete; retained resource requires recovery');
    const branch = item.worktreeBranch ?? row?.branch;
    if (!branch) throw unavailable();
    const path = item.worktreePath ?? itemWorktreeDir(deps.projectRoot, branch);
    const instance = getOrCreateInstance(workstream, item, path, branch);
    resourceGuards.get(instance)?.();
    if (!item.worktreePath) {
      try {
        if (deps.initializeWorktree === undefined) await instance.create();
        else await deps.initializeWorktree(instance);
        const proof = readIsolatedWorktreeCreation(instance);
        if (!proof) throw unavailable();
        const recorded = await registry.acquired(key, instance, true);
        const binding = registry.retainAcquired(recorded, instance.path);
        resourceGuards.set(instance, () => { repositoryGuard?.(); proof.assertCurrent(); binding(); });
      } catch (error) {
        // A real native creation can exist even when a post hook/initializer
        // rejects. Only its actual receipt owns recovery or cleanup.
        const proof = readIsolatedWorktreeCreation(instance);
        const guard = resourceGuards.get(instance);
        if (proof && guard) {
          guard();
          item.worktreePath = instance.path; item.worktreeBranch = instance.branch;
          item.worktreeInitialized = false; instances.set(item, instance);
          resourceGuards.get(instance)?.();
        }
        throw error;
      }
      item.worktreePath = instance.path; item.worktreeBranch = instance.branch; item.worktreeInitialized = true;
      instances.set(item, instance);
      deps.emit({ type: 'item-worktree-created', workstreamId: workstream.id, itemId: item.id, path: instance.path, branch: instance.branch });
      if (deps.runSetup) {
        try { await deps.runSetup(instance.path); resourceGuards.get(instance)?.(); }
        catch (error) { logger.warn('worktree-isolation: cold-start setup hook threw (worktree kept; failure recorded by the setup wiring)', { itemId: item.id, path: instance.path, error: summarizeError(error) }); }
      }
    } else {
      if (!resourceGuards.has(instance)) {
        const binding = row && row.branch === branch && row.state !== 'reserved' ? registry.retainAcquired(row, path) : registry.retainRecorded(path, branch);
        resourceGuards.set(instance, () => { repositoryGuard?.(); binding(); });
      }
      resourceGuards.get(instance)?.(); instances.set(item, instance);
    }
    resourceGuards.get(instance)?.();
    return { path: instance.path, commit: async (message, paths) => {
      resourceGuards.get(instance)?.(); return instance.commit(message, paths, resourceGuards.get(instance));
    } };
  }

  function keepWorktree(workstream: Workstream, item: WorkItem, instance: IsolatedWorktree, reason: string): void {
    item.worktreeKept = true;
    deps.emit({ type: 'item-worktree-kept', workstreamId: workstream.id, itemId: item.id, path: instance.path, reason });
    if (!kept.some(entry => entry.instance === instance)) kept.push({ workstream, item, instance, keptAt: now() });
    enforceKeptCap();
  }

  function enforceKeptCap(): void {
    while (kept.length > keptCap) {
      const oldest = kept.shift();
      if (!oldest) break;
      void ownedWork.run(() => removeWorktree(oldest.workstream, oldest.item, oldest.instance, true)).catch((error) => {
        logger.error('worktree-isolation: eviction of oldest kept worktree did not complete', {
          itemId: oldest.item.id, error: summarizeError(error),
        });
      });
    }
  }

  async function removeWorktree(workstream: Workstream, item: WorkItem, instance: IsolatedWorktree, evicted: boolean): Promise<void> {
    const path = instance.path;
    try { repositoryGuard?.(); resourceGuards.get(instance)?.(); }
    catch {
      if (!evicted) keepWorktree(workstream, item, instance, 'original worktree binding is unavailable');
      return;
    }
    let preservedCommit: string | null = null;
    if (evicted) {
      // Cap eviction never destroys work: uncommitted state is committed onto
      // the item branch first, only the directory is removed, and the branch
      // is KEPT (see IsolatedWorktree.evict). If preservation fails, the
      // directory is left in place, an over-cap directory beats lost work,
      // and the tree stays kept/attributed rather than falsely announced gone.
      try {
        preservedCommit = (await instance.evict(resourceGuards.get(instance), repositoryGuard)).preservedCommit;
      } catch (error) {
        logger.error('worktree-isolation: eviction preservation failed; worktree left on disk', {
          itemId: item.id, path, branch: instance.branch, error: summarizeError(error),
        });
        return;
      }
    } else {
      try {
        await instance.remove(resourceGuards.get(instance), repositoryGuard);
      } catch (error) {
        logger.warn('worktree-isolation: worktree removal did not complete', { itemId: item.id, path, error: summarizeError(error) });
        keepWorktree(workstream, item, instance, 'worktree removal did not complete');
        return;
      }
    }
    instances.delete(item);
    item.worktreePath = undefined;
    if (!evicted) item.worktreeInitialized = undefined;
    item.worktreeKept = false;
    deps.emit(
      evicted
        ? {
            type: 'item-worktree-evicted', workstreamId: workstream.id, itemId: item.id, path,
            branch: instance.branch, ...(preservedCommit ? { preservedCommit } : {}),
          }
        : { type: 'item-worktree-removed', workstreamId: workstream.id, itemId: item.id, path },
    );
  }

  async function integrateOne(workstream: Workstream, item: WorkItem): Promise<void> {
    const branch = item.worktreeBranch;
    if (!branch || !item.worktreePath) throw unavailable();
    const path = item.worktreePath;
    const registry = await identityRegistry(), row = registry.find(identityKey(workstream, item));
    const instance = getOrCreateInstance(workstream, item, path, branch);
    if (!resourceGuards.has(instance)) {
      const binding = row && row.branch === branch && row.state !== 'reserved' ? registry.retainAcquired(row, path) : registry.retainRecorded(path, branch);
      resourceGuards.set(instance, () => { repositoryGuard?.(); binding(); });
    }
    item.mergeState = 'pending';
    try {
      if (item.worktreeInitialized === false) throw new Error('worktree initialization did not complete; retained resource requires recovery');
      const outcome = await instance.integrate(() => { repositoryGuard?.(); resourceGuards.get(instance)?.(); });
      if (outcome.status === 'merged') {
        item.mergeState = 'merged';
        item.mergeHash = outcome.hash;
        // A retry that lands clears the prior conflict markers, the tree is
        // reclaimed below and nothing may keep reading as conflicted.
        item.conflictFiles = undefined;
        item.worktreeKept = false;
        deps.emit({ type: 'item-merged', workstreamId: workstream.id, itemId: item.id, branch: instance.branch, hash: outcome.hash });
        await removeWorktree(workstream, item, instance, false);
        return;
      }
      if (outcome.status === 'conflict') {
        item.mergeState = 'conflict';
        // Structured list first (a resolution session seeds from DATA), the
        // prose blockedReason kept for display compatibility.
        item.conflictFiles = [...outcome.files];
        item.blockedReason = `merge-conflict: ${outcome.files.join(', ') || 'unknown files'}`;
        deps.emit({
          type: 'item-merge-conflict', workstreamId: workstream.id, itemId: item.id,
          branch: instance.branch, path: instance.path, files: outcome.files,
        });
        keepWorktree(workstream, item, instance, `merge-conflict: ${outcome.files.join(', ') || 'unknown files'}`);
        return;
      }
      // 'empty', the item branch carries no commits beyond base: an honest
      // no-op, not a failure. Nothing to merge, so trivially "merged" (no
      // hash, there is no merge commit to report) and the worktree is
      // reclaimed like any other successfully-integrated item.
      item.mergeState = 'merged';
      item.conflictFiles = undefined;
      item.worktreeKept = false;
      await removeWorktree(workstream, item, instance, false);
    } catch (error) {
      logger.error('worktree-isolation: integration attempt threw', { itemId: item.id, error: summarizeError(error) });
      item.mergeState = 'conflict';
      item.blockedReason = `merge-conflict: integration did not complete (${summarizeError(error)})`;
      keepWorktree(workstream, item, instance, `integration attempt threw: ${summarizeError(error)}`);
    }
  }

  function enqueueIntegration(workstream: Workstream, item: WorkItem): Promise<void> {
    const run = ownedWork.run(() => integrationLane.then(() => integrateOne(workstream, item)));
    // Chain off a NEVER-REJECTING tail so one item's (already internally
    // caught) failure can't skip the lane forward for the next enqueue,
    // integrateOne never actually throws past its own try/catch, but this is
    // cheap insurance against a future change forgetting that invariant.
    integrationLane = run.catch((error) => {
      logger.error('worktree-isolation: integration lane step did not complete', { itemId: item.id, error: summarizeError(error) });
    });
    return integrationLane;
  }

  async function cleanupTerminated(workstream: Workstream, item: WorkItem): Promise<void> {
    const instance = instances.get(item);
    if (!instance) return; // never got a worktree (failed before claim, or shared mode)
    try {
      resourceGuards.get(instance)?.();
      const clean = await instance.isClean();
      resourceGuards.get(instance)?.();
      if (clean) {
        await removeWorktree(workstream, item, instance, false);
      } else {
        keepWorktree(workstream, item, instance, 'dirty tree after item failed/killed');
      }
    } catch (error) {
      logger.error('worktree-isolation: cleanup-on-terminate check did not complete, keeping worktree for safety', {
        itemId: item.id, error: summarizeError(error),
      });
      keepWorktree(workstream, item, instance, `cleanup check did not complete: ${summarizeError(error)}`);
    }
  }

  function reconcileOrphans(workstream: Workstream): void {
    // A passed item whose branch had not finished integrating when the
    // snapshot was written re-enters the lane: nothing else would merge it,
    // and a dependent released only on merge would wait forever. A best-of-N
    // attempt integrates only once it was picked.
    for (const item of workstream.items) {
      const integrable = item.attemptGroupId === undefined || item.attemptWinner === true;
      if (item.state === 'passed' && integrable && item.mergeState !== 'merged' && item.mergeState !== 'conflict') {
        void enqueueIntegration(workstream, item);
      }
    }
    let raw: string;
    try {
      const result = Bun.spawnSync(['git', '-C', deps.projectRoot, 'worktree', 'list', '--porcelain']);
      if (result.exitCode !== 0) return;
      raw = new TextDecoder().decode(result.stdout);
    } catch (error) {
      logger.warn('worktree-isolation: orphan scan (worktree list) did not complete', { error: summarizeError(error) });
      return;
    }
    const resources = raw.trim().split('\n\n').filter(Boolean).map(block => {
      const lines = block.split('\n');
      const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length) ?? '';
      const branchLine = lines.find(line => line.startsWith('branch '));
      const branch = branchLine ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '') : '';
      return { path, branch };
    }).filter(resource => resource.path && resource.branch);
    let registry: WorktreeIdentityRegistry, rows: readonly StoredWorktreeIdentity[];
    try { registry = identityRegistrySync(); rows = registry.forWorkstream(deps.stateNamespace ?? null, workstream.id); }
    catch (error) { logger.warn('worktree-isolation: private identity store unavailable; resources preserved', { error: summarizeError(error) }); return; }
    const recordedBranchFromPath = (path: string): string | undefined => {
      const part = relative(join(deps.projectRoot, '.goodvibes', '.worktrees'), path);
      if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) return undefined;
      return part.split(sep).join('/');
    };
    for (const { path, branch } of resources) {
      const recorded = workstream.items.filter(item =>
        (item.worktreePath === path && (item.worktreeBranch === branch || item.worktreeBranch === undefined && recordedBranchFromPath(path) === branch))
        || (item.worktreePath === undefined && item.worktreeBranch === branch));
      const mapped = rows.filter(row => row.branch === branch);
      let adopted = false;
      if (recorded.length === 1) {
        const item = recorded[0]!;
        try {
          const row = mapped.find(candidate => candidate.itemId === item.id);
          const guard = row && row.state !== 'reserved' ? registry.retainAcquired(row, path) : registry.retainRecorded(path, branch);
          const instance = new IsolatedWorktree(deps.projectRoot, path, branch, resolveBaseBranch());
          item.worktreePath = path; item.worktreeBranch = branch;
          if (row?.state === 'acquired') item.worktreeInitialized = false;
          if (row?.state === 'initialized') item.worktreeInitialized = true;
          instances.set(item, instance); resourceGuards.set(instance, () => { repositoryGuard?.(); guard(); }); adopted = true;
        } catch { /* Preserve original record, never adopt replacement physical data. */ }
      } else if (recorded.length === 0 && mapped.length === 1) {
        const row = mapped[0]!, candidates = workstream.items.filter(item => item.id === row.itemId);
        const item = candidates.length === 1 ? candidates[0] : undefined;
        const unresolved = item && ((item.state !== 'passed' && item.state !== 'failed') || item.mergeState === 'pending');
        if (item && unresolved && row.state !== 'reserved' && !item.worktreePath && (item.worktreeBranch === undefined || item.worktreeBranch === branch)) {
          try {
            const guard = registry.retainAcquired(row, path), instance = new IsolatedWorktree(deps.projectRoot, path, branch, resolveBaseBranch());
            item.worktreePath = path; item.worktreeBranch = branch; item.worktreeInitialized = row.state === 'initialized';
            instances.set(item, instance); resourceGuards.set(instance, () => { repositoryGuard?.(); guard(); }); adopted = true;
            deps.emit({ type: 'orphan-worktree-reconciled', workstreamId: workstream.id, path, branch, disposition: 'adopted' });
          } catch { /* Native acquisition no longer names this original resource. */ }
        }
      }
      if (adopted) continue;
      if (recorded.length > 0 || mapped.length > 0) {
        // A historical name, reserved UUID, or ambiguous record is a discovery
        // hint only. Preserve/report it; neither proves that we created it.
        deps.emit({ type: 'orphan-worktree-reconciled', workstreamId: workstream.id, path, branch, disposition: 'reported' });
      } else if (branch.startsWith('ws/') || branch.startsWith('ws-ns/')) {
        // An old spelling is only an inventory hint. Without an original item
        // record or native acquisition it cannot identify a workstream owner.
        // Report the unassigned resource once; do not hash private namespaces
        // merely to filter this read-only inventory, adopt it or delete it.
        const key = JSON.stringify([path, branch]);
        if (!reportedUnknownResources.has(key)) {
          reportedUnknownResources.add(key);
          deps.emit({ type: 'unattributed-worktree-discovered', path, branch });
        }
      }
    }
  }

  async function diffItem(item: WorkItem): Promise<{ files: string[]; unifiedDiff: string; stat: string } | null> {
    const instance = instances.get(item);
    if (!instance) return null;
    try { resourceGuards.get(instance)?.(); return await instance.diff(); }
    catch (error) { logger.warn('worktree-isolation: original diff binding unavailable', { itemId: item.id, error: summarizeError(error) }); return null; }
  }

  return {
    ensureWorktree: (workstream, item) => {
      const pending = preparing.get(item); if (pending) return pending;
      const work = ownedWork.run(() => ensureWorktree(workstream, item)); preparing.set(item, work);
      void work.then(() => { if (preparing.get(item) === work) preparing.delete(item); }, () => { if (preparing.get(item) === work) preparing.delete(item); });
      return work;
    },
    enqueueIntegration,
    cleanupTerminated: (workstream, item) => ownedWork.run(() => cleanupTerminated(workstream, item)),
    reconcileOrphans,
    diffItem: (item) => ownedWork.run(() => diffItem(item)),
    join: () => ownedWork.join(),
  };
}
