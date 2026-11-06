import { activeTokens } from './theme.js';
import { formatTimestamp } from './modal-utils.js';
import {
  beginModal,
  drawWrapped,
  finishModal,
  scrollCountText,
  searchRow,
  wrapLines,
  type KitHint,
  type SurfaceLayer,
} from './surface-kit.js';
import { drawList, drawScrollingList, measureRow, type KitRow } from './surface-kit-list.js';
interface SessionPickerRenderState {
  readonly query: string;
  readonly selectedIndex: number;
  readonly deleteConfirmationTarget: string | null;
  readonly statusMessage: string;
  readonly sessions: readonly unknown[];
  visibleSessions(): readonly {
    readonly name: string;
    readonly title?: string | undefined;
    readonly timestamp: number;
    readonly messageCount: number;
  }[];
  setVisibleRows(count: number): void;
}
const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type RecencyGroup = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function recencyGroup(ts: number, now: number): RecencyGroup {
  const today = startOfDay(now);
  if (ts >= today) return 'Today';
  if (ts >= today - DAY_MS) return 'Yesterday';
  if (ts >= today - 6 * DAY_MS) return 'This week';
  return 'Earlier';
}

/** Short age for the right column: HH:MM today, "Mon D" this year, the full date otherwise. */
function shortWhen(ts: number, now: number): string {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (ts >= startOfDay(now)) return formatTimestamp(ts).slice(11);
  if (d.getFullYear() === new Date(now).getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return formatTimestamp(ts).slice(0, 10);
}

export function createSessionPickerRenderer<Modal extends SessionPickerRenderState>(policy: {
  readonly allowDelete: boolean;
  readonly mouseNavigation: boolean;
  readonly openLabel: string;
  readonly deleteLabel: string;
  readonly saveHint: string;
  readonly pinned?: ((modal: Modal) => KitRow[]) | undefined;
}) {
  function localRows(modal: SessionPickerRenderState, now: number): Map<RecencyGroup, KitRow[]> {
    const t = activeTokens();
    const groups = new Map<RecencyGroup, KitRow[]>();
    modal.visibleSessions().forEach((sess, index) => {
      const selected = index === modal.selectedIndex;
      const armed = policy.allowDelete && modal.deleteConfirmationTarget === sess.name && selected;
      const group = recencyGroup(sess.timestamp, now);
      const title = sess.title && sess.title !== sess.name ? sess.title : '';
      const row: KitRow = armed
        ? {
            label: `Press d again to delete "${sess.name}"`,
            right: `${sess.messageCount} msgs · ${shortWhen(sess.timestamp, now)}`,
            danger: true,
            mark: '✕',
            markFg: t.error,
            selected,
          }
        : {
            label: title || sess.name,
            desc: title ? sess.name : undefined,
            right: `${sess.messageCount} msgs · ${shortWhen(sess.timestamp, now)}`,
            selected,
          };
      const list = groups.get(group) ?? [];
      list.push(row);
      groups.set(group, list);
    });
    return groups;
  }
  function renderSessionPickerModal(modal: Modal, screenWidth: number, screenHeight = 24, now: number = Date.now()): SurfaceLayer {
    const t = activeTokens();
    const armed = policy.allowDelete && modal.deleteConfirmationTarget !== null;
    const hints: KitHint[] =
      modal.query.length === 0
        ? [
            ['↑↓', 'move'],
            ['⏎', policy.openLabel],
            ['d', armed ? 'confirm delete' : policy.deleteLabel],
          ]
        : [
            ['↑↓', 'move'],
            ['⏎', policy.openLabel],
            ['⌫', 'edit search'],
          ];
    const f = beginModal(screenWidth, screenHeight, { title: 'Sessions', hints });

    const visible = modal.visibleSessions();
    const count = modal.query.length > 0 ? `${visible.length} of ${modal.sessions.length}` : `${modal.sessions.length} saved`;
    searchRow(f, f.top, modal.query, 'Search sessions', count);

    // Status and the armed-delete note sit at the bottom of the body, wrapped in full.
    const footLines: Array<{ text: string; fg: string }> = [];
    const width = f.r - f.l + 1;
    // While armed, the row itself carries the "press d again" prompt.
    if (modal.statusMessage && !armed) {
      for (const line of wrapLines(modal.statusMessage, width)) footLines.push({ text: line, fg: armed ? t.warning : t.accent });
    }
    if (policy.allowDelete && armed) {
      for (const line of wrapLines(
        `Deletion is armed for ${modal.deleteConfirmationTarget}. Move selection or press Esc to cancel.`,
        width,
      ))
        footLines.push({ text: line, fg: t.textFaint });
    }
    const listBottom = footLines.length > 0 ? f.bottom - footLines.length - 1 : f.bottom;

    const rows: KitRow[] = [];
    const local = localRows(modal, now);
    const pushGroup = (name: RecencyGroup): void => {
      const group = local.get(name);
      if (group && group.length > 0) rows.push({ header: name }, ...group);
    };
    if (modal.sessions.length === 0) {
      rows.push({ label: 'No saved sessions.', labelFg: t.textFaint });
      rows.push({ label: policy.saveHint, labelFg: t.textFaint });
    } else if (visible.length === 0) {
      rows.push({ label: `No sessions match "${modal.query}".`, labelFg: t.textFaint });
    }
    pushGroup('Today');
    pushGroup('Yesterday');
    pushGroup('This week');
    pushGroup('Earlier');

    // Hosted and cross-surface sessions are read-only (not selectable), so they
    // are pinned under the saved sessions instead of scrolling with them: a
    // long saved list can never push them out of reach. Past half the body
    // they count what they hide.
    const pinned: KitRow[] = policy.pinned?.(modal) ?? [];
    const top = f.top + 2;
    let savedBottom = listBottom;
    if (pinned.length > 0) {
      const pinnedNeed = pinned.reduce((sum, row, i) => sum + measureRow(row, f.l, f.r) + (i > 0 && row.header !== undefined ? 1 : 0), 0);
      const pinnedRows = Math.min(pinnedNeed, Math.max(3, Math.floor((listBottom - top + 1) / 2)));
      const pinnedTop = listBottom - pinnedRows + 1;
      drawScrollingList(f.canvas, { rows: pinned, top: pinnedTop, bottom: listBottom, x0: f.l, x1: f.r });
      savedBottom = pinnedTop - 2;
    }

    modal.setVisibleRows(Math.max(3, savedBottom - top + 1));
    const result = drawList(f.canvas, {
      mouseNavigation: policy.mouseNavigation,
      rows,
      top,
      bottom: savedBottom,
      x0: f.l,
      x1: f.r,
      scrollKey: { owner: modal, name: 'sessions' },
    });
    f.hintRight = scrollCountText(result.above, result.below);

    let y = listBottom + 2;
    for (const line of footLines) {
      drawWrapped(f.canvas, f.l, y, width, line.text, { fg: line.fg }, f.bottom);
      y++;
    }
    return finishModal(f);
  }
  return { renderSessionPickerModal };
}
