/**
 * fold-legacy-register.ts, move the workspace register from the pre-split
 * location into the shared tier, once, without losing a row.
 *
 * ── The merge, and its tie-break ──────────────────────────────────────────
 *
 * Both halves of the document are keyed lists, so the merge is an id-keyed
 * union: `workspaces` keyed on `root` (already normalized, coverage flows down
 * that subtree, so the normalized path IS the identity), `declines` likewise.
 *
 * THE TIE-BREAK IS THE LATER `registeredAt`, and where they tie the destination
 * copy wins. Two reasons it is that and not something cleverer:
 *
 *  - `registeredAt` is the only ordering the record carries. Preferring the
 *    legacy copy wholesale would resurrect a stale label or origin; preferring
 *    the shared copy wholesale would drop a registration made after an updated
 *    product had already written the shared file.
 *  - Field-wise merging is specifically WRONG for `checkpointEligible`. Its
 *    own contract is "absent means false … one surface's self-recording must
 *    never silently widen another consumer's checkpoint scope" (see
 *    registration/types.ts), so OR-ing eligibility across two copies would
 *    widen the automatic-checkpoint boundary behind the operator's back. Whole
 *    records win or lose together.
 *
 * Idempotent: a second fold over the same pair produces the same document, so
 * re-running it on every boot is free.
 */

import { PersistentStore } from '../../state/persistent-store.js';
import { acquireCrossProcessLock } from '../checkpoint/cross-process-lock.js';
import type { DeclinedWorkspaceRecord, RegisteredWorkspaceRecord } from './types.js';

interface PersistedRegistry extends Record<string, unknown> {
  version: number;
  workspaces: RegisteredWorkspaceRecord[];
  declines: DeclinedWorkspaceRecord[];
}

export interface FoldLegacyRegisterResult {
  /** Rows in the destination that were not there before this fold. */
  readonly added: number;
  /** Rows the legacy copy replaced because its `registeredAt` was later. */
  readonly updated: number;
  /** Total rows in the destination afterwards. */
  readonly total: number;
}

function readRows(snapshot: PersistedRegistry | null): PersistedRegistry {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.workspaces)) {
    return { version: 1, workspaces: [], declines: [] };
  }
  return {
    version: 1,
    workspaces: snapshot.workspaces,
    declines: Array.isArray(snapshot.declines) ? snapshot.declines : [],
  };
}

/**
 * Union keyed on `root`, later timestamp wins, a tie keeps the destination.
 *
 * The timestamp field differs between the two halves of the document,
 * `registeredAt` on a registration, `declinedAt` on a decline, so the caller
 * names it rather than this guessing. ISO-8601 strings compare correctly with
 * `>`; a missing timestamp sorts as oldest, which is the right default for a
 * record written before the field existed.
 */
function mergeKeyed<T extends { readonly root: string }>(
  destination: readonly T[],
  legacy: readonly T[],
  timestampOf: (row: T) => string,
): { rows: T[]; added: number; updated: number } {
  const byRoot = new Map<string, T>();
  for (const row of destination) byRoot.set(row.root, row);
  let added = 0;
  let updated = 0;
  for (const row of legacy) {
    const current = byRoot.get(row.root);
    if (!current) {
      byRoot.set(row.root, row);
      added += 1;
      continue;
    }
    if (timestampOf(row) > timestampOf(current)) {
      byRoot.set(row.root, row);
      updated += 1;
    }
  }
  return { rows: [...byRoot.values()], added, updated };
}

/**
 * Legacy roots with no trace in a migrated (version 2) register as a registration or a decline. A root that
 * was removed since (a tombstone) is not accounted for: the legacy copy might be a later re-registration,
 * so it is left for the operator rather than retired.
 */
function unaccountedRoots(legacy: PersistedRegistry, destination: PersistedRegistry): string[] {
  const known = new Set<string>();
  const collect = (rows: unknown): void => {
    if (Array.isArray(rows)) for (const row of rows) if (row && typeof (row as { root?: unknown }).root === 'string') known.add((row as { root: string }).root);
  };
  collect(destination.workspaces); collect(destination.declines);
  return [...legacy.workspaces, ...legacy.declines].map((row) => row.root).filter((root) => !known.has(root));
}

/**
 * Fold `legacyPath` into `sharedPath`. Both may be absent; an absent legacy
 * file is a no-op, and an absent destination is created from the legacy rows.
 * The legacy file is NOT removed here, retiring it is the sweep's job, and it
 * only does so after this has succeeded.
 */
export async function foldLegacyWorkspaceRegister(input: {
  readonly legacyPath: string;
  readonly sharedPath: string;
}): Promise<FoldLegacyRegisterResult> {
  const legacyStore = new PersistentStore<PersistedRegistry>(input.legacyPath);
  const sharedStore = new PersistentStore<PersistedRegistry>(input.sharedPath);
  const release = sharedStore.lockPath
    ? await acquireCrossProcessLock(sharedStore.lockPath, { strictOwnership: true }) : () => {};
  try {
    const rawLegacy = await legacyStore.load();
    if (rawLegacy !== null && rawLegacy.version !== 1) {
      throw new Error('Legacy workspace fold refuses a migrated native scope source.');
    }
    const legacy = readRows(rawLegacy);
    const rawDestination = await sharedStore.load();
    // A legacy union has no authority history. Never erase native incarnations,
    // overwrite tombstones, or silently stamp the imported rows as new grants.
    if (rawDestination !== null && rawDestination.version !== 1) {
      // Once any registration wrote the migrated register, the daemon's copy of
      // the rows is already in it. Retiring the legacy file is safe exactly
      // when every legacy root is accounted for there; a root that is not is
      // refused by name so it is never silently dropped.
      const missing = unaccountedRoots(legacy, rawDestination);
      if (missing.length > 0) {
        throw new Error(`Legacy workspace fold refuses a migrated native scope registry that lacks ${missing.length} legacy root(s): ${missing.join(', ')}. Register them with \`goodvibes register\`, then the legacy file is retired on the next start.`);
      }
      const rows = (rawDestination.workspaces?.length ?? 0) + (rawDestination.declines?.length ?? 0);
      return { added: 0, updated: 0, total: rows };
    }
    const destination = readRows(rawDestination);

    const workspaces = mergeKeyed(destination.workspaces, legacy.workspaces, (row) => row.registeredAt ?? '');
    const declines = mergeKeyed(destination.declines, legacy.declines, (row) => row.declinedAt ?? '');

    await sharedStore.persist({
      version: 1,
      workspaces: workspaces.rows,
      declines: declines.rows,
    });

    return {
      added: workspaces.added + declines.added,
      updated: workspaces.updated + declines.updated,
      total: workspaces.rows.length + declines.rows.length,
    };
  } finally { release(); }
}
