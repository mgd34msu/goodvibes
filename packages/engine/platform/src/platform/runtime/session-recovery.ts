/**
 * Crash-recovery snapshots: write, offer, load, retire.
 *
 * A recovery snapshot (`<scope>/recovery/recovery-<sessionId>.jsonl`) is the
 * copy of a live conversation taken between clean saves. It exists so that a
 * process that dies before its next save does not take the conversation with
 * it. Split out of session-persistence.ts, which keeps the durable-store half (save / load /
 * last-session pointer); both halves resolve every path through the shared
 * scope layer in session-persistence-scope.ts.
 *
 * SUPERSESSION, when is a snapshot still live crash data?
 * A snapshot is offered when it is strictly newer than ITS OWN session's
 * durable store file (`<scope>/sessions/<sessionId>.jsonl`), or when that
 * session has no store file at all. It is NOT judged against the last-session
 * pointer, which advances on every turn-completion persist of ANY session:
 * under that older rule, one message typed in an unrelated session (or in a
 * `--continue`d resume of this one) silently buried a snapshot that still held
 * unsaved messages, with no UI path left to reach it. Judging a snapshot
 * against its own session's store keeps that impossible, an unrelated
 * session's activity cannot bury it, and a clean shutdown of the snapshot's
 * own session both writes the store AND deletes the snapshot, so the surviving
 * snapshot of a session whose store is older is a crash by definition.
 *
 * A terminal writes a snapshot only while it holds something the store does
 * not: when a prompt is accepted, after each tool batch, and after a change made
 * outside a turn. A successful turn-end save deletes it, and so does a clean
 * exit, so on disk a snapshot means "not cleanly closed".
 *
 * LIVENESS, is anything still holding it?
 * A snapshot whose session another running process has open (the session lock,
 * session-open-lock.ts) is that process's working state, not a crash, and
 * neither check here reports it. Every process that writes a snapshot holds
 * its session's lock from the moment the session is live until it closes; the
 * kernel releases it when the process dies, so a crash relaunched at once is
 * offered at once.
 *
 * OFFERED, is the person still deciding about it?
 * A snapshot this process offered is held until it is restored or discarded.
 * When the offered session is the live one (a resume after a crash, an offer
 * left for the next launch), the live writer would otherwise replace it with
 * the live conversation and the turn-end save would delete it. Before either,
 * the held snapshot is moved under a session id of its own, so it is still
 * offered at the next launch and the live session keeps its own snapshot.
 */

import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { publishRecoveryPath, readRecoveryHeaderObservation, RECOVERY_HEADER_LIMIT } from './recovery-path.js';
import { isSessionOpenElsewhere } from './session-open-lock.js';

import { logger } from '../utils/logger.js';
import { loadedReturnContext, type SessionReturnContextSummary } from './session-return-context.js';
import type { ConversationTitleSource } from '../core/conversation.js';
import { summarizeError } from '../utils/error-display.js';
import type { SessionSurface } from './session-surface.js';
import {
  requireSurface,
  resolveRecoveryDirPath,
  resolveRecoveryFilePath,
  resolveSessionStorePath,
  resolveSessionsDirPath,
  RECOVERY_FILE_PREFIX,
  RECOVERY_FILE_SUFFIX,
  type CrashSnapshotTurn,
  type CrashSnapshotTurnMoment,
  type SessionPersistenceOptions,
  type SessionSnapshot,
} from './session-persistence-scope.js';

export type RecoveryFileInfo = {
  title: string;
  timestamp: number;
  sessionId: string;
  returnContext?: SessionReturnContextSummary | undefined;
  /** The turn the snapshot was taken in; absent on a snapshot that did not record it. */
  turn?: CrashSnapshotTurn | undefined;
};

const TURN_MOMENTS: ReadonlySet<string> = new Set<CrashSnapshotTurnMoment>(['TURN_SUBMITTED', 'TOOLS_DONE', 'TURN_COMPLETED', 'TIMER', 'EXIT']);

/** The `turn` a snapshot header recorded, when it is well formed. */
function readSnapshotTurn(value: unknown): CrashSnapshotTurn | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const turn = value as Record<string, unknown>;
  if (typeof turn['moment'] !== 'string' || !TURN_MOMENTS.has(turn['moment'])) return undefined;
  return { moment: turn['moment'] as CrashSnapshotTurnMoment, inFlight: turn['inFlight'] === true, partialReply: turn['partialReply'] === true };
}

/**
 * All per-session recovery files currently on disk under `dir`, newest-first
 * by mtime. Takes an already-resolved recovery directory (`surface.recoveryDir`).
 */
function listRecoveryFiles(dir: string): Array<{ path: string; mtimeNs: bigint }> {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter(
      (name) => name.startsWith(RECOVERY_FILE_PREFIX) && name.endsWith(RECOVERY_FILE_SUFFIX),
    );
  } catch {
    return [];
  }
  const entries: Array<{ path: string; mtimeNs: bigint }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      entries.push({ path, mtimeNs: statSync(path, { bigint: true }).mtimeNs });
    } catch {
      // File vanished between readdir and stat, skip.
    }
  }
  return entries.sort((a, b) => a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1);
}

/**
 * Every recovery snapshot visible to `options`, newest-first by mtime. One
 * list, used by every "which snapshot is THE snapshot" decision (check / load
 * / consume / remove), so the file that is offered is always exactly the file
 * that is retired.
 */
function listRecoveryCandidates(options?: SessionPersistenceOptions): Array<{ path: string; mtimeNs: bigint }> {
  return listRecoveryFiles(resolveRecoveryDirPath(options));
}

/**
 * The ONE snapshot file a recovery operation acts on, or undefined when there
 * is none. With a `sessionId`, that session's file; without one, the newest
 * snapshot, the same file `checkRecoveryFile` offers. Retiring exactly one
 * identified file is the invariant, no operation here ever clears a directory.
 */
function pickRecoverySnapshotPath(
  options: SessionPersistenceOptions | undefined,
  sessionId?: string,
): string | undefined {
  if (!sessionId) return listRecoveryCandidates(options)[0]?.path;
  const canonical = resolveRecoveryFilePath(options, sessionId);
  return existsSync(canonical) ? canonical : undefined;
}

/** Delete one specific snapshot file. A missing file is fine; nothing else is touched. */
function deleteRecoverySnapshotAt(path: string, expected?: string): boolean {
  try {
    const original = expected ?? fileObservationIdentity(path);
    if (fileObservationIdentity(path) !== original) return false;
    unlinkSync(path); return true;
  } catch { return false; }
}

/** Write one snapshot file: its header, then one line per message (one temp file, one rename). Throws. */
function publishRecoverySnapshot(
  sessionId: string,
  title: string,
  timestamp: number,
  snapshot: SessionSnapshot,
  options?: SessionPersistenceOptions,
): void {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: 'meta',
    sessionId,
    title,
    timestamp,
    ...(snapshot.titleSource ? { titleSource: snapshot.titleSource } : {}),
    ...(snapshot.returnContext ? { returnContext: loadedReturnContext(snapshot.returnContext) } : {}),
    ...(snapshot.turn ? { turn: snapshot.turn } : {}),
  }));
  for (const message of snapshot.messages) {
    lines.push(JSON.stringify({ type: 'message', ...message }));
  }
  if (Buffer.byteLength(lines[0]!, 'utf8') > RECOVERY_HEADER_LIMIT) throw new Error('Recovery header exceeds its supported limit');
  const directory = resolveRecoveryDirPath(options);
  const resolve = requireSurface(options).recoveryFile;
  publishRecoveryPath(directory, sessionId, resolve, (path, assertCurrent) => {
    writeFileAtomic(path, `${lines.join('\n')}\n`, { assertCurrent, cleanupStaleTemps: false });
  });
}

/** Offered snapshots not yet restored or discarded, by recovery directory and session id (see OFFERED above). */
const heldOffers = new Set<string>();

function heldOfferKey(options: SessionPersistenceOptions | undefined, sessionId: string): string {
  return `${resolveRecoveryDirPath(options)}\0${sessionId}`;
}

/**
 * Hold a snapshot this process is offering: until it is restored or discarded,
 * writing or deleting that session's snapshot first moves it under a session
 * id of its own. One set insert.
 */
export function holdOfferedRecoverySnapshot(surface: SessionSurface, sessionId: string): void {
  if (!sessionId.trim()) return;
  try { heldOffers.add(heldOfferKey({ surface }, sessionId)); } catch { /* no recovery directory: nothing to protect */ }
}

/** The offered snapshot was restored or discarded: the live writer owns that session's file again. */
export function releaseOfferedRecoverySnapshot(surface: SessionSurface, sessionId: string): void {
  try { heldOffers.delete(heldOfferKey({ surface }, sessionId)); } catch { /* nothing was held */ }
}

/**
 * When `sessionId`'s snapshot is an offered one still held, copy it under a
 * new session id (same conversation, title marked, original time) and remove
 * the original, so the live session's writes neither replace nor delete it.
 * False when it could not be kept apart: the caller then leaves the file as it
 * is. A held file that is gone or unreadable holds nothing to keep and is
 * released. Cost: one set lookup per snapshot write; the copy runs at most
 * once per offer.
 */
function keepHeldSnapshotApart(options: SessionPersistenceOptions | undefined, sessionId: string): boolean {
  if (heldOffers.size === 0) return true;
  const key = heldOfferKey(options, sessionId);
  if (!heldOffers.has(key)) return true;
  const path = pickRecoverySnapshotPath(options, sessionId);
  const held = path === undefined ? null : loadRecoveryConversationAt(path, sessionId);
  if (path === undefined || held === null || held.snapshot.messages.length === 0) {
    heldOffers.delete(key);
    return true;
  }
  const copyId = crypto.randomUUID();
  const title = held.snapshot.title?.trim() ? `${held.snapshot.title.trim()} (before the crash)` : 'Session before the crash';
  try {
    publishRecoverySnapshot(copyId, title, held.snapshot.timestamp ?? Date.now(), held.snapshot, options);
  } catch (error) {
    logger.warn('[Recovery] The offered crash snapshot could not be kept apart from the live session; it is left as it is', { sessionId, error: summarizeError(error) });
    return false;
  }
  heldOffers.delete(key);
  // The copy holds it now; a delete that does not complete is overwritten by the live write.
  deleteRecoverySnapshotAt(path, held.physical);
  logger.info('[Recovery] Kept the offered crash snapshot apart from the live session', { sessionId, copyId });
  return true;
}

/**
 * Write `sessionId`'s crash snapshot (one temp file, one rename). Never throws:
 * returns true when the snapshot is on disk, false when the conversation was
 * empty (nothing to keep) or the write failed (logged).
 */
export function writeRecoveryFile(
  snapshot: SessionSnapshot,
  sessionId: string,
  title = '',
  options?: SessionPersistenceOptions,
): boolean {
  try {
    if (!snapshot.messages.length) return false;
    // An offered snapshot of this session the person has not answered is never replaced.
    if (!keepHeldSnapshotApart(options, sessionId)) return false;
    publishRecoverySnapshot(sessionId, title, Date.now(), snapshot, options);
    return true;
  } catch (error) {
    logger.warn('[Recovery] Write failed', { error: summarizeError(error) });
    return false;
  }
}

/**
 * Delete a per-session recovery snapshot (after a clean save, or once its
 * conversation has been restored). With an explicit `sessionId` only that
 * session's file is removed. Without a `sessionId`, every recovery snapshot in the
 * scoped directory is cleared: this is the explicit FULL-RESET path, for a
 * caller that genuinely means "discard all crash state for this surface". It
 * is deliberately NOT what the prompted/silent recovery flows use,
 * `applyRecoverySnapshot`, `removeRecoveryPoint` and `autoRestoreRecovery` retire
 * exactly the one snapshot file they offered or loaded, so accepting one
 * session's snapshot can never destroy another session's. A missing file is
 * fine either way.
 */
export function deleteRecoveryFile(options?: SessionPersistenceOptions, sessionId?: string): void {
  try {
    if (sessionId) {
      try {
        // The turn-end save supersedes the live snapshot, not an offered crash snapshot of the same session.
        if (!keepHeldSnapshotApart(options, sessionId)) return;
        const path = resolveRecoveryFilePath(options, sessionId);
        const selected = readRecoveryMetaObservation(path);
        if (selected.info.sessionId === sessionId) deleteRecoverySnapshotAt(path, selected.physical);
      } catch {
        // missing file is fine
      }
      return;
    }
    const dir = resolveRecoveryDirPath(options);
    for (const entry of listRecoveryFiles(dir)) {
      try {
        deleteRecoverySnapshotAt(entry.path);
      } catch {
        // missing file is fine
      }
    }
  } catch {
    // missing directory / unresolved home is fine
  }
}

/** Read the first-line meta of a recovery file into a RecoveryFileInfo. */
function readRecoveryMetaObservation(recoveryFile: string): { readonly info: RecoveryFileInfo; readonly physical: string; readonly mtimeNs: bigint } {
  const { header: meta, physical, mtimeNs } = readRecoveryHeaderObservation(recoveryFile);
  if (meta['type'] !== 'meta') throw new Error('Invalid recovery header');
  return { physical, mtimeNs, info: {
    title: typeof meta['title'] === 'string' ? meta['title'] : '',
    timestamp: typeof meta['timestamp'] === 'number' ? meta['timestamp'] : 0,
    sessionId: typeof meta['sessionId'] === 'string' ? meta['sessionId'] : '',
    returnContext: loadedReturnContext(meta['returnContext']),
    turn: readSnapshotTurn(meta['turn']),
  } };
}

/**
 * The mtime of `sessionId`'s durable store file, or null when that session has
 * no store file (never cleanly saved, or its file was deleted), and also null
 * for a snapshot that carries no session id at all, which nothing in the store
 * can correspond to.
 */
function sessionStoreMtimeNs(sessionsDir: string, sessionId: string): bigint | null {
  if (!sessionId.trim()) return null;
  try {
    return statSync(resolveSessionStorePath(sessionsDir, sessionId), { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

/**
 * True when another running process has this session open, so its snapshot is
 * that process's working state. This process's own hold does not count: a
 * process asking about its own session is asking about its own crash residue.
 */
function isOpenInAnotherProcess(surface: SessionSurface | undefined, sessionId: string): boolean {
  if (!surface || !sessionId.trim()) return false;
  return isSessionOpenElsewhere(surface, sessionId);
}

/**
 * True when this snapshot was already superseded by a clean save of its OWN
 * session, the only thing that can make a snapshot stale.
 *
 * No store file for that session (including a snapshot with no session id)
 * means nothing has superseded it: offer it.
 *
 * Equal mtimes count as superseded, deliberately. Filesystem mtime resolution
 * and clock skew make "same timestamp" indistinguishable from "the store was
 * written last", and a snapshot whose content the store already holds is worth
 * nothing, so the tie goes to not re-offering data the user already has.
 */
function isSupersededByOwnStore(sessionsDir: string, sessionId: string, snapshotMtimeNs: bigint): boolean {
  const storeMtimeNs = sessionStoreMtimeNs(sessionsDir, sessionId);
  if (storeMtimeNs === null) return false;
  // Preserve the original native timestamps on both sides. Converting one
  // through Number(nanoseconds) and the other through Stats.mtimeMs can round
  // an actual tie in opposite directions and offer an already durable copy.
  return snapshotMtimeNs <= storeMtimeNs;
}

/**
 * The newest crash-recovery snapshot that has not been superseded by a clean
 * save of its own session (see the SUPERSESSION note at the top of this file).
 * Returns null when no live crash snapshot exists.
 *
 * A snapshot whose session another process has open is NOT offered: this is
 * an unsolicited boot-time question, and asking about state nobody lost is the
 * defect these rules exist to prevent. The next candidate is considered instead, so a live session's
 * snapshot never hides an older orphaned one.
 */
export function checkRecoveryFile(options?: SessionPersistenceOptions): RecoveryFileInfo | null {
  return findLiveRecoveryCandidate(options)?.info ?? null;
}

/**
 * Whether ONE specific session has a live crash snapshot, a snapshot strictly
 * newer than that session's own durable store file, under exactly the rule
 * `checkRecoveryFile` uses. Returns its meta, or null when that session has no
 * snapshot, its snapshot was already superseded, or another running process
 * has the session open (its snapshot is that process's working state).
 *
 * This is the probe for a consumer's resume-a-named-session flow (`--continue`
 * and friends): loading the store copy directly would silently drop the tail of
 * messages that only the snapshot holds, so the consumer asks here first and
 * routes a non-null answer through its recovery prompt instead of resuming the
 * shorter copy.
 */
export function checkRecoveryForSession(surface: SessionSurface, sessionId: string): RecoveryFileInfo | null {
  return findSessionCrashSnapshot(surface, sessionId)?.info ?? null;
}

/** A session's crash snapshot that is newer than everything its store holds. */
export interface SessionCrashSnapshot {
  readonly info: RecoveryFileInfo;
  /** False when the session has no store file at all: the snapshot is its only copy. */
  readonly hasSavedCopy: boolean;
}

/**
 * {@link checkRecoveryForSession} with whether the session has a saved copy at
 * all. A session that crashed before its first save has none; opening it means
 * restoring the snapshot, there is nothing else to load. One `stat` when the
 * session has no snapshot (the common case), otherwise the snapshot's first
 * line, the store's `stat` and the session lock probe.
 */
export function findSessionCrashSnapshot(surface: SessionSurface, sessionId: string): SessionCrashSnapshot | null {
  const options: SessionPersistenceOptions = { surface };
  try {
    const path = pickRecoverySnapshotPath(options, sessionId);
    if (!path) return null;
    const { info, mtimeNs } = readRecoveryMetaObservation(path);
    if (info.sessionId !== sessionId) return null;
    const storeMtimeNs = sessionStoreMtimeNs(resolveSessionsDirPath(options), sessionId);
    // Equal times count as superseded (see isSupersededByOwnStore).
    if (storeMtimeNs !== null && mtimeNs <= storeMtimeNs) return null;
    if (isOpenInAnotherProcess(surface, sessionId)) return null;
    return { info, hasSavedCopy: storeMtimeNs !== null };
  } catch (error) {
    logger.warn('[Recovery] Per-session check failed', { error: summarizeError(error) });
    return null;
  }
}

/**
 * The live crash snapshot to offer, as BOTH its meta and the exact path it was
 * read from, so a caller that acts on the offer (autoRestoreRecovery) retires
 * precisely the file it restored, rather than re-deriving a path from the
 * meta's session id and hoping the two agree.
 *
 * Note the ordering: each candidate's meta is read BEFORE the supersession
 * test, because the session id that names the store file to compare against
 * lives in that meta. An unreadable or partial snapshot is skipped, exactly as
 * before.
 */
function findLiveRecoveryCandidate(
  options?: SessionPersistenceOptions,
): { path: string; info: RecoveryFileInfo; physical: string } | null {
  try {
    const sessionsDir = resolveSessionsDirPath(options);
    const surface = requireSurface(options);
    for (const entry of listRecoveryCandidates(options)) {
      // Newest-first; the first snapshot no running process holds open and its
      // own session has not already superseded is the one to offer.
      let selected: ReturnType<typeof readRecoveryMetaObservation>;
      try {
        selected = readRecoveryMetaObservation(entry.path);
      } catch {
        // Unreadable/partial snapshot, skip to the next candidate.
        continue;
      }
      const { info, physical, mtimeNs } = selected;
      if (isSupersededByOwnStore(sessionsDir, info.sessionId, mtimeNs)) continue;
      if (isOpenInAnotherProcess(surface, info.sessionId)) continue;
      return { path: entry.path, info, physical };
    }
    return null;
  } catch (error) {
    logger.warn('[Recovery] Check failed', { error: summarizeError(error) });
    return null;
  }
}

/** Parse a recovery snapshot file's contents into a SessionSnapshot. Throws on any read/parse failure, callers wrap this in their own try/catch. */
interface RecoverySnapshotObservation {
  readonly snapshot: SessionSnapshot;
  readonly physical: string;
}

function parseRecoveryFile(recoveryFile: string, expectedSessionId?: string, expectedPhysical?: string): RecoverySnapshotObservation {
  const source = readFileObservation(recoveryFile);
  if (expectedPhysical !== undefined && source.physical !== expectedPhysical) throw new Error('Recovery snapshot changed');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes); }
  catch { throw new Error('Invalid recovery snapshot'); }
  const lines = text.split('\n').filter(Boolean);
  const parse = (line: string): Record<string, unknown> => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Invalid recovery snapshot'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery snapshot');
    return value as Record<string, unknown>;
  };
  const meta = parse(lines[0] ?? '');
  if (meta['type'] !== 'meta') throw new Error('Invalid recovery header');
  if (expectedSessionId !== undefined && meta['sessionId'] !== expectedSessionId) throw new Error('Recovery snapshot belongs to another session');
  const snapshot: SessionSnapshot = {
    // When the snapshot was written: journal records after it are newer than it.
    timestamp: typeof meta['timestamp'] === 'number' && Number.isFinite(meta['timestamp']) ? meta['timestamp'] : undefined,
    title: typeof meta['title'] === 'string' ? meta['title'] : undefined,
    titleSource: meta['titleSource'] as ConversationTitleSource | undefined,
    returnContext: loadedReturnContext(meta['returnContext']),
    turn: readSnapshotTurn(meta['turn']),
    messages: lines.slice(1).map(line => { const { type: _type, ...message } = parse(line); return message; }),
  };
  return { snapshot, physical: source.physical };
}

/**
 * Load a recovery snapshot's conversation. With an explicit `sessionId` the
 * matching per-session file is loaded; without one, the newest crash snapshot
 * (the same one checkRecoveryFile offers) is loaded.
 */
export function loadRecoveryConversation(options?: SessionPersistenceOptions, sessionId?: string): SessionSnapshot | null {
  let recoveryFile: string | undefined;
  try {
    recoveryFile = pickRecoverySnapshotPath(options, sessionId);
  } catch (error) {
    logger.warn('[Recovery] Load failed', { error: summarizeError(error) });
    return null;
  }
  if (!recoveryFile) return null;
  return loadRecoveryConversationAt(recoveryFile, sessionId)?.snapshot ?? null;
}

/** Parse one specific snapshot file, converting any read/parse failure into null (never throws). */
function loadRecoveryConversationAt(recoveryFile: string, expectedSessionId?: string, expectedPhysical?: string): RecoverySnapshotObservation | null {
  try {
    return parseRecoveryFile(recoveryFile, expectedSessionId, expectedPhysical);
  } catch (error) {
    logger.warn('[Recovery] Load failed', { error: summarizeError(error) });
    return null;
  }
}

/**
 * A one-line receipt sink, the structural shape of FeatureAnnouncementStore's
 * announce-once queue (`record(id, text)`), so auto-restore can enqueue its
 * receipt into the same attach-time queue surfaces drain, without this module
 * depending on the config layer.
 */
export interface RecoveryReceiptSink {
  record(id: string, text?: string): boolean;
}

/** The outcome of a silent auto-restore. */
export interface RecoveryRestoreResult {
  readonly snapshot: SessionSnapshot;
  readonly info: RecoveryFileInfo;
  /** The one-line receipt describing the restore. */
  readonly receipt: string;
  /**
   * False when the snapshot file could not be retired (it changed on disk after
   * it was read, or the delete failed). The snapshot is still returned, so the
   * conversation is not lost, but the file stays and would be offered again on
   * the next start: a caller that applies this result should persist it as a
   * saved session so the leftover snapshot is superseded.
   */
  readonly retired: boolean;
}

/** Build the one-line restore receipt, verbatim. */
function recoveryReceiptText(info: RecoveryFileInfo, messageCount: number): string {
  const label = info.title.trim().length > 0 ? ` "${info.title.trim()}"` : '';
  const plural = messageCount === 1 ? 'message' : 'messages';
  return `Restored an interrupted session${label}: ${messageCount} ${plural} recovered from a crash snapshot.`;
}

/**
 * Silent crash-recovery restore. When a live crash snapshot exists (one its own
 * session has not superseded with a clean save), its conversation is loaded and
 * returned WITHOUT a prompt, its snapshot file is cleared, and a single one-line
 * receipt is enqueued into the receipts sink (exactly once per snapshot session)
 * so the restore surfaces as a receipt rather than an interruption. Returns null
 * when there is nothing to restore.
 *
 * This is the platform-side replacement for the old restore-and-collide dance: with
 * per-session snapshot files there is no shared recovery file to guard, so the
 * consuming surface's collision-preservation workaround is no longer needed.
 */
export function autoRestoreRecovery(
  options?: SessionPersistenceOptions,
  receipts?: RecoveryReceiptSink,
): RecoveryRestoreResult | null {
  const candidate = findLiveRecoveryCandidate(options);
  if (!candidate) return null;
  const { path, info, physical } = candidate;
  const loaded = loadRecoveryConversationAt(path, info.sessionId, physical);
  if (!loaded || loaded.snapshot.messages.length === 0) return null;
  const { snapshot } = loaded;
  const receipt = recoveryReceiptText(info, snapshot.messages.length);
  if (receipts) {
    try {
      receipts.record(`session-recovery-restored:${info.sessionId}`, receipt);
    } catch (error) {
      logger.warn('[Recovery] receipt enqueue failed', { error: summarizeError(error) });
    }
  }
  // The snapshot has served its purpose, retire exactly the file that was
  // restored (never a directory sweep, and never a path re-derived from the
  // meta's session id, which a snapshot with an empty/foreign id would not
  // resolve back to).
  heldOffers.delete(heldOfferKey(options, info.sessionId));
  const retired = deleteRecoverySnapshotAt(path, loaded.physical);
  if (!retired) {
    logger.warn('[Recovery] Restored snapshot could not be retired; it will be offered again until the session is saved', { sessionId: info.sessionId });
  }
  return { snapshot, info, receipt, retired };
}

/** The outcome of the prompted "no, and remove it" recovery flow (`removeRecoveryPoint`). */
export interface RecoveryRemoveResult {
  /** True when a recovery snapshot existed on disk and was deleted; false when there was nothing to remove. */
  readonly removed: boolean;
}

/**
 * The "no, and remove it" primitive for a consumer's prompted recovery flow:
 * deletes a session's recovery snapshot WITHOUT loading it, and reports
 * honestly whether there was anything there to delete. It never touches any
 * conversation object, it only clears the on-disk snapshot.
 *
 * Exactly ONE snapshot is retired: the identified one. Omitting
 * `sessionId` declines the snapshot currently being offered (the newest) and
 * removes only that file, every other session's snapshot survives untouched.
 */
export function removeRecoveryPoint(surface: SessionSurface, sessionId?: string): RecoveryRemoveResult {
  const options: SessionPersistenceOptions = { surface };
  const path = pickRecoverySnapshotPath(options, sessionId);
  if (sessionId !== undefined) releaseOfferedRecoverySnapshot(surface, sessionId);
  if (!path) return { removed: false };
  try {
    const selected = readRecoveryMetaObservation(path);
    if (sessionId !== undefined && selected.info.sessionId !== sessionId) return { removed: false };
    releaseOfferedRecoverySnapshot(surface, selected.info.sessionId);
    return { removed: deleteRecoverySnapshotAt(path, selected.physical) };
  } catch { return { removed: false }; }
}
