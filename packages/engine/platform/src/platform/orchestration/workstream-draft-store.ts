// ---------------------------------------------------------------------------
// workstream-draft-store.ts, durable journal for not-yet-launched proposals
//
// A workstream proposal (WorkstreamDraft, workstream-draft-types.ts) is facade
// state the OrchestrationEngine has no concept of, its only creation entry
// point materializes a real, ticking workstream with no pre-launch "draft"
// stage. Held in memory alone, a restart between create and launch silently
// loses it. This store journals each draft to disk so the plan-review gate
// survives a restart and is resumable: the same reshaped, approved proposal is
// still there to launch afterward.
//
// This is FACADE persistence, not an engine feature, it sits ALONGSIDE the
// engine's own .goodvibes/orchestration/<id>.json workstream snapshots, under a
// drafts/ subdirectory, and is loaded by the command facade at construction the
// same way the engine's resumeAllFromDisk() reloads live workstreams. A draft
// is a pure-data object (id/task/spec/gate/proposal/provenance/approved), so a
// plain JSON round-trip is lossless.
//
// Every operation is guarded and NEVER throws: a missing directory, an
// unreadable or malformed file, or a write failure degrades to "that draft
// isn't there" rather than crashing session startup, mirroring the engine
// persistence layer's own quarantine-don't-propagate discipline.
//
// RECLAIM: `remove(id)` retires a draft the moment it is launched or cancelled,
// but a draft the user simply walks away from was never reclaimed by anything,
// so the directory grew forever. `loadAll()`, the recovery point, called once
// at command-facade construction, now also bounds the directory by BOTH an age
// TTL (counted since each draft was last saved) and a count cap, and reports
// what it reclaimed through `lastReclaim` / the `onReclaim` hook. Deletions are `rmSync(..., { force: true })`, so a file
// another process removed first is not an error: two concurrent `loadAll()`
// calls converge on the same surviving set.
// ---------------------------------------------------------------------------

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../config/atomic-write.js';
import type { WorkstreamDraft } from './workstream-draft-types.js';

/**
 * Age TTL for an abandoned draft. A proposal that has sat un-launched and
 * un-cancelled this long is not a plan the user is still reviewing; it is
 * litter. Measured since the draft was last saved (created, reshaped or
 * approved): its file's modification time.
 */
export const WORKSTREAM_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Count cap on retained drafts: the most recently saved this many survive,
 * older ones are reclaimed least recently saved first. Bounds the directory
 * even if every draft is recent.
 */
export const WORKSTREAM_DRAFT_CAP = 50;

/**
 * Minimum gap between reaps triggered by `save()`. `loadAll()` is the recovery
 * point but runs once per session, so a session that stays open for days would
 * otherwise never reap again. Every `save()` (draft created, reshaped, or
 * approved) re-checks the bounds, throttled to this interval so the directory
 * is not re-scanned on every keystroke-driven save.
 */
export const WORKSTREAM_DRAFT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** What one reap reclaimed. Counts and draft ids only, never draft text. */
export interface WorkstreamDraftReclaim {
  /** Unix ms of the sweep. */
  readonly at: number;
  /** Valid drafts removed because they were not saved within the TTL. */
  readonly expired: number;
  /** Valid drafts removed because they fell outside the count cap. */
  readonly overCap: number;
  /** Torn/malformed snapshots removed once they were older than the TTL. */
  readonly unreadable: number;
  /** Ids of the valid drafts removed (expired or over the cap), so a holder of drafts in memory drops them too. */
  readonly removedIds: readonly string[];
}

export interface WorkstreamDraftStoreOptions {
  /**
   * Called after a reap (`loadAll()` or a throttled `save()`) that reclaimed at
   * least one file, so the count can be surfaced to the operator and the
   * removed drafts dropped from memory. Receives counts and ids only. Never
   * throws out of the store, a failing hook is swallowed like every other side effect here.
   */
  readonly onReclaim?: (summary: WorkstreamDraftReclaim) => void;
  /** Clock seam (tests). Defaults to Date.now. */
  readonly now?: () => number;
  /** Override the age TTL (tests / embedders). Defaults to WORKSTREAM_DRAFT_TTL_MS. */
  readonly ttlMs?: number;
  /** Override the count cap (tests / embedders). Defaults to WORKSTREAM_DRAFT_CAP. */
  readonly cap?: number;
  /**
   * Throttle for the reap that `save()` triggers. 0 or less means every save
   * reaps (tests); defaults to WORKSTREAM_DRAFT_SWEEP_INTERVAL_MS.
   */
  readonly sweepIntervalMs?: number;
}

export interface WorkstreamDraftStore {
  /**
   * Every valid draft on disk, oldest first, after reaping abandoned ones. A
   * directory that doesn't exist yet ⇒ []. Malformed files are skipped, never
   * fatal, and are only deleted once older than the TTL.
   */
  loadAll(): WorkstreamDraft[];
  /**
   * Write (or overwrite) one draft's snapshot atomically. Never throws, a lost journal write must never
   * break the in-memory flow; it returns false instead, so the caller can say the draft is not journaled
   * (and, after an edit, retire the older file that is still on disk).
   */
  save(draft: WorkstreamDraft): boolean;
  /** Delete one draft's snapshot (on launch or cancel). Missing file ⇒ no-op. Returns false when the file could not be removed. */
  remove(id: string): boolean;
  /** Summary of the most recent `loadAll()` that reclaimed something; null otherwise. */
  readonly lastReclaim: WorkstreamDraftReclaim | null;
}

/** Human-readable, content-free disclosure line for a reclaim summary. */
export function formatWorkstreamDraftReclaim(summary: WorkstreamDraftReclaim): string {
  const parts: string[] = [];
  if (summary.expired > 0) parts.push(`${summary.expired} abandoned`);
  if (summary.overCap > 0) parts.push(`${summary.overCap} over the retention cap`);
  if (summary.unreadable > 0) parts.push(`${summary.unreadable} unreadable`);
  if (parts.length === 0) return 'Workstream drafts: nothing reclaimed.';
  return `Workstream drafts: reclaimed ${parts.join(', ')} draft file(s).`;
}

/** Generated opaque UUID labels and saved historical labels remain plain bounded path segments. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function isDraftShape(value: unknown): value is WorkstreamDraft {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === 'string'
    && typeof d.task === 'string'
    && typeof d.approved === 'boolean'
    && typeof d.createdAt === 'number'
    && typeof d.spec === 'object' && d.spec !== null
    && Array.isArray((d.spec as Record<string, unknown>).items)
  );
}

export function createWorkstreamDraftStore(
  projectRoot: string,
  options: WorkstreamDraftStoreOptions = {},
): WorkstreamDraftStore {
  const dir = join(projectRoot, '.goodvibes', 'orchestration', 'drafts');
  const fileFor = (id: string): string => join(dir, `${id}.json`);
  const clock = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? WORKSTREAM_DRAFT_TTL_MS;
  const cap = options.cap ?? WORKSTREAM_DRAFT_CAP;
  const sweepIntervalMs = options.sweepIntervalMs ?? WORKSTREAM_DRAFT_SWEEP_INTERVAL_MS;
  let lastReclaim: WorkstreamDraftReclaim | null = null;
  /** Unix ms of this instance's last reap; 0 means "never", so the first save sweeps. */
  let lastSweepAt = 0;

  /** Delete one path, treating "already gone" as success (concurrent sweeps). */
  const discard = (path: string): void => {
    try {
      rmSync(path, { force: true });
    } catch {
      // Unremovable (permissions, or a racing process holding it), the next
      // loadAll() will try again; never fatal.
    }
  };

  /** Age of a file by mtime, used only for snapshots whose contents we cannot trust. */
  const modifiedBefore = (path: string, cutoff: number): boolean => {
    try {
      return statSync(path).mtimeMs < cutoff;
    } catch {
      return false;
    }
  };

  /** When a draft's file was last saved (every atomic save refreshes its mtime); `createdAt` when it cannot be read. */
  const savedAt = (path: string, createdAt: number): number => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return createdAt;
    }
  };

  /**
   * Read every snapshot, reject the ones whose CONTENT is not a draft, apply
   * both bounds, and record/announce what was reclaimed. Returns the surviving
   * drafts, least recently saved first. Never throws. `keepId` names a draft
   * that was just written: its file is exempt from both bounds, so saving a
   * draft can never delete the file it just journaled.
   *
   * Idempotent: a second run over the same directory finds nothing left to
   * remove, which is also what makes two processes running it at once safe,
   * they converge on the same surviving set and unlink races count as done.
   */
  const reap = (keepId?: string): WorkstreamDraft[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      lastReclaim = null;
      return []; // directory not created yet, or unreadable, nothing to resume
    }
    const now = clock();
    lastSweepAt = now;
    const cutoff = now - ttlMs;
    const drafts: { readonly draft: WorkstreamDraft; readonly savedAt: number }[] = [];
    let unreadable = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        parsed = undefined;
      }
      // Validation is by CONTENT: a torn or half-written snapshot never
      // becomes a draft. It is only DELETED once it is older than the TTL, so
      // a file another process is writing right now is left alone.
      if (parsed !== undefined && isDraftShape(parsed) && isSafeId(parsed.id)) {
        drafts.push({ draft: parsed, savedAt: savedAt(path, parsed.createdAt) });
        continue;
      }
      if (modifiedBefore(path, cutoff)) {
        discard(path);
        unreadable += 1;
      }
    }
    drafts.sort((a, b) => a.savedAt - b.savedAt);

    // Bound 1, age TTL: a proposal not saved (created, reshaped or approved) for that long is reclaimed.
    const live: typeof drafts = [];
    const removedIds: string[] = [];
    let expired = 0;
    for (const entry of drafts) {
      if (entry.draft.id !== keepId && now - entry.savedAt > ttlMs) {
        discard(fileFor(entry.draft.id));
        removedIds.push(entry.draft.id);
        expired += 1;
        continue;
      }
      live.push(entry);
    }
    // Bound 2, count cap: keep the most recently saved `cap`, reclaim the oldest overflow.
    let overCapCount = 0;
    const kept: WorkstreamDraft[] = [];
    for (const entry of live) {
      if (live.length - overCapCount > cap && entry.draft.id !== keepId) {
        discard(fileFor(entry.draft.id));
        removedIds.push(entry.draft.id);
        overCapCount += 1;
      } else {
        kept.push(entry.draft);
      }
    }

    if (expired + overCapCount + unreadable > 0) {
      lastReclaim = { at: now, expired, overCap: overCapCount, unreadable, removedIds };
      try {
        options.onReclaim?.(lastReclaim);
      } catch {
        // Disclosure must never take startup down.
      }
    } else {
      lastReclaim = null;
    }
    return kept;
  };

  return {
    get lastReclaim(): WorkstreamDraftReclaim | null {
      return lastReclaim;
    },
    loadAll(): WorkstreamDraft[] {
      return reap();
    },
    save(draft: WorkstreamDraft): boolean {
      if (!isSafeId(draft.id)) return false;
      let written = true;
      try {
        mkdirSync(dir, { recursive: true });
        // Atomic (temp + fsync + rename): a crash mid-save can no longer leave a
        // truncated snapshot behind for loadAll() to reject.
        // The in-memory "not journaled" flag describes this very write; it is not part of the draft.
        const { journaled: _inMemoryFlag, ...persisted } = draft;
        atomicWriteFileSync(fileFor(draft.id), JSON.stringify(persisted));
      } catch {
        // A failed journal write leaves the in-memory draft intact and usable;
        // only its restart-durability is lost, which is strictly better than
        // failing the edit the user just made. The caller is told (false).
        written = false;
      }
      // Keep reaping DURING the session, not only at the loadAll() recovery
      // point: loadAll runs once at construction, so a long-lived session would
      // otherwise never bound the directory again. Throttled, and the draft just
      // saved is exempt, even when its write failed and its older file is still there.
      if (clock() - lastSweepAt >= sweepIntervalMs) reap(draft.id);
      return written;
    },
    remove(id: string): boolean {
      if (!isSafeId(id)) return false;
      try {
        rmSync(fileFor(id), { force: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}
