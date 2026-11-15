/**
 * turn-anchors.ts, the session-scoped join key between the conversation
 * and the workspace-checkpoint store, for message-anchored rewind.
 *
 * The unified rewind service next door (service.ts) anchors a rewind to a
 * `{ sessionId, turnId }`. Files-scope resolves that turnId against the
 * workspace checkpoints the turn engine already stamps with the same turnId.
 * Conversation-scope, however, needs to know WHERE in the conversation that
 * turn ended, a mapping the platform's checkpoint store does not carry. This
 * registry supplies it: at every TURN_COMPLETED a host records the turnId with
 * the live `conversation.getMessageCount()` and a key of the turn's last
 * message ({@link captureTurnAnchor}). A position alone is not an identity:
 * compaction rewrites the history and renumbers it, so a rewind resolves the
 * boundary by the key ({@link resolveTurnBoundary}) and says the turn was
 * compacted away when its last message is gone, instead of cutting at
 * whatever message now sits at the old position.
 *
 * Two layers, and a host chooses how far up it goes:
 *
 *   1. The registry, in-memory, keyed by sessionId, populated for the current
 *      process run. `recordTurnAnchor` / `getTurnAnchors` / `resolveTurnAnchor`
 *      / `clearTurnAnchors` are the whole of it, and they need nothing from
 *      disk. A host that stops here gets exactly the anchors this run recorded
 *      and never an invented boundary: an unrecorded turnId resolves to null.
 *   2. Cross-resume persistence, `persistTurnAnchors` mirrors the registry to
 *      a small per-session sidecar beside the session's JSONL
 *      (`<sessionsDir>/<sessionId>.anchors.json`) and `restoreTurnAnchors`
 *      reloads it, so message-anchored rewind behaves identically before and
 *      after a resume. Both take the `SessionSurface` that owns the sessions
 *      directory, so the sidecar and its session can never land in different
 *      places. The boundaries stay valid across a resume because a resume
 *      rehydrates the same message history the anchors were recorded against.
 *      The sidecar also keeps the anchors a conversation rewind dropped, by the
 *      rewind's undo snapshot id, so undoing that rewind after a restart gives
 *      them back.
 *
 * Layer 2 is opt-in per call, not per module: a host that never calls
 * `persistTurnAnchors` performs no I/O here at all.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionSurface } from '../runtime/session-surface.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';


/** One recorded turn boundary, the rewind coordinator's per-turn anchor. */
export interface TurnAnchor {
  /** The turn engine's turn id, shared with the workspace checkpoint's `turnId`. */
  readonly turnId: string;
  /** A short human label (the truncated user prompt) for the recent-turns picker. */
  readonly label: string;
  /** `conversation.getMessageCount()` captured at this turn's completion, where the boundary was then. */
  readonly messageCount: number;
  /**
   * {@link turnBoundaryKey} of the turn's last message, the boundary's
   * identity. Absent on anchors recorded without it; those resolve by position
   * and are refused only when the conversation is now shorter than they are.
   */
  readonly boundary?: string | undefined;
  /** Wall-clock ms at capture, for ordering + age display. */
  readonly at: number;
}

/** Hard cap so a very long session cannot grow this registry without bound. */
const MAX_ANCHORS_PER_SESSION = 500;

/**
 * Sessions whose anchors are held at once. A long-lived daemon hosts many
 * sessions and nothing tells this registry when one ends, so the session
 * recorded to least recently is let go past this bound; its anchors reload from
 * the sidecar on resume.
 */
const MAX_TRACKED_SESSIONS = 256;

const registry = new Map<string, TurnAnchor[]>();

/** The anchors one conversation rewind dropped, kept so undoing that rewind gives them back. */
interface DiscardedAnchors {
  readonly undoSnapshotId: string;
  readonly turnId: string;
  readonly anchors: readonly TurnAnchor[];
}

/** How many rewinds per session keep their dropped anchors for an undo. */
const MAX_DISCARDED_PER_SESSION = 16;

/** Dropped anchors by session, oldest first; mirrored into the session's sidecar. */
const discardedBySession = new Map<string, DiscardedAnchors[]>();

/** The parts of a conversation message its boundary key is made from. */
export interface BoundaryMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly callId?: string | undefined;
  readonly toolCalls?: readonly { readonly id?: string | undefined }[] | undefined;
}

/**
 * A short key for one message: its role, the ids that tie it to tool calls,
 * and a 32-bit FNV-1a hash of its content. Cost: one pass over that message's
 * text, nothing else.
 */
export function turnBoundaryKey(message: BoundaryMessage): string {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null) ?? '';
  const ids = message.callId ?? (message.toolCalls?.map((call) => call.id ?? '').join(',') ?? '');
  const text = `${message.role}|${ids}|${content}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${message.role}:${text.length.toString(36)}:${hash.toString(36)}`;
}

/** The conversation facts an anchor is captured from at TURN_COMPLETED. */
export interface TurnAnchorSource {
  getMessageCount(): number;
  getLastUserMessage(): string | null | undefined;
  /** The message at `index`, read in place (no copy of the history). */
  getMessageAt(index: number): BoundaryMessage | undefined;
}

/** Build a completed turn's anchor, boundary key included, from the live conversation. */
export function captureTurnAnchor(turnId: string, conversation: TurnAnchorSource, at: number = Date.now()): TurnAnchor {
  const messageCount = conversation.getMessageCount();
  const last = messageCount > 0 ? conversation.getMessageAt(messageCount - 1) : undefined;
  return {
    turnId,
    label: summarizeTurnLabel(conversation.getLastUserMessage()),
    messageCount,
    ...(last ? { boundary: turnBoundaryKey(last) } : {}),
    at,
  };
}

/** Where a conversation rewind to an anchor cuts, or why it cannot. */
export type TurnBoundaryResolution =
  | { readonly keep: number; readonly reason?: undefined }
  | { readonly keep?: undefined; readonly reason: string };

const COMPACTED_AWAY = 'that turn was compacted away (its last message is no longer in the conversation), so there is no point to cut the conversation at. Rewind the files only, or pick a later turn';
const SHORTER_NOW = 'the conversation is shorter now than when that turn ended (it was compacted or cut back since), so that turn\'s end cannot be found. Rewind the files only, or pick a later turn';

/**
 * Resolve an anchor to the number of messages to keep in a conversation of
 * `total` messages. The recorded position is used when the message there still
 * has the anchor's key; otherwise the message with that key nearest the
 * recorded position; when none has it, the turn is gone and the reason says
 * so. `readMessages` (the conversation as it is now) is called only for an
 * anchor with a key; an anchor without one, or a conversation whose messages
 * cannot be read, is trusted by position only while the conversation is at
 * least that long.
 */
export function resolveTurnBoundary(
  anchor: TurnAnchor,
  total: number,
  readMessages: () => readonly BoundaryMessage[] | null,
): TurnBoundaryResolution {
  const messages = anchor.boundary === undefined || anchor.messageCount === 0 ? null : readMessages();
  if (messages === null) {
    return anchor.messageCount > total ? { reason: SHORTER_NOW } : { keep: anchor.messageCount };
  }
  const count = messages.length;
  const at = anchor.messageCount - 1;
  const here = messages[at];
  if (here && turnBoundaryKey(here) === anchor.boundary) return { keep: anchor.messageCount };
  let best = -1;
  for (let i = 0; i < count; i++) {
    const message = messages[i];
    if (message && turnBoundaryKey(message) === anchor.boundary && (best < 0 || Math.abs(i - at) < Math.abs(best - at))) best = i;
  }
  return best >= 0 ? { keep: best + 1 } : { reason: COMPACTED_AWAY };
}

/** Trim a user prompt to a single compact line for the picker. */
export function summarizeTurnLabel(text: string | null | undefined, max = 72): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return '(no prompt text)';
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Record a completed turn's anchor. Idempotent per turnId: a repeated turnId
 * updates the existing entry in place (the checkpoint engine can re-snapshot a
 * turn) rather than duplicating it.
 *
 * In one linear history no turn ends with fewer messages than the turn
 * before it. A new turn that ends below an earlier anchor's count means the
 * history was cut back (a rewind, an undo, a compaction) since that
 * anchor was recorded, so those earlier anchors are dropped from the list the
 * turn picker shows. Whether a kept anchor still names a boundary is decided
 * at rewind time by its key ({@link resolveTurnBoundary}).
 */
export function recordTurnAnchor(sessionId: string, anchor: TurnAnchor): void {
  if (!sessionId || !anchor.turnId) return;
  const list = (registry.get(sessionId) ?? []).filter(
    (a) => a.turnId === anchor.turnId || a.messageCount <= anchor.messageCount,
  );
  const existingIndex = list.findIndex((a) => a.turnId === anchor.turnId);
  if (existingIndex >= 0) {
    list[existingIndex] = anchor;
  } else {
    list.push(anchor);
    if (list.length > MAX_ANCHORS_PER_SESSION) list.splice(0, list.length - MAX_ANCHORS_PER_SESSION);
  }
  // Re-inserting moves the session to the newest position, so the oldest entry
  // is the session recorded to least recently.
  registry.delete(sessionId);
  registry.set(sessionId, list);
  while (registry.size > MAX_TRACKED_SESSIONS) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
    discardedBySession.delete(oldest);
  }
}

/** All recorded anchors for a session, oldest first (chronological). */
export function getTurnAnchors(sessionId: string): readonly TurnAnchor[] {
  return registry.get(sessionId) ?? [];
}

/** Resolve an anchor by exact turnId, or null when this run never recorded it. */
export function resolveTurnAnchor(sessionId: string, turnId: string): TurnAnchor | null {
  return registry.get(sessionId)?.find((a) => a.turnId === turnId) ?? null;
}

/**
 * Drop the anchors recorded after `turnId`, the turns a conversation rewind to
 * that turn removed, and return them (an undo of the rewind can give them
 * back with {@link restoreDiscardedTurnAnchors}). Nothing changes when
 * `turnId` was never recorded. With a `surface` the sidecar is rewritten at
 * once, so a resume before the next turn completes does not bring the dropped
 * anchors back.
 */
export function discardTurnAnchorsAfter(
  sessionId: string,
  turnId: string,
  surface?: SessionSurface,
  undoSnapshotId?: string,
): readonly TurnAnchor[] {
  const list = registry.get(sessionId);
  const index = list?.findIndex((a) => a.turnId === turnId) ?? -1;
  if (!list || index < 0) return [];
  const discarded = list.splice(index + 1);
  if (undoSnapshotId && discarded.length > 0) rememberDiscarded(sessionId, { undoSnapshotId, turnId, anchors: discarded });
  if (surface && discarded.length > 0) persistTurnAnchors(sessionId, surface);
  return discarded;
}

function rememberDiscarded(sessionId: string, entry: DiscardedAnchors): void {
  const kept = (discardedBySession.get(sessionId) ?? []).filter((d) => d.undoSnapshotId !== entry.undoSnapshotId);
  kept.push(entry);
  if (kept.length > MAX_DISCARDED_PER_SESSION) kept.splice(0, kept.length - MAX_DISCARDED_PER_SESSION);
  discardedBySession.set(sessionId, kept);
}

function findDiscarded(undoSnapshotId: string): { sessionId: string; entry: DiscardedAnchors } | null {
  for (const [sessionId, list] of discardedBySession) {
    const entry = list.find((d) => d.undoSnapshotId === undoSnapshotId);
    if (entry) return { sessionId, entry };
  }
  return null;
}

/**
 * The conversation rewind with this undo snapshot was undone: the anchors it
 * dropped come back, in memory and in the sidecar. Works after a restart once
 * the session's sidecar was restored. Returns false when nothing is known for
 * that snapshot.
 */
export function restoreAnchorsDroppedBy(undoSnapshotId: string, surface?: SessionSurface): boolean {
  const found = findDiscarded(undoSnapshotId);
  if (!found) return false;
  restoreDiscardedTurnAnchors(found.sessionId, found.entry.anchors, surface);
  return true;
}

/** The undone rewind with this undo snapshot was applied again (redo): its anchors go again. */
export function dropAnchorsAgainFor(undoSnapshotId: string, surface?: SessionSurface): boolean {
  const found = findDiscarded(undoSnapshotId);
  if (!found) return false;
  discardTurnAnchorsAfter(found.sessionId, found.entry.turnId, surface);
  return true;
}

/**
 * Put back anchors {@link discardTurnAnchorsAfter} returned, when the
 * conversation rewind that dropped them was undone. Anchors already recorded
 * for those turns are left as they are.
 */
export function restoreDiscardedTurnAnchors(sessionId: string, anchors: readonly TurnAnchor[], surface?: SessionSurface): void {
  for (const anchor of anchors) {
    if (resolveTurnAnchor(sessionId, anchor.turnId) === null) recordTurnAnchor(sessionId, anchor);
  }
  if (surface && anchors.length > 0) persistTurnAnchors(sessionId, surface);
}

/** Drop a session's anchors. Exposed for tests and session reset. */
export function clearTurnAnchors(sessionId: string): void {
  registry.delete(sessionId);
  discardedBySession.delete(sessionId);
}

// --- Cross-resume persistence -------------------------------------------------
//
// The registry is mirrored to a sidecar next to the session file.
// The directory comes off the caller's SessionSurface (`surface.sessionsDir`),
// the same handle the session JSONL itself is written through, so the sidecar
// and its session can never end up in different directories.
const ANCHOR_SIDECAR_VERSION = 1;

/** Absolute path to a session's anchor sidecar, or null when inputs are unusable. */
const ANCHOR_SIDECAR_SUFFIX = '.anchors.json';

function anchorSidecarPath(sessionId: string, surface: SessionSurface): string | null {
  if (!sessionId || !surface.sessionsDir) return null;
  // A sessionId is a filename component; refuse anything with path separators so
  // a malformed id can never escape the sessions directory.
  if (/[\\/]/.test(sessionId)) return null;
  return join(surface.sessionsDir, `${sessionId}${ANCHOR_SIDECAR_SUFFIX}`);
}

function isTurnAnchor(value: unknown): value is TurnAnchor {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.turnId === 'string' && a.turnId.length > 0 &&
    typeof a.label === 'string' &&
    typeof a.messageCount === 'number' && Number.isFinite(a.messageCount) &&
    typeof a.at === 'number' && Number.isFinite(a.at) &&
    (a.boundary === undefined || typeof a.boundary === 'string')
  );
}

function isDiscardedAnchors(value: unknown): value is DiscardedAnchors {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.undoSnapshotId === 'string' && d.undoSnapshotId.length > 0
    && typeof d.turnId === 'string' && Array.isArray(d.anchors) && d.anchors.every(isTurnAnchor);
}

/**
 * Write the current in-memory anchors for a session to its sidecar so they
 * survive a resume. Best-effort and atomic (temp file + rename): a failed or
 * torn write must never break the turn that triggered it. Called after each
 * `recordTurnAnchor` at TURN_COMPLETED. Returns false when the write failed
 * (the cause is logged), so a caller can say the rewind point was not saved.
 */
export function persistTurnAnchors(sessionId: string, surface: SessionSurface): boolean {
  const path = anchorSidecarPath(sessionId, surface);
  if (!path) return true;
  const list = registry.get(sessionId) ?? [];
  const discarded = discardedBySession.get(sessionId) ?? [];
  if (list.length === 0 && discarded.length === 0) return true; // nothing to mirror yet
  try {
    mkdirSync(surface.sessionsDir, { recursive: true });
    const payload = JSON.stringify({ version: ANCHOR_SIDECAR_VERSION, sessionId, anchors: list, ...(discarded.length > 0 ? { discarded } : {}) });
    const tmp = `${path}${ANCHOR_SIDECAR_TMP_MARKER}${process.pid}`;
    writeFileSync(tmp, payload);
    renameSync(tmp, path);
    return true;
  } catch (error) {
    // Best-effort: a persist miss must never break the turn.
    logger.warn('rewind turn-anchor sidecar could not be written', { sessionId, error: summarizeError(error) });
    return false;
  }
}

/**
 * Reload a session's persisted anchors into the in-memory registry on resume.
 * Returns the number of anchors restored (0 when no sidecar exists or it is
 * unreadable). Idempotent via `recordTurnAnchor`'s per-turnId dedup, so a resume
 * that later re-records the same turn keeps a single entry.
 */
export function restoreTurnAnchors(sessionId: string, surface: SessionSurface): number {
  const path = anchorSidecarPath(sessionId, surface);
  if (!path || !existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { anchors?: unknown; discarded?: unknown };
    if (!parsed || !Array.isArray(parsed.anchors)) return 0;
    let restored = 0;
    for (const candidate of parsed.anchors) {
      if (isTurnAnchor(candidate)) {
        recordTurnAnchor(sessionId, candidate);
        restored++;
      }
    }
    if (Array.isArray(parsed.discarded)) {
      for (const candidate of parsed.discarded) if (isDiscardedAnchors(candidate)) rememberDiscarded(sessionId, candidate);
    }
    return restored;
  } catch {
    return 0;
  }
}

// ─── Reaping orphaned sidecars ────────────────────────────────────────────────
//
// A sidecar's OWNER is the session JSONL it sits beside. Deleting a session
// removes the JSONL but nothing ever removed the sidecar, so anchors for
// sessions that no longer exist accumulate in the sessions directory forever.
// The sweep below reclaims them, plus the `.tmp-<pid>` staging files a crash
// between write and rename leaves behind.

/** Infix for the atomic-write staging file, before the writing process's pid. */
const ANCHOR_SIDECAR_TMP_MARKER = '.tmp-';

/**
 * How long a staging file is tolerated before it is treated as crash residue:
 * 1 hour. `persistTurnAnchors` renames within microseconds of writing, so
 * anything this old was interrupted, and the completed sidecar (if the write
 * ever finished) is a separate file.
 */
export const ANCHOR_TMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * How settled a sidecar must be before this sweep will delete it: 1 hour.
 *
 * Another instance can be persisting anchors for a session this process knows
 * nothing about, and the window between reading a sidecar's content and
 * unlinking it is not atomic. Requiring the file to have been untouched for an
 * hour means a sidecar that some other instance is actively rewriting is never
 * a candidate, while genuine residue, whose writer is long gone, always is.
 * The sweep repeats, so the delay costs nothing.
 */
export const ANCHOR_SIDECAR_SETTLE_MS = 60 * 60 * 1000;

export interface AnchorSidecarReapResult {
  /** Sidecar and staging files examined this sweep. */
  readonly scanned: number;
  /** Files deleted this sweep. */
  readonly reaped: number;
}

export interface AnchorSidecarReapOptions {
  /** The session this process is using right now; its sidecar is never reaped. */
  readonly currentSessionId?: string | null;
  readonly now?: () => number;
  /** Override the staging-file age window (tests). */
  readonly tmpMaxAgeMs?: number;
  /** Override how long a sidecar must be untouched before it can be reaped (tests). */
  readonly settleMs?: number;
}

/**
 * Delete anchor sidecars whose owning session file is gone, sidecars that hold
 * nothing readable, and abandoned staging files.
 *
 * A sidecar survives when `<sessionsDir>/<sessionId>.jsonl` still exists AND
 * the sidecar itself parses into at least one usable anchor, content, not
 * mere existence, because a sidecar truncated by a crash restores nothing and
 * would otherwise sit there indefinitely looking like valid state. It also
 * survives while it is still fresh (see `ANCHOR_SIDECAR_SETTLE_MS`), which
 * keeps a sidecar another instance is mid-rewrite out of reach.
 *
 * The current session's sidecar is never touched, and an unreadable or absent
 * sessions directory simply reclaims nothing. Idempotent and concurrency-safe:
 * a file another sweeper unlinked first (ENOENT) counts as reaped.
 */
export function reapOrphanedAnchorSidecars(
  surface: SessionSurface,
  options: AnchorSidecarReapOptions = {},
): AnchorSidecarReapResult {
  const dir = surface.sessionsDir;
  if (!dir) return { scanned: 0, reaped: 0 };

  let names: string[];
  try {
    names = readdirSync(dir).filter(
      (n) => n.endsWith(ANCHOR_SIDECAR_SUFFIX) || n.includes(`${ANCHOR_SIDECAR_SUFFIX}${ANCHOR_SIDECAR_TMP_MARKER}`),
    );
  } catch {
    return { scanned: 0, reaped: 0 };
  }

  const now = options.now?.() ?? Date.now();
  const tmpMaxAgeMs = options.tmpMaxAgeMs ?? ANCHOR_TMP_MAX_AGE_MS;
  const settleMs = options.settleMs ?? ANCHOR_SIDECAR_SETTLE_MS;
  let reaped = 0;

  for (const name of names) {
    const path = join(dir, name);

    if (!name.endsWith(ANCHOR_SIDECAR_SUFFIX)) {
      // A `<sessionId>.anchors.json.tmp-<pid>` staging file. Age alone decides:
      // a young one may belong to another instance's in-flight write.
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs > tmpMaxAgeMs && unlinkAnchorFile(path)) reaped++;
      continue;
    }

    const sessionId = name.slice(0, name.length - ANCHOR_SIDECAR_SUFFIX.length);
    if (sessionId.length === 0) continue;
    if (options.currentSessionId && sessionId === options.currentSessionId) continue;

    // A sidecar written moments ago belongs to a writer that is still around,
    // possibly another instance whose session this process cannot see.
    let sidecarMtimeMs: number;
    try {
      sidecarMtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (now - sidecarMtimeMs <= settleMs) continue;

    if (!existsSync(join(dir, `${sessionId}.jsonl`))) {
      // The owning session is gone, this sidecar can never be used again.
      if (unlinkAnchorFile(path)) reaped++;
      continue;
    }
    if (!sidecarHoldsAnchors(path)) {
      // The session survives but the sidecar is empty or torn: it restores
      // nothing, so keeping it only hides the loss.
      if (unlinkAnchorFile(path)) reaped++;
    }
  }

  return { scanned: names.length, reaped };
}

/** Content check: does this sidecar parse into at least one usable anchor? */
function sidecarHoldsAnchors(path: string): boolean {
  try {
    const text = readFileSync(path, 'utf8');
    if (text.trim().length === 0) return false;
    const parsed = JSON.parse(text) as { anchors?: unknown };
    return Array.isArray(parsed?.anchors) && parsed.anchors.some(isTurnAnchor);
  } catch {
    return false;
  }
}

function unlinkAnchorFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  }
}
