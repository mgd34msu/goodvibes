import { existsSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreJson } from '@/utils/store-file.ts';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import {
  openWorkspaceRegistrationStore,
  normalizeLegacyRegisterRows,
  type WorkspaceRegistrationStore,
  withWorkspaceRegistrationWriteLockSync,
  readWorkspaceRegisterSync,
  readCheckpointEligibilitySync,
  createCheckpointEligibilityChecker,
  broadRootReason,
  type CheckpointEligibility,
  type RegisterWorkspaceResult,
  type WorkspaceRegisterRead,
  resolveWorkspaceRegistration,
  normalizeWorkspaceRoot,
  probeWorktreeLink,
  type RegisteredWorkspaceRecord,
  type DeclinedWorkspaceRecord,
  type WorkspaceGitMetadata,
  type WorkspaceResolution,
} from '@goodvibes-jev/engine/platform/platform/workspace';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.ts';
import {
  legacyWorkspaceRegisterPath,
  resolveWorkspaceRegisterReadPath,
  sharedWorkspaceRegisterPath,
} from '@goodvibes-jev/engine/platform/platform/workspace';

export { normalizeWorkspaceRoot } from '@goodvibes-jev/engine/platform/platform/workspace';
export type {
  DeclinedWorkspaceRecord,
  RegisteredWorkspaceRecord,
  WorkspaceCoverageStatus,
  WorkspaceResolution,
} from '@goodvibes-jev/engine/platform/platform/workspace';

/**
 * CHECKPOINT-ELIGIBILITY BOUNDARY (owner ruling: the checkpoint boundary stays
 * EXPLICIT, never silently widened).
 *
 * The shared registration store is ONE file the whole platform reads and writes
 * (~/.goodvibes/control-plane/workspace-registrations.json). The TUI's first-open
 * self-recording writes a plain {@link RegisteredWorkspaceRecord} to it for any
 * directory a user merely opens, so "registered in the store" can no longer mean
 * "the owner opted this workspace into automatic checkpoints". The agent's
 * checkpoint boundary must therefore consume ONLY records the owner EXPLICITLY
 * registered for checkpoints, marked by `checkpointEligible === true`.
 *
 * The platform record schema natively carries both fields (typed on
 * {@link RegisteredWorkspaceRecord}): `origin`, which flow wrote/stamped the
 * record, provenance only, and `checkpointEligible`, where ABSENT MEANS FALSE.
 * The store's `add` stamps/upgrades them typed, and absent options never strip
 * an existing stamp, so one surface's plain self-recording cannot demote
 * another consumer's eligibility.
 */
export const AGENT_EXPLICIT_REGISTRATION_ORIGIN = 'agent-explicit-registration';

/**
 * Shared registered-workspace registry (platform 1.6.1 platform/workspace/registration),
 * the successor to this fork's local per-user JSON registry
 * (superseded ../config/workspace-registry.ts, deleted).
 *
 * MIGRATION. The local registry's record shape (`{ root, registeredAt, label? }`)
 * is field-identical to the shared store's `RegisteredWorkspaceRecord`, so a local
 * file migrates in as a straight import, see migrateLegacyWorkspaceRegistryIfNeeded.
 *
 * WHY A SYNCHRONOUS RESOLVER EXISTS ALONGSIDE THE ASYNC STORE. The platform's
 * WorkspaceRegistrationStore is Promise-based (it persists through
 * PersistentStore). createRuntimeServices() (../runtime/services.ts) is
 * synchronous by design, every consumer (the CLI, the TUI bootstrap, every
 * test file) calls it synchronously, and the automatic-checkpoint decision
 * (whether to pass runtimeBus to WorkspaceCheckpointManager) must be made AT
 * construction time, not after an async read resolves later. So this module
 * also ships a synchronous snapshot read + the platform's PURE resolver
 * (resolveWorkspaceRegistration, no disk/git I/O) for that one call site;
 * every other consumer (the workspaces CLI, a future interactive prompt) goes
 * through the real async store below, the single source of truth for writes.
 * Both read the exact same on-disk file, so there is only ever one registry.
 */

export type StoreShellPaths = Pick<ShellPathService, 'resolveUserPath' | 'homeDirectory'>;

/**
 * Path of the shared store's JSON document, the SAME file the platform's
 * registerGatewayVerbGroups writes and the daemon reads for checkpoint
 * eligibility.
 *
 * It lives in the platform's shared tier (~/.goodvibes/shared/), which takes no
 * surface root, precisely because three products share it: scoping it per
 * surface would give this agent its own register, and workspaces registered
 * here would vanish from the daemon while the daemon's vanished from here.
 *
 * This is a READ resolver, so it falls back to the pre-split location
 * (~/.goodvibes/control-plane/) while that is still where the state is, the
 * daemon's boot fold moves it, and until then an updated agent must not report
 * the operator's registered workspaces as gone. Writes always go to the shared
 * path; see createWorkspaceRegistrationStore below.
 */
export function sharedWorkspaceRegistrationStorePath(shellPaths: StoreShellPaths): string {
  return resolveWorkspaceRegisterReadPath(shellPaths, existsSync);
}

/** This process's store over the shared file, for callers that can go async (CLI commands, interactive prompts). */
export function createWorkspaceRegistrationStore(shellPaths: StoreShellPaths): WorkspaceRegistrationStore {
  return openWorkspaceRegistrationStore({
    // WRITES go to the shared tier, always; reads fall back to the pre-split
    // location until the daemon's boot fold has moved it.
    path: sharedWorkspaceRegisterPath(shellPaths),
    fallbackReadPath: legacyWorkspaceRegisterPath(shellPaths),
    homeDir: shellPaths.homeDirectory,
    daemonStateDir: shellPaths.resolveUserPath(),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Synchronous read of the shared store's coverage rows, through the store's
 * own parser (v1 rows normalized, or native v2). This is not a native authority
 * reader; only WorkspaceRegistrationStore.currentScope can establish that. A
 * missing or unreadable file reads as empty here; the checkpoint gate reads the
 * unreadable case itself (resolveCheckpointEligibility) so it can say so.
 */
export function readSharedWorkspaceRegistrationSnapshotSync(shellPaths: StoreShellPaths): {
  readonly workspaces: readonly RegisteredWorkspaceRecord[];
  readonly declines: readonly DeclinedWorkspaceRecord[];
} {
  const read = readWorkspaceRegisterSync(sharedWorkspaceRegistrationStorePath(shellPaths));
  return read.state === 'ok' ? { workspaces: read.workspaces, declines: read.declines } : { workspaces: [], declines: [] };
}

/**
 * Resolve `path` against the shared registration store SYNCHRONOUSLY: a direct
 * on-disk read plus the platform's pure resolveWorkspaceRegistration. `git` defaults
 * to a real worktree-link probe (probeWorktreeLink spawns `git`), so a linked
 * orchestration worktree of a registered repo resolves as covered without any
 * extra wiring, the worktree-link inheritance the shared store provides.
 * Callers that already have git metadata (or want to avoid the spawn, e.g. in
 * a pure unit test) can pass it explicitly.
 */
export function resolveWorkspaceRegistrationSync(
  shellPaths: StoreShellPaths,
  path: string,
  git?: WorkspaceGitMetadata,
): WorkspaceResolution {
  const snapshot = readSharedWorkspaceRegistrationSnapshotSync(shellPaths);
  const gitMeta = git ?? probeWorktreeLink(path);
  return resolveWorkspaceRegistration({
    path,
    git: gitMeta,
    registrations: snapshot.workspaces,
    declines: snapshot.declines,
  });
}

/**
 * Resolve `path` against ONLY the checkpoint-eligible registrations, the
 * boundary the automatic/explicit checkpoint gate consumes. Identical to
 * {@link resolveWorkspaceRegistrationSync} except the registrations are filtered
 * to `checkpointEligible === true` first, so a plain TUI self-record (registered
 * in the shared store, but never explicitly opted into checkpoints) resolves as
 * NOT covered here even though the general resolver reports it registered.
 * Worktree-link inheritance still applies: a linked worktree of a checkpoint-
 * eligible main repo resolves covered.
 */
export function resolveCheckpointEligibilitySync(
  shellPaths: StoreShellPaths,
  path: string,
  git?: WorkspaceGitMetadata,
): WorkspaceResolution {
  const eligibility = resolveCheckpointEligibility(shellPaths, path, git);
  return eligibility.state === 'readable' ? eligibility.resolution : {
    path, status: 'unknown', coveredBy: null, declinedRoot: null, viaWorktreeLink: false,
    reason: `the workspace register cannot be read: ${eligibility.reason}`,
  };
}

/** Checkpoint eligibility of `path`, or the reason the register cannot be read (the platform's shared reader). */
export function resolveCheckpointEligibility(shellPaths: StoreShellPaths, path: string, git?: WorkspaceGitMetadata): CheckpointEligibility {
  return readCheckpointEligibilitySync(sharedWorkspaceRegistrationStorePath(shellPaths), path, git);
}

/**
 * Build a cheap, repeatable live checkpoint-eligibility checker for one fixed
 * workspace root. `probeWorktreeLink` (a `git` subprocess spawn) runs ONCE here,
 * since a long-running process's working directory and its git-worktree
 * relationship do not change mid-launch; every subsequent call only re-reads the
 * shared registration JSON file (a small synchronous fs read), cheap enough to
 * call on every turn/agent-lifecycle event, unlike calling
 * `resolveCheckpointEligibilitySync` directly (which re-probes git every time).
 *
 * This is what makes registering a workspace mid-launch (an explicit
 * `goodvibes-agent workspaces register` that stamps `checkpointEligible`) take
 * effect on the very next automatic-checkpoint-eligible event in an
 * already-running process, without a restart: a caller that re-runs the returned
 * function on each event always reads current on-disk state. It consumes ONLY
 * checkpoint-eligible records, so a directory a TUI user merely opened never
 * silently becomes checkpoint-eligible to the agent.
 */
export function createWorkspaceRegistrationLiveChecker(
  shellPaths: StoreShellPaths,
  path: string,
): () => CheckpointEligibility {
  return createCheckpointEligibilityChecker(() => sharedWorkspaceRegistrationStorePath(shellPaths), path);
}

// ---------------------------------------------------------------------------
// One-time migration: local per-user registry -> shared store
// ---------------------------------------------------------------------------

function legacyWorkspaceRegistryPath(shellPaths: StoreShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'checkpoints', 'registered-workspaces.json');
}

function migrationReceiptPath(shellPaths: StoreShellPaths): string {
  // This repo's own receipt, not shared state, it rides the agent's surface
  // root like everything else this product owns.
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'workspace-registration-migration-receipt.json');
}

/**
 * The schema version stamped onto both one-time receipts below, and the
 * completion flag that makes them verifiable.
 *
 * A receipt is the ONLY memory that a one-time migration already ran. Gating on
 * `existsSync` alone accepts a zero-byte or half-written file as proof of
 * completion, which is why these are now parsed instead. See
 * {@link readReceipt} for what each caller does when the parse fails, the two
 * receipts answer that differently, on purpose.
 */
const RECEIPT_SCHEMA_VERSION = 1;

/** A receipt as it is written: the caller's result plus the fields that make it checkable. */
type StampedReceipt<T> = T & { readonly schemaVersion: number; readonly completed: true };

function stampReceipt<T extends object>(result: T): StampedReceipt<T> {
  return { ...result, schemaVersion: RECEIPT_SCHEMA_VERSION, completed: true } as StampedReceipt<T>;
}

/** How a one-time receipt file read. */
type ReceiptState =
  /** No receipt on disk: the migration has not run. */
  | { readonly kind: 'absent' }
  /** A parseable receipt that asserts its own completion. */
  | { readonly kind: 'complete' }
  /** A file is there, but it does not say the migration finished (empty, torn, wrong shape, older schema). */
  | { readonly kind: 'damaged'; readonly reason: string };

/**
 * Read a one-time receipt by PARSING it, never by its mere existence.
 *
 * A file that exists may be zero bytes, truncated, or a page of nothing that a
 * filesystem recovered the inode for but not the data. `existsSync` returns
 * true for every one of those, and the migration it guards is then skipped
 * forever. A receipt must positively assert completion: an object carrying a
 * known schema version and `completed: true`.
 *
 * A receipt written before this check existed carries neither field, so it
 * reads as `damaged` rather than `complete`. That is deliberate and the callers
 * handle it, one re-runs (its work is idempotent), the other does not (its
 * work is not), and both say so out loud.
 */
function readReceipt(path: string): ReceiptState {
  let raw: string;
  try {
    if (!existsSync(path)) return { kind: 'absent' };
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return { kind: 'damaged', reason: `unreadable: ${summarizeError(error)}` };
  }
  if (raw.trim().length === 0) return { kind: 'damaged', reason: 'empty file (interrupted write)' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'damaged', reason: 'not parseable JSON (torn write)' };
  }
  if (!isRecord(parsed)) return { kind: 'damaged', reason: 'not a JSON object' };
  if (parsed.completed !== true) return { kind: 'damaged', reason: 'no completion flag (written before receipts were verifiable)' };
  if (typeof parsed.schemaVersion !== 'number' || !Number.isFinite(parsed.schemaVersion)) {
    return { kind: 'damaged', reason: 'no usable schema version' };
  }
  // A NEWER schema is accepted: a later build already did at least this much,
  // and a downgrade must not re-run a one-time migration on every boot.
  if (parsed.schemaVersion < RECEIPT_SCHEMA_VERSION) {
    return { kind: 'damaged', reason: `older receipt schema (${parsed.schemaVersion} < ${RECEIPT_SCHEMA_VERSION})` };
  }
  return { kind: 'complete' };
}

/**
 * The agent's EXPLICIT checkpoint-registration path: one typed store `add` that
 * registers `root` (the platform's own root-guarded write) AND stamps it
 * `checkpointEligible: true` with the agent-explicit origin, the store's `add`
 * carries both fields natively, upgrading an already-present record's stamp in
 * the same call. This is the ONLY way a record becomes checkpoint-eligible at
 * write time, a plain platform `add` (the TUI's first-open self-recording) never
 * sets the flag, so opening a directory in the TUI cannot widen the agent's
 * checkpoint boundary. Returns the platform's register result unchanged so callers
 * keep their existing messaging.
 */
export async function registerWorkspaceForCheckpoints(
  shellPaths: StoreShellPaths,
  root: string,
  opts?: { readonly label?: string },
): Promise<RegisterWorkspaceResult> {
  const store = createWorkspaceRegistrationStore(shellPaths);
  return await store.add(root, {
    ...(opts?.label ? { label: opts.label } : {}),
    origin: AGENT_EXPLICIT_REGISTRATION_ORIGIN,
    checkpointEligible: true,
  });
}

function checkpointEligibilityBackfillReceiptPath(shellPaths: StoreShellPaths): string {
  // Also this repo's own receipt; surface-scoped for the same reason.
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'workspace-checkpoint-eligibility-backfill-receipt.json');
}

export interface CheckpointEligibilityBackfillResult {
  readonly sourcePath: string;
  readonly recordsStamped: number;
  readonly backfilledAt: string;
  /** Set when the pass ended without stamping because the shared register is native (v2). */
  readonly skipped?: string;
}

/** Why a legacy pass can never act on a native (v2) register, recorded in its receipt. */
const NATIVE_REGISTER_SKIP = 'the shared register already carries native workspace scopes; legacy boot passes never rewrite it';

/**
 * One-time boot backfill that stamps `checkpointEligible: true` on the shared-
 * store records that came from the agent's OWN explicit registrations, so the
 * eligibility boundary does not retroactively drop workspaces the owner had
 * already opted into checkpoints before this flag existed. It writes the v1
 * document directly (every field of every record preserved) because it runs
 * inside the synchronous createRuntimeServices path where the async typed store
 * cannot be awaited. It takes the store's writer lock and never rewrites a
 * native v2 register.
 *
 * The honest source of "which records were the agent's explicit list" is the
 * legacy per-user registry file (`<surface>/checkpoints/registered-workspaces.json`),
 * written only by `workspaces register` in older builds and never deleted by the
 * migration that imported it. Every root in it is an explicit owner opt-in.
 *
 * Cost on an ordinary start: one receipt read, then one `existsSync` of the
 * legacy file; no lock and no register read unless that file exists. A v2
 * register writes the receipt, since nothing is left this pass could ever do.
 * A damaged receipt re-runs the pass: it only ever sets the flag on the owner's
 * own legacy roots, so repeating it changes nothing.
 */
export function backfillCheckpointEligibilityIfNeeded(
  shellPaths: StoreShellPaths,
): CheckpointEligibilityBackfillResult | null {
  const receiptPath = checkpointEligibilityBackfillReceiptPath(shellPaths);
  const receipt = readReceipt(receiptPath);
  if (receipt.kind === 'complete') return null;
  const legacyPath = legacyWorkspaceRegistryPath(shellPaths);
  if (!existsSync(legacyPath)) return null;
  if (receipt.kind === 'damaged') {
    logger.warn('Checkpoint-eligibility backfill receipt is not usable, re-running the (idempotent) backfill', {
      receiptPath,
      reason: receipt.reason,
    });
  }
  return legacyWorkspaceWrite(shellPaths, (register) => {
    if (register.version === 2) {
      const skipped: CheckpointEligibilityBackfillResult = {
        sourcePath: legacyPath,
        recordsStamped: 0,
        backfilledAt: new Date().toISOString(),
        skipped: NATIVE_REGISTER_SKIP,
      };
      writeStoreJson(receiptPath, stampReceipt(skipped));
      return null;
    }

    const legacyRoots = new Set<string>();
    for (const record of readLegacyRegistryRows(legacyPath)) {
      const root = readString(record.root);
      if (root) legacyRoots.add(normalizeWorkspaceRoot(root));
    }

    let stamped = 0;
    const workspaces = register.workspaces.map((entry) => {
      const root = normalizeWorkspaceRoot(readString(entry.root));
      if (!legacyRoots.has(root) || entry.checkpointEligible === true) return entry;
      stamped += 1;
      const existingOrigin = readString(entry.origin);
      return { ...entry, checkpointEligible: true, origin: existingOrigin || AGENT_EXPLICIT_REGISTRATION_ORIGIN };
    });
    if (stamped > 0) {
      writeStoreJson(sharedWorkspaceRegisterPath(shellPaths), { version: 1, workspaces, declines: register.declines });
    }

    const result: CheckpointEligibilityBackfillResult = {
      sourcePath: legacyPath,
      recordsStamped: stamped,
      backfilledAt: new Date().toISOString(),
    };
    writeStoreJson(receiptPath, stampReceipt(result));
    return result;
  });
}

export interface WorkspaceRegistrationMigrationResult {
  readonly sourcePath: string;
  readonly recordsMigrated: number;
  readonly recordsAlreadyPresent: number;
  readonly migratedAt: string;
  /** Set when the pass ended without importing because the shared register is native (v2). */
  readonly skipped?: string;
}

/**
 * Migrate the local per-user registry into the shared store, exactly once.
 *
 * Runs synchronously (see this module's doc comment on why). Receipt-gated:
 * once written, later calls return null without touching either file again,
 * even if the legacy file is still present and even if the owner later
 * unregisters a migrated root (it must not come back on the next start).
 *
 * Cost on an ordinary start: one receipt read, then one `existsSync` of the
 * legacy file; the writer lock and the register read happen only when there is
 * a legacy file to import. A v2 register writes the receipt and imports
 * nothing: legacy rows are never folded into native scope state. An
 * unparsable legacy file migrates zero records and still writes a receipt.
 *
 * Returns null when nothing was migrated this call; a caller logs only a real
 * migration.
 *
 * A DAMAGED RECEIPT DOES NOT RE-RUN THIS, unlike the backfill above. The legacy
 * file is never deleted, so a second pass would re-add every legacy root,
 * including ones the owner has since unregistered. A damaged receipt is
 * therefore treated as "already migrated", and said at warn level with its
 * path, so an operator can delete it to force the migration deliberately.
 */
export function migrateLegacyWorkspaceRegistryIfNeeded(
  shellPaths: StoreShellPaths,
): WorkspaceRegistrationMigrationResult | null {
  const receiptPath = migrationReceiptPath(shellPaths);
  const receipt = readReceipt(receiptPath);
  if (receipt.kind === 'complete') return null;
  const legacyPath = legacyWorkspaceRegistryPath(shellPaths);
  if (!existsSync(legacyPath)) return null;
  if (receipt.kind === 'damaged') {
    logger.warn(
      'Workspace-registry migration receipt is not usable, treating the migration as already done, because repeating it '
      + 'would re-add legacy roots the owner may have since unregistered. Delete the receipt to force it.',
      { receiptPath, reason: receipt.reason },
    );
    return null;
  }
  return legacyWorkspaceWrite(shellPaths, (register) => {
    // Another process may have finished the migration while this one waited
    // for the lock; importing again could re-add a root unregistered since.
    if (readReceipt(receiptPath).kind !== 'absent') return null;
    if (register.version === 2) {
      const skipped: WorkspaceRegistrationMigrationResult = {
        sourcePath: legacyPath,
        recordsMigrated: 0,
        recordsAlreadyPresent: 0,
        migratedAt: new Date().toISOString(),
        skipped: NATIVE_REGISTER_SKIP,
      };
      writeStoreJson(receiptPath, stampReceipt(skipped));
      return null;
    }

    // Legacy rows pass the store's one definition of a valid row on the way in.
    const legacyRecords = normalizeLegacyRegisterRows(readLegacyRegistryRows(legacyPath), []).workspaces;
    const existingRoots = new Set(register.workspaces.map((entry) => entry.root));
    // Existing rows are carried through as the store read them.
    const merged: RegisteredWorkspaceRecord[] = [...register.workspaces];
    let migrated = 0;
    let alreadyPresent = 0;
    for (const record of legacyRecords) {
      if (existingRoots.has(record.root)) {
        alreadyPresent += 1;
        continue;
      }
      existingRoots.add(record.root);
      merged.push(record);
      migrated += 1;
    }

    if (migrated > 0) {
      writeStoreJson(sharedWorkspaceRegisterPath(shellPaths), { version: 1, workspaces: merged, declines: register.declines });
    }

    const result: WorkspaceRegistrationMigrationResult = {
      sourcePath: legacyPath,
      recordsMigrated: migrated,
      recordsAlreadyPresent: alreadyPresent,
      migratedAt: new Date().toISOString(),
    };
    writeStoreJson(receiptPath, stampReceipt(result));
    return result;
  });
}

/** The `workspaces` rows of the legacy per-user registry; an unparsable file has none. */
function readLegacyRegistryRows(legacyPath: string): readonly Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as unknown;
    const list = isRecord(parsed) && Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    return list.filter(isRecord);
  } catch {
    return [];
  }
}

type SharedRegister = Extract<WorkspaceRegisterRead, { state: 'ok' }>;

/**
 * Run a legacy boot write under the store's writer lock, against the register
 * as the store itself reads it. An unreadable register is never overwritten:
 * its native history may be unknowable. A busy lock skips this start; the pass
 * runs again at the next one.
 */
function legacyWorkspaceWrite<T>(shellPaths: StoreShellPaths, write: (register: SharedRegister) => T): T | null {
  const path = sharedWorkspaceRegisterPath(shellPaths);
  try {
    return withWorkspaceRegistrationWriteLockSync(path, () => {
      const read = readWorkspaceRegisterSync(existsSync(path) ? path : sharedWorkspaceRegistrationStorePath(shellPaths));
      if (read.state === 'unreadable') {
        logger.warn('Legacy workspace migration left the shared registry unchanged because it cannot be read', { path, reason: read.reason });
        return null;
      }
      return write(read.state === 'ok' ? read : { state: 'ok', version: 1, workspaces: [], declines: [] });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'WORKSPACE_REGISTRY_BUSY') throw error;
    logger.debug('Legacy workspace migration waits for the next start: the shared registry is being written by another process', { path });
    return null;
  }
}

// ---------------------------------------------------------------------------
// First-start registration prompt support
// ---------------------------------------------------------------------------

/**
 * Would the shared store refuse to register `root` as too broad? The store's
 * own rule, asked before OFFERING registration in the first-start prompt; the
 * store's add() remains the guard at write time.
 */
export function isBroadWorkspaceRoot(shellPaths: StoreShellPaths, root: string): boolean {
  return broadRootReason(root, shellPaths.homeDirectory, shellPaths.resolveUserPath()) !== null;
}

/**
 * Resolve a first-start registration prompt's answer against the shared
 * store. A keypress handler has no async context and ignores the returned
 * promise, but a write error is never a silent failure: it is logged, not
 * lost. The promise settles once the answer is persisted (it never rejects).
 */
export function answerWorkspaceRegistrationPrompt(shellPaths: StoreShellPaths, root: string, accepted: boolean): Promise<void> {
  // Accepting the first-start prompt is an EXPLICIT owner opt-in, so it goes
  // through registerWorkspaceForCheckpoints (registers AND stamps eligibility),
  // not a plain store.add, which would register without making the workspace
  // checkpoint-eligible. Declining stays a plain decline.
  const outcome = accepted
    ? registerWorkspaceForCheckpoints(shellPaths, root)
    : createWorkspaceRegistrationStore(shellPaths).decline(root);
  return outcome.then(() => undefined, (error: unknown) => {
    logger.error('Failed to persist workspace registration prompt answer', { root, accepted, error: summarizeError(error) });
  });
}
