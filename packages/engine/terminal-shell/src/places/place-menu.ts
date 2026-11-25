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
import type { AnyPlace, PlaceCapabilityAction, PlaceCount, PlaceItem } from './place-types.js';
import { ENDS_THE_PROGRAM, placeActionName } from './place-keys.js';

/** The lists a place's count reads (`countFrom`), every list when it names none: only these are read and followed here. */
function countedLists(place: AnyPlace): AnyPlace['lists'] {
  return place.countFrom ? place.lists.filter((list) => place.countFrom!.includes(list.id)) : place.lists;
}

interface MenuRow {
  readonly group: string;
  readonly title: string;
  readonly line: string;
  readonly place: AnyPlace | undefined;
  /** A row for one tab of the place, found by its name: the place opens on it. */
  readonly list?: string | undefined;
  /** A row for one action of the place, found by its words: Enter runs it (it opens or shows something). */
  readonly action?: PlaceCapabilityAction<PlaceItem> | undefined;
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

  private counting = false;
  private countAgain = false;

  constructor(
    private readonly places: readonly AnyPlace[],
    private readonly placeHost: PlaceHost,
    /** The program counted (its view of each place) and its project, for the daemon's one count of every place. */
    private readonly asker: { readonly program?: 'tui' | 'agent' | undefined; readonly workingDirectory?: string | undefined } = {},
  ) {
    this.follow();
    // The program's daemon connection back: every count is read and followed again, with no key pressed.
    this.stops.push(placeHost.onDaemonBack(() => { if (!this.closed) this.follow(); }));
  }

  /**
   * Each count read now, and again on the change events its lists follow. A place whose lists (as this program shows
   * it) are all the daemon's is counted by the daemon, every such place in one call (`places.counts`, the place's own
   * count over its own lists); one with a list this program keeps is counted here, from its lists.
   */
  private follow(): void {
    for (const stop of this.followStops.splice(0)) stop();
    const counted = this.places.filter((place) => place.count !== undefined);
    const byDaemon = counted.filter((place) => place.lists.every((list) => list.source.kind === 'daemon'));
    if (byDaemon.length > 0) {
      const read = (): void => { void this.countByDaemon(byDaemon); };
      read();
      this.followStops.push(...followPlace(byDaemon.flatMap(countedLists), this.placeHost, read, undefined, byDaemon.flatMap((place) => place.actions)));
    }
    for (const place of counted.filter((candidate) => !byDaemon.includes(candidate))) {
      const read = (): void => { void this.count(place); };
      read();
      this.followStops.push(...followPlace(countedLists(place), this.placeHost, read, undefined, place.actions));
    }
  }

  /** The daemon's count of these places, in one call; a change heard while it is read reads once more after it. */
  private async countByDaemon(places: readonly AnyPlace[]): Promise<void> {
    if (this.counting) { this.countAgain = true; return; }
    this.counting = true;
    try {
      const answer = await this.placeHost.invoke('places.counts', {
        ...(this.asker.program ? { program: this.asker.program } : {}),
        ...(this.asker.workingDirectory ? { workingDirectory: this.asker.workingDirectory } : {}),
      });
      const rows = answer !== null && typeof answer === 'object' && Array.isArray((answer as { places?: unknown }).places)
        ? (answer as { places: readonly unknown[] }).places : [];
      if (this.closed) return;
      for (const place of places) {
        const row = rows.find((entry) => entry !== null && typeof entry === 'object' && (entry as { place?: unknown }).place === place.id) as
          { count?: unknown; words?: unknown; tone?: unknown } | undefined;
        const tone = row?.tone === 'wrong' ? 'wrong' : 'waiting';
        this.counts.set(place.id, row && typeof row.count === 'number' && row.count > 0 && typeof row.words === 'string'
          ? { count: row.count, words: row.words, tone } : undefined);
      }
      this.placeHost.requestRender();
    } catch {
      // A daemon that does not answer counts nothing now; the counts are read again when it is back.
    } finally {
      this.counting = false;
      if (this.countAgain && !this.closed) { this.countAgain = false; void this.countByDaemon(places); }
    }
  }

  /** Read a place's lists and keep what its count says; a list that cannot be read counts nothing. */
  private async count(place: AnyPlace): Promise<void> {
    const lists: Record<string, readonly PlaceItem[]> = {};
    // Lists of one method and input are one call.
    const memo: PlaceReadMemo = new Map();
    await Promise.all(countedLists(place).map(async (list) => {
      try { lists[list.id] = await readListItems(list, this.placeHost, memo); } catch { lists[list.id] = []; }
    }));
    if (this.closed) return;
    this.counts.set(place.id, place.count?.(lists));
    this.placeHost.requestRender();
  }

  /**
   * Every group, or what the typed words find: a group's name first, then a list or tab inside its place (its own
   * row, "System: Keys", opening the place on that tab), then the group's description. A group found by its name or
   * a tab is not listed again for its description.
   */
  private rows(): readonly MenuRow[] {
    const all = CAPABILITY_GROUPS.map((group): MenuRow => ({
      group: group.id,
      title: group.title,
      line: group.line,
      place: this.places.find((place) => place.group === group.id),
    }));
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all;
    const has = (text: string): boolean => words.every((word) => text.toLowerCase().includes(word));
    const byName = all.filter((row) => has(row.title));
    // A tab whose name is what was typed first, then a tab whose name holds it, then one whose noun does.
    const typed = words.join(' ');
    const tabRank = (list: { readonly label: string; readonly noun: string }): number =>
      list.label.toLowerCase() === typed ? 0 : has(list.label) ? 1 : has(list.noun) ? 2 : 3;
    const byTab = all.flatMap((row) => (row.place?.lists ?? [])
      .filter((list) => tabRank(list) < 3)
      .map((list) => ({ rank: tabRank(list), row: { ...row, title: `${row.title}: ${list.label}`, list: list.id } as MenuRow })))
      .sort((left, right) => left.rank - right.rank)
      .map(({ row }) => row);
    // A place's action that opens or shows something, needing nothing from a selected item ("secure address": Settings
    // on Secure address), found by its words: Enter runs it from the menu.
    const byAction = all.flatMap((row) => (row.place?.actions ?? [])
      .filter((action): action is PlaceCapabilityAction<PlaceItem> => action.kind !== 'program' && action.label !== undefined && has(action.label) && this.runsFromMenu(action))
      .map((action): MenuRow => ({ ...row, title: `${row.title}: ${action.label!}`, action })));
    const found = new Set([...byName, ...byTab, ...byAction].map((row) => row.group));
    const byLine = all.filter((row) => !found.has(row.group) && has(row.line));
    // An entry whose own name is the typed word comes first ("settings" opens Settings on Enter).
    const ownName = (row: MenuRow): string => (row.action?.label ?? (row.list ? row.title.slice(row.title.indexOf(': ') + 2) : row.title)).toLowerCase();
    const rows = [...byName, ...byTab, ...byAction, ...byLine];
    return [...rows.filter((row) => ownName(row) === typed), ...rows.filter((row) => ownName(row) !== typed)];
  }

  /**
   * An action the menu may run: one that needs no selected item (a place-wide action, one on a tab's kind of thing,
   * or one whose every filled input takes nothing from an item, `() => 'secure address'`), whether or not it changes
   * something; not an answer to a waiting item, not one that ends the program, and a control in this program.
   */
  private runsFromMenu(action: PlaceCapabilityAction<PlaceItem>): boolean {
    if (action.answers || action.answersItem) return false;
    if (ENDS_THE_PROGRAM.has(action.capability)) return false;
    if (action.programs !== undefined && this.asker.program !== undefined && !action.programs.includes(this.asker.program)) return false;
    const itemless = action.list === undefined || action.whole === true
      || Object.values(action.fill ?? {}).every((from) => typeof from === 'function' && from.length === 0);
    return itemless && this.placeHost.capability(action.capability) !== undefined;
  }

  /** Run at once from the menu: it changes nothing and every input it needs is filled (Settings opened at a section). */
  private runsAtOnce(action: PlaceCapabilityAction<PlaceItem>): boolean {
    const resolved = this.placeHost.capability(action.capability);
    if (!resolved || resolved.action.lasts !== 'not-a-change' || action.form === true) return false;
    const given = Object.keys(action.fill ?? {});
    return resolved.action.inputs.every((input) => input.required !== true || given.includes(input.id));
  }

  /** Run a place's action from the menu: the menu closes for what it opens, or says why it did not run. */
  private async runAction(action: PlaceCapabilityAction<PlaceItem>): Promise<void> {
    const none: PlaceItem = { id: '', state: '' };
    const values = Object.fromEntries(Object.entries(action.fill ?? {}).map(([input, from]) => [input, typeof from === 'function' ? from(none) : '']));
    const outcome = await this.placeHost.runCapability(action.capability, values);
    if (this.closed) return;
    if (!outcome.ok) { this.note = `Not done: ${outcome.reason}`; this.placeHost.requestRender(); return; }
    this.dismiss();
  }

  private open(row: MenuRow | undefined): void {
    if (!row) return;
    if (!row.place) { this.note = `${row.title} has no place in this program yet.`; return; }
    if (row.action && this.runsAtOnce(row.action)) { void this.runAction(row.action); return; }
    // An action that changes something, or asks for more: its place opens on its tab and it is pressed there, as its key
    // would be (its form, its question when it asks first, and the outcome on its tab).
    if (row.action) { this.placeHost.openPlace(row.place.id, { ...(row.action.list ? { list: row.action.list } : {}), action: placeActionName(row.action) }); return; }
    this.placeHost.openPlace(row.place.id, row.list ? { list: row.list } : undefined);
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
    const x0 = f.l + 1 + MODAL_MARK_INSET;
    const x1 = f.r - MODAL_MARK_INSET;
    // A tab's or an action's row ("Devices and network: secure address") may be longer than a group's name: the column
    // fits it whole while the row keeps room for a short count; the group's line gives way first.
    const titleWidth = Math.min(Math.max(...CAPABILITY_GROUPS.map((group) => group.title.length), ...rows.map((row) => row.title.length)) + 3, Math.max(10, x1 - x0 + 1 - 16));
    const kitRows: KitRow[] = rows.map((row, index) => {
      const count = row.place ? this.counts.get(row.place.id) : undefined;
      const right = count ? count.words : row.place ? '' : 'not here yet';
      // One row each: the line is cut to what is left beside the title and the count.
      const room = Math.max(0, x1 - x0 + 1 - titleWidth - (right ? right.length + 3 : 0));
      const line = row.line.length > room ? `${row.line.slice(0, Math.max(0, room - 1)).trimEnd()}…` : row.line;
      return {
        spans: [
          { text: (row.title.length > titleWidth - 2 ? `${row.title.slice(0, Math.max(0, titleWidth - 3))}…` : row.title).padEnd(titleWidth), fg: row.place ? t.text : t.textMuted, bold: index === this.selected },
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
