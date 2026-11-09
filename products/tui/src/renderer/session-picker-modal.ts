/**
 * renderSessionPickerModal, the /sessions picker drawn with the modal surface kit.
 *
 * Saved sessions grouped by recency (today, yesterday, this week, earlier)
 * with message count and age right-aligned and muted, an always-live search
 * row, and two read-only groups: sessions hosted on the daemon and the
 * cross-surface session union (each with its honest state: never read,
 * offline, stale, empty). Deleting arms the row in red and asks for the same
 * key again, in place.
 */

import type { SharedSessionRecord } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { activeTokens } from './theme.ts';
import type { SessionPickerModal } from '../input/session-picker-modal.ts';
import './modal-utils.ts';
import './surface-kit.ts';
import { type KitRow } from './surface-kit-list.ts';

// ---------------------------------------------------------------------------
// Cross-surface badge helpers (parity with webui's src/lib/sessions-union.ts)
// ---------------------------------------------------------------------------

/** Verbatim for unknown/future kinds, never dropped, never guessed. */
function kindLabel(kind: string): string {
  return kind.trim() || 'unknown';
}

function projectLabel(project: string): string {
  return project.trim() || 'unknown';
}

function isClosedStatus(status: string): boolean {
  return status.trim().toLowerCase() === 'closed';
}

/**
 * Closed sessions carry an optional, honest reason for WHY they
 * closed under `metadata.closeReason` (platform's `SharedSessionCloseReason`,
 * 'closeReason' key, see `@goodvibes-jev/engine/platform` platform/control-plane
 * session-broker-sessions.ts's `readSessionCloseReason`). `metadata` is an
 * open record so old readers and records from a build that predates this
 * field ignore it safely, read it duck-typed here rather than importing the
 * platform's helper, and tolerate `metadata` itself being absent or malformed.
 */
function readCloseReason(record: SharedSessionRecord): string | undefined {
  const raw = (record.metadata as Record<string, unknown> | undefined)?.['closeReason'];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * A GC sweep closing an idle session ('idle-reaped') auto-reopens on the next
 * heartbeat, it is NOT the same event as a deliberate user/surface close, so
 * it must never render under the same "closed" badge. Tolerant of
 * records without the field (pre-feature builds, or a deliberate close).
 */
function isReapedRecord(record: SharedSessionRecord): boolean {
  return isClosedStatus(record.status) && readCloseReason(record) === 'idle-reaped';
}

/**
 * UX-lens note: 'reaped' names a mechanism (the idle-session sweep),
 * not a state a first-time reader can guess, the webui pairs its own
 * 'reaped' badge with a tooltip explaining it
 * (SessionsView.tsx: "Closed by the idle-session sweep, reopens
 * automatically on the next activity"). The TUI has no hover/tooltip
 * surface, so the plain-language explanation is rendered as its own short
 * line under the cross-surface list instead, shown ONLY when at least one
 * visible row actually carries the badge, so it never adds noise to a list
 * with no reaped rows.
 */
const REAPED_BADGE_HINT = 'reaped = closed by the idle sweep; reopens on next activity';

/** True when at least one of the currently-rendered (post-truncation) cross-surface rows carries the 'reaped' badge. */
function hasVisibleReapedRow(modal: SessionPickerModal): boolean {
  if (modal.crossSurfaceView.mode === 'local') return false;
  return modal.crossSurfaceSessions.slice(0, MAX_CROSS_SURFACE_ROWS).some(isReapedRecord);
}

function statusLabel(record: SharedSessionRecord): string {
  const trimmed = record.status.trim();
  if (!trimmed) return 'active';
  if (!isClosedStatus(trimmed)) return trimmed;
  return isReapedRecord(record) ? 'reaped' : 'closed';
}

const MAX_CROSS_SURFACE_ROWS = 5;
const MAX_HOSTED_ROWS = 5;

// ---------------------------------------------------------------------------
// Daemon-hosted sessions
// ---------------------------------------------------------------------------

/**
 * The exact honest state of the hosted section, or null when the rows speak for
 * themselves. "Never read" and "the daemon hosts nothing" are different facts
 * and are never collapsed into each other.
 */
function hostedRosterNote(roster: SessionPickerModal['hostedRoster']): string | null {
  if (roster.note) return roster.note;
  if (roster.capturedAt === null) return 'Not read yet.';
  if (roster.sessions.length === 0) return 'The daemon is hosting no sessions.';
  return null;
}

/**
 * Whether the hosted section renders at all.
 *
 * Absent when NOTHING is known: no roster was wired (every pre-existing caller
 * and test), so the box size and content are unchanged for them. The moment the
 * roster has an answer, rows, an empty-but-read list, or a reason it could not
 * read, the section appears, because each of those is a fact worth showing.
 */
function hostedSectionVisible(modal: SessionPickerModal): boolean {
  const roster = modal.hostedRoster;
  return roster.sessions.length > 0 || roster.capturedAt !== null || roster.note !== null;
}

/**
 * The exact honest note for the current state, or null when the union view
 * needs no caveat (fresh, with rows). Precedence: offline > stale >
 * true-empty, the three designed states, never collapsed into
 * each other (an offline view never silently renders as "no sessions yet").
 */
function crossSurfaceNote(view: SessionPickerModal['crossSurfaceView'], rowCount: number): string | null {
  if (view.mode === 'local') return null;
  if (view.offlineNote) return `${view.offlineNote}: showing local sessions only`;
  if (view.stale) {
    if (view.lastSyncAt === null) return 'Union view may be stale.';
    const ageSeconds = Math.max(0, Math.round((Date.now() - view.lastSyncAt) / 1000));
    return `Union view may be stale, last synced ${ageSeconds}s ago`;
  }
  if (rowCount === 0) return 'No sessions yet.';
  return null;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Short age for the right column: HH:MM today, "Mon D" this year, the full date otherwise. */

function hostedRows(modal: SessionPickerModal): KitRow[] {
  if (!hostedSectionVisible(modal)) return [];
  const t = activeTokens();
  const roster = modal.hostedRoster;
  const rows: KitRow[] = [{ header: 'Hosted', headerRight: 'on the daemon' }];
  const note = hostedRosterNote(roster);
  if (note) rows.push({ label: note, labelFg: roster.note ? t.warning : t.textFaint });
  for (const record of roster.sessions.slice(0, MAX_HOSTED_ROWS)) {
    const policy = record.effectiveDetachPolicy === 'survive' ? 'survives detach' : 'ends on detach';
    const attached = record.attachedClients.length > 0 ? `${record.attachedClients.length} attached` : 'nobody attached';
    const running = record.status === 'running';
    const terminated = record.status === 'terminated';
    rows.push({
      label: record.title || 'untitled',
      desc: `${record.id} · ${record.status} · ${policy} · ${attached}`,
      mark: running ? '◐' : terminated ? '○' : '●',
      markFg: running ? t.brand : terminated ? t.textFaint : t.textMuted,
      muted: terminated,
    });
  }
  if (roster.sessions.length > MAX_HOSTED_ROWS)
    rows.push({ label: `showing ${MAX_HOSTED_ROWS} of ${roster.sessions.length}`, labelFg: t.textFaint });
  if (roster.sessions.length > 0) rows.push({ label: 'Join one with /hosted attach <id>', labelFg: t.textFaint });
  return rows;
}

function crossSurfaceRows(modal: SessionPickerModal): KitRow[] {
  if (modal.crossSurfaceView.mode === 'local') return [];
  const t = activeTokens();
  const rows: KitRow[] = [{ header: 'Other surfaces', headerRight: modal.crossSurfaceView.mode }];
  const note = crossSurfaceNote(modal.crossSurfaceView, modal.crossSurfaceSessions.length);
  if (note) rows.push({ label: note, labelFg: modal.crossSurfaceView.offlineNote ? t.warning : t.textFaint });
  for (const record of modal.crossSurfaceSessions.slice(0, MAX_CROSS_SURFACE_ROWS)) {
    const reaped = isReapedRecord(record);
    const closed = isClosedStatus(record.status);
    rows.push({
      label: record.title || record.id,
      desc: `${kindLabel(record.kind)} · ${statusLabel(record)} · ${projectLabel(record.project)}`,
      // Reaped rows get their own tone: they reopen on the next heartbeat, unlike a deliberate close.
      labelFg: reaped ? t.info : undefined,
      muted: closed && !reaped,
    });
  }
  if (modal.crossSurfaceSessions.length > MAX_CROSS_SURFACE_ROWS) {
    rows.push({ label: `showing ${MAX_CROSS_SURFACE_ROWS} of ${modal.crossSurfaceSessions.length}`, labelFg: t.textFaint });
  }
  if (hasVisibleReapedRow(modal)) rows.push({ label: REAPED_BADGE_HINT, labelFg: t.info });
  return rows;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the session picker as a modal layer.
 *
 * @param modal         SessionPickerModal state.
 * @param screenWidth   Terminal width.
 * @param screenHeight  Terminal height.
 * @param now           Clock for the recency groups (tests pass a fixed value).
 */

import { createSessionPickerRenderer } from '@goodvibes-jev/engine/terminal-shell/renderer/session-picker';
export const { renderSessionPickerModal } = createSessionPickerRenderer<SessionPickerModal>({
  allowDelete: true,
  mouseNavigation: true,
  openLabel: 'open',
  deleteLabel: 'delete',
  saveHint: 'Use /save [name] to save the current session.',
  pinned: (modal) => [...hostedRows(modal), ...crossSurfaceRows(modal)],
});
