/**
 * place-menu.ts, the menu of every place (the leader, then m; or a click on
 * the status line's `menu` keycap), in both terminal programs.
 *
 *   ✦ GoodVibes   every place                                          esc
 *   ▏type to filter
 *
 *    This conversation   on the conversation itself: clear, compact, ...
 *    ...
 *    Waiting for you     questions, approvals, held items, ...    2 waiting
 *    Automation          schedules, triggers, watches, check-ins   1 failed
 *    ...
 *
 * The fourteen function groups in their order (platform capabilities
 * groups.ts), each with one line on what is there and a count where
 * something is waiting or wrong, read by itself when the menu opens and
 * again on the change events its places follow. Typing filters; Enter opens
 * the group's place.
 */
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import { CAPABILITY_GROUPS } from '@goodvibes/engine/platform/platform/capabilities';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from '../surface-modal-host.js';
import { beginModal, finishModal, MODAL_MARK_INSET, scrollCountText, searchRow, type KitHint, type SurfaceLayer } from '../renderer/surface-kit.js';
import { drawList, type KitRow } from '../renderer/surface-kit-list.js';
import { activeTokens } from '../renderer/theme.js';
import { keycapOf, type PlaceHost } from './place-host.js';
import { followPlace, readListItems, type PlaceReadMemo } from './place-modal.js';
import type { AnyPlace, PlaceCount, PlaceItem } from './place-types.js';

interface MenuRow {
  readonly group: string;
  readonly title: string;
  readonly line: string;
  readonly place: AnyPlace | undefined;
}

export class PlaceMenu implements SurfaceModal {
  readonly name = 'place-menu';
  private query = '';
  private selected = 0;
  private note: string | undefined;
  private closed = false;
  private readonly counts = new Map<string, PlaceCount | undefined>();
  private readonly stops: Array<() => void> = [];
  private followStops: Array<() => void> = [];
  private host: SurfaceModalHost | undefined;

  constructor(private readonly places: readonly AnyPlace[], private readonly placeHost: PlaceHost) {
    this.follow();
    // The program's daemon connection back: every count is read and followed again, with no key pressed.
    this.stops.push(placeHost.onDaemonBack(() => { if (!this.closed) this.follow(); }));
  }

  /** One event stream per place: any change reads the place's count again. Each count is read now. */
  private follow(): void {
    for (const stop of this.followStops.splice(0)) stop();
    for (const place of this.places) {
      if (!place.count) continue;
      const read = (): void => { void this.count(place); };
      read();
      this.followStops.push(...followPlace(place.lists, this.placeHost, read));
    }
  }

  /** Read a place's lists and keep what its count says; a list that cannot be read counts nothing. */
  private async count(place: AnyPlace): Promise<void> {
    const lists: Record<string, readonly PlaceItem[]> = {};
    // Lists of one method and input are one call.
    const memo: PlaceReadMemo = new Map();
    await Promise.all(place.lists.map(async (list) => {
      try { lists[list.id] = await readListItems(list, this.placeHost, memo); } catch { lists[list.id] = []; }
    }));
    if (this.closed) return;
    this.counts.set(place.id, place.count?.(lists));
    this.placeHost.requestRender();
  }

  private rows(): readonly MenuRow[] {
    const all = CAPABILITY_GROUPS.map((group): MenuRow => ({
      group: group.id,
      title: group.title,
      line: group.line,
      place: this.places.find((place) => place.group === group.id),
    }));
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all;
    return all.filter((row) => words.every((word) => `${row.title} ${row.line}`.toLowerCase().includes(word)));
  }

  private open(row: MenuRow | undefined): void {
    if (!row) return;
    if (!row.place) { this.note = `${row.title} has no place in this program yet.`; return; }
    this.placeHost.openPlace(row.place.id);
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    this.host = host;
    const rows = this.rows();
    if (token.type === 'text') {
      if (token.value === '\t') return;
      this.query += token.value;
      this.selected = 0;
      this.note = undefined;
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (key === 'up') this.selected = (this.selected - 1 + rows.length) % Math.max(1, rows.length);
    else if (key === 'down') this.selected = (this.selected + 1) % Math.max(1, rows.length);
    else if (key === 'backspace') { this.query = this.query.slice(0, -1); this.selected = 0; }
    else if (key === 'enter') this.open(rows[this.selected]);
  }

  onClose(_reason: SurfaceModalCloseReason): void {
    this.closed = true;
    for (const stop of this.stops.splice(0)) stop();
    for (const stop of this.followStops.splice(0)) stop();
  }

  /** Close the menu (a place was opened from it). */
  dismiss(): void {
    this.host?.close(this, 'done');
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    const t = activeTokens();
    const rows = this.rows();
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    const label = (action: string, fallback: string): string => keycapOf(this.placeHost.keys, action, fallback);
    const hints: KitHint[] = [[label('choose', '⏎'), 'open'], ['type', 'filter'], [label('back', 'esc'), 'close']];
    const f = beginModal(screenWidth, screenHeight, { title: 'GoodVibes', sub: 'every place', hints });
    searchRow(f, f.top, this.query, 'type to filter');
    const titleWidth = Math.max(...CAPABILITY_GROUPS.map((group) => group.title.length)) + 3;
    const x0 = f.l + 1 + MODAL_MARK_INSET;
    const x1 = f.r - MODAL_MARK_INSET;
    const kitRows: KitRow[] = rows.map((row, index) => {
      const count = row.place ? this.counts.get(row.place.id) : undefined;
      const right = count ? count.words : row.place ? '' : 'not here yet';
      // One row each: the line is cut to what is left beside the title and the count.
      const room = Math.max(0, x1 - x0 + 1 - titleWidth - (right ? right.length + 3 : 0));
      const line = row.line.length > room ? `${row.line.slice(0, Math.max(0, room - 1)).trimEnd()}…` : row.line;
      return {
        spans: [
          { text: row.title.padEnd(titleWidth), fg: row.place ? t.text : t.textMuted, bold: index === this.selected },
          { text: room > 3 ? line : '', fg: t.textMuted },
        ],
        ...(count ? { right, rightFg: count.tone === 'wrong' ? t.warning : t.info } : right ? { right } : {}),
        selected: index === this.selected,
        muted: !row.place,
        onClick: () => { this.selected = index; this.open(row); this.placeHost.requestRender(); },
      };
    });
    const bottom = f.bottom - (this.note ? 2 : 0);
    if (rows.length === 0) f.canvas.put(f.l + 1, f.top + 2, `Nothing matches "${this.query}".`, { fg: t.textMuted });
    else {
      const listed = drawList(f.canvas, { mouseNavigation: true, rows: kitRows, top: f.top + 2, bottom, x0, x1, scrollKey: { owner: this, name: 'place-menu' } });
      f.hintRight = scrollCountText(listed.above, listed.below);
    }
    if (this.note) f.canvas.put(f.l + 1, f.bottom, this.note, { fg: t.textMuted });
    return finishModal(f);
  }
}
