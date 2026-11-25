import type {
  ConfigModalAction,
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from './config-modal-types.ts';
import type { ModalSectionStyle } from './config-modal-types.ts';
import { truncateDisplay, wrapText } from '../utils/terminal-width.ts';
import { actionKeyLabel, actionKeyText, chordHint } from './config-modal-keys.ts';

export type {
  ConfigModalAction,
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from './config-modal-types.ts';

/** A tab as the renderer sees it (structure frozen, label live). */
export interface ConfigModalRenderTab {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
}

/** A row as the renderer sees it: frozen identity, live label/value overlay. */
export interface ConfigModalRenderRow {
  readonly id: string;
  readonly label: string;
  readonly style?: ModalSectionStyle;
  readonly selected: boolean;
  readonly selectable: boolean;
  /** True when this frozen row has no live counterpart this tick (value went
   *  stale, kept in place, dimmed, until the next interaction boundary). */
  readonly stale: boolean;
  /** A group header row (see ConfigModalRow.header). */
  readonly header: boolean;
}

/** Everything renderConfigModal needs, computed by overlaying live values onto
 *  the frozen structure so layout stays stable between key presses. */
export interface ConfigModalRenderModel {
  readonly title: string;
  readonly tabs: readonly ConfigModalRenderTab[];
  readonly header: readonly string[];
  readonly rows: readonly ConfigModalRenderRow[];
  readonly emptyText?: string;
  readonly degraded?: string;
  readonly status?: string;
  /** True while a destructive action waits for its second key press. */
  readonly confirmPending: boolean;
  /** Surface, tab and action hints as "key action" strings (the renderer draws keycaps). */
  readonly hints: readonly string[];
  readonly scroll: { readonly offset: number; readonly total: number; readonly visible: number };
  /** The always-live search row: the query and a truthful match count over the active tab's selectable rows. */
  readonly search: { readonly query: string; readonly matched: number; readonly total: number };
  /** The rows are drawn with every row of the frame: no search row, blank rows or status (ConfigModalView.whole). */
  readonly whole: boolean;
}

const DEFAULT_VISIBLE_ROWS = 10;

/**
 * Default label wrap width for getRenderModel() callers that don't pass one
 * (tests, mainly). renderConfigModal()
 * itself always computes and passes the ACTUAL width for the current
 * terminal size, this constant only matters when getRenderModel() is
 * called directly without going through the renderer.
 */
const DEFAULT_LABEL_WRAP_WIDTH = 70;

/**
 * Stable id for the synthesized "no matches" row item 1 injects when a
 * filter query excludes every selectable row in a tab. Non-selectable (info
 * rows are never filtered, see ConfigModal's filter doc) so this id can
 * never collide with a real surface row id.
 */
const FILTER_NO_MATCH_ROW_ID = '__config_modal_filter_no_match__';


/**
 * ConfigModal, the single, generic, named config-modal host. One instance
 * lives on the InputHandler (like `settingsModal`); it renders whatever
 * `ConfigModalSurface` is currently open. Key routing is a single
 * `handleConfigModalToken` path (handler-modal-routes.ts), no parallel input
 * system. See config-modal-types.ts for the surface contract and the liveness
 * doctrine this class enforces.
 */
export class ConfigModal {
  public active = false;

  private surface: ConfigModalSurface | null = null;
  private requestRender: () => void = () => {};

  /** Active tab / selected row tracked by STABLE id (survives value refresh). */
  private activeTabId = '';
  private selectedRowId = '';

  /** Transient status line (action result, error, or confirm prompt). */
  private statusMessage = '';
  /** Pending destructive confirm: the action key awaiting a second press. */
  private pendingConfirmKey: string | null = null;
  /** The row (tab and row id) the pending confirm was armed on: the second press acts only on that row. */
  private pendingConfirmRow: string | null = null;
  /** True after the leader chord (Ctrl+G): the next typed key is an action key, not search text. */
  private leaderArmed = false;
  /**
   * One `buildView()` per render and per key: inside a pass every read of the
   * live view (structure sync, value overlay, selected row, hints, counts)
   * shares the view built first. A surface's view may read stores from disk.
   */
  private inPass = false;
  private passView: ConfigModalView | null | undefined = undefined;

  /**
   * The always-live search row. Every printable key the modal receives is
   * typed here; actions fire from Enter or a Ctrl/Alt chord
   * (handleConfigModalToken), so a search never fires one. The query
   * is the TEXT-CAPTURE buffer itself (a multi-char paste token appends in
   * one shot). Filtering only ever narrows the ACTIVE tab's rows and is reset
   * on tab switch (a query typed against one tab's rows has no defined
   * meaning against another's). Esc never clears it as a separate step: Esc
   * cancels an armed destructive confirm first, otherwise it closes.
   */
  private filterQuery = '';

  /**
   * Structure captured at the last interaction boundary (open / key press) or
   * the last change of the rows themselves. Renders overlay live values onto
   * THIS; when the rows change, it is captured again with the selection kept by id.
   */
  private frozenView: ConfigModalView | null = null;

  private scrollOffset = 0;
  /** The label wrap width of the last render, so scrolling can count wrapped lines. */
  private lastWrapWidth = DEFAULT_LABEL_WRAP_WIDTH;
  private visibleRows = DEFAULT_VISIBLE_ROWS;

  /**
   * False until the first token reaches the open modal. While false, renders
   * may re-sync structure so an async onOpen load replaces the "Loading…"
   * placeholder WITHOUT requiring a keypress; the freeze-to-interaction-
   * boundary rule protects a cursor the user has engaged, and before the
   * first interaction there is nothing to protect (refutation finding 3).
   */
  private interactedSinceOpen = false;

  /** Whether the current surface has been given `onOpen` without a matching `onClose` yet. */
  private surfaceOpened = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  open(surface: ConfigModalSurface, requestRender: () => void = () => {}): void {
    // Opening over a surface that is still open (another surface, or the same one again)
    // closes it first, so every onOpen is matched by exactly one onClose.
    this.releaseSurface();
    this.surface = surface;
    this.requestRender = requestRender;
    this.active = true;
    this.statusMessage = '';
    this.pendingConfirmKey = null;
    this.leaderArmed = false;
    this.scrollOffset = 0;
    this.filterQuery = '';
    this.interactedSinceOpen = false;
    // No tab is shown yet: the first view is built for none, then its first tab is shown.
    this.activeTabId = '';
    const view = this._readView(surface)!;
    this.frozenView = view;
    this.activeTabId = view.tabs[0]?.id ?? '';
    this.selectedRowId = this._firstSelectableId(this._frozenTab());
    this.surfaceOpened = true;
    surface.onOpen?.(requestRender);
  }

  /** Run `onClose` for a surface that was opened and not yet closed. */
  private releaseSurface(): void {
    if (!this.surfaceOpened) return;
    this.surfaceOpened = false;
    this.surface?.onClose?.();
  }

  close(): void {
    if (!this.active) return;
    this.releaseSurface();
    this.active = false;
    this.surface = null;
    this.frozenView = null;
    this.statusMessage = '';
    this.pendingConfirmKey = null;
    this.leaderArmed = false;
    this.filterQuery = '';
  }

  /** Re-activate the current surface after a nested modal closes (Esc stack). */
  reopen(): void {
    if (!this.surface) return;
    // The surface may still hold what its last onOpen set up (the host never closed it
    // while a nested modal was on top); release it so the new onOpen does not double up.
    this.releaseSurface();
    this.active = true;
    this.syncStructure();
    this.surfaceOpened = true;
    this.surface.onOpen?.(this.requestRender);
  }

  getSurfaceName(): string | null {
    return this.surface?.name ?? null;
  }

  setViewportRows(rows: number): void {
    this.visibleRows = Math.max(3, rows);
    this.surface?.onViewportRows?.(this.visibleRows);
    this._clampScroll();
  }

  // ── Interaction boundary ────────────────────────────────────────────────────

  /** Token router calls this for every token the open modal receives. */
  noteInteraction(): void {
    this.interactedSinceOpen = true;
  }

  /**
   * Re-capture the structure from the current live view. Called on every key
   * press, and by a render when the live rows differ from the captured ones
   * (before the first interaction it syncs on every render so async loads paint).
   * Selection + active tab are preserved by id and clamped if their target
   * vanished.
   */
  syncStructure(): void {
    if (!this.surface) return;
    const view = this._applyFilter(this._readView()!);
    this.frozenView = view;
    if (!view.tabs.some((t) => t.id === this.activeTabId)) {
      this.activeTabId = view.tabs[0]?.id ?? '';
    }
    const tab = this._frozenTab();
    if (!this._selectableIds(tab).includes(this.selectedRowId)) {
      this.selectedRowId = this._firstSelectableId(tab);
    }
    this._clampScroll();
  }

  // ── Search row (each mutation is an interaction boundary) ─────────────────

  /** True while the search row holds a query. */
  isFilterActive(): boolean {
    return this.filterQuery.length > 0;
  }

  getFilterQuery(): string {
    return this.filterQuery;
  }

  /**
   * Append text to the query, the WHOLE token value in one call, so a
   * multi-char paste token lands in the filter atomically rather than being
   * split into per-char nav/action dispatch.
   */
  appendFilterText(text: string): void {
    if (text.length === 0) return;
    this._clearConfirm();
    this.filterQuery += text;
    this.syncStructure();
  }

  backspaceFilter(): void {
    if (this.filterQuery.length === 0) return;
    this.filterQuery = this.filterQuery.slice(0, -1);
    this.syncStructure();
  }

  /** True while a destructive action waits for its second key press. */
  hasPendingConfirm(): boolean {
    return this.pendingConfirmKey !== null;
  }

  /**
   * Esc's first level inside the modal: an armed destructive confirm is a
   * sub-state of the modal, so Esc cancels it (returns true) before a second
   * Esc closes the modal. Returns false when nothing was armed.
   */
  cancelPendingConfirm(): boolean {
    if (this.leaderArmed) {
      this.disarmLeader();
      return true;
    }
    if (this.pendingConfirmKey === null) return false;
    this._clearConfirm();
    return true;
  }

  /** The leader chord was pressed: the next typed key names an action. */
  armLeader(): void {
    this.leaderArmed = true;
    this.statusMessage = 'Press an action key (Esc cancels).';
  }

  /** True once (and disarms) when the leader is armed: the caller treats this key as an action key. */
  takeLeader(): boolean {
    if (!this.leaderArmed) return false;
    this.leaderArmed = false;
    if (this.statusMessage === 'Press an action key (Esc cancels).') this.statusMessage = '';
    return true;
  }

  /** Drop an armed leader without firing anything. */
  disarmLeader(): void {
    if (!this.leaderArmed) return;
    this.leaderArmed = false;
    this.statusMessage = '';
  }

  /** Say that a key names no action here, so a leader press is never silently swallowed. */
  noteUnboundAction(key: string): void {
    this.statusMessage = `No action on ${actionKeyText(key)} here.`;
  }

  // ── Navigation (each is an interaction boundary) ────────────────────────────

  moveDown(): void {
    this._clearConfirm();
    this.syncStructure();
    const ids = this._selectableIds(this._frozenTab());
    if (ids.length === 0) {
      // A tab of informational rows only (pairing, planning): the arrows
      // scroll it instead, so nothing below the fold is out of reach.
      this.scrollOffset++;
      this._clampScroll();
      return;
    }
    const i = ids.indexOf(this.selectedRowId);
    this.selectedRowId = ids[(i + 1) % ids.length]!;
    this._clampScroll();
  }

  moveUp(): void {
    this._clearConfirm();
    this.syncStructure();
    const ids = this._selectableIds(this._frozenTab());
    if (ids.length === 0) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this._clampScroll();
      return;
    }
    const i = ids.indexOf(this.selectedRowId);
    this.selectedRowId = ids[(i - 1 + ids.length) % ids.length]!;
    this._clampScroll();
  }

  nextTab(): void {
    this._switchTab(1);
  }

  prevTab(): void {
    this._switchTab(-1);
  }

  private _switchTab(dir: 1 | -1): void {
    this._clearConfirm();
    // A filter query is scoped to the tab it was typed against, switching
    // tabs resets it, same as statusMessage below.
    this.filterQuery = '';
    this.syncStructure();
    const tabs = this.frozenView?.tabs ?? [];
    if (tabs.length <= 1) return;
    const i = tabs.findIndex((t) => t.id === this.activeTabId);
    const next = tabs[(i + dir + tabs.length) % tabs.length]!;
    this.activeTabId = next.id;
    this.selectedRowId = this._firstSelectableId(next);
    this.scrollOffset = 0;
    this.statusMessage = '';
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  /** The action bound to `key` on the active tab/row, if enabled. */
  resolveAction(key: string): ConfigModalAction | null {
    const actions = this.surface?.actions ?? [];
    const row = this.getSelectedRow();
    for (const action of actions) {
      if (action.key !== key) continue;
      if (action.enabledFor && !action.enabledFor(row, this.activeTabId)) return null;
      return action;
    }
    return null;
  }

  /**
   * The letters this screen takes after the leader, for the selected row now:
   * each single-character action key that `resolveAction` gives, as the leader
   * strip shows a key (`d`, `shift+d`), with the action's label.
   */
  leaderKeys(): readonly (readonly [key: string, label: string])[] {
    const seen = new Set<string>();
    const keys: (readonly [string, string])[] = [];
    for (const { key } of this.surface?.actions ?? []) {
      if ([...key].length !== 1 || seen.has(key)) continue;
      seen.add(key);
      const action = this.resolveAction(key);
      if (!action) continue;
      keys.push([/^[A-Z]$/.test(key) ? `shift+${key.toLowerCase()}` : key, action.label]);
    }
    return keys;
  }

  /**
   * Attempt to fire the action bound to `key`. Returns true if a key was an
   * action (consumed). Handles the two-press confirm for destructive actions.
   * This is an interaction boundary (syncs structure first).
   */
  fireAction(key: string, ctx: Omit<ConfigModalActionContext, 'row' | 'tabId' | 'setStatus' | 'close' | 'requestRender' | 'jumpToRow'>): boolean {
    const resolved = this._pass(() => {
      this.syncStructure();
      const action = this.resolveAction(key);
      return action ? { action, row: this.getSelectedRow() } : null;
    });
    if (!resolved) return false;
    const { action, row } = resolved;
    const rowRef = `${this.activeTabId}\0${row?.id ?? ''}`;
    if (action.confirm && (this.pendingConfirmKey !== key || this.pendingConfirmRow !== rowRef)) {
      // A second press confirms only the row the first was on; a refreshed or moved selection asks again.
      const moved = this.pendingConfirmKey === key;
      this.pendingConfirmKey = key;
      this.pendingConfirmRow = rowRef;
      this.statusMessage = moved
        ? `The selected row changed since you pressed ${actionKeyText(key)}${row ? ` (now ${row.label})` : ''}. Press ${actionKeyText(key)} again to ${action.label} this one.`
        : `Press ${actionKeyText(key)} again to ${action.label}.`;
      return true;
    }
    this._clearConfirm();
    const fullCtx: ConfigModalActionContext = {
      row,
      tabId: this.activeTabId,
      print: ctx.print,
      executeCommand: ctx.executeCommand,
      openModal: ctx.openModal,
      submitInput: ctx.submitInput,
      requestRender: this.requestRender,
      setStatus: (m: string) => { this.statusMessage = m; },
      close: () => this.close(),
      jumpToRow: (tabId: string, rowId: string) => this.jumpToRow(tabId, rowId),
    };
    this.surface?.onAction?.(action.id, fullCtx);
    return true;
  }

  /**
   * In-surface "jump": switch the active tab (by id) and select a specific
   * row (by id) within it, the mechanism a surface's own action handler
   * uses to move the user from one tab to a specific row in another (e.g.
   * the Memory modal's Proposals tab jumping to an affected record in the
   * Review Queue tab). An interaction boundary (re-syncs structure first,
   * same as `_switchTab`). A no-op if either id is absent from the
   * freshly-synced structure.
   */
  jumpToRow(tabId: string, rowId: string): void {
    this._clearConfirm();
    this.filterQuery = '';
    this.syncStructure();
    const tab = this.frozenView?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!tab.rows.some((r) => r.id === rowId && r.selectable !== false)) return;
    this.activeTabId = tabId;
    this.selectedRowId = rowId;
    this.scrollOffset = 0;
    this.statusMessage = '';
    this._clampScroll();
  }

  /** Clear a pending confirm when the user navigates or presses an unrelated key. */
  clearConfirmOnMiss(): void {
    this._clearConfirm();
  }

  // ── Read accessors (for the renderer + tests) ───────────────────────────────

  getSelectedRow(): ConfigModalRow | null {
    const tab = this._liveTab(this.activeTabId) ?? this._frozenTab();
    return tab?.rows.find((r) => r.id === this.selectedRowId) ?? null;
  }

  getActiveTabId(): string {
    return this.activeTabId;
  }

  getSelectedRowId(): string {
    return this.selectedRowId;
  }

  getStatusMessage(): string {
    return this.statusMessage;
  }

  /**
   * Compute the render model: frozen structure + live value overlay. It syncs
   * structure only when the rows themselves changed, so calling it repeatedly
   * with only value mutations yields byte-identical layout (the liveness contract).
   *
   * `labelWrapWidth` is the wrap column the kit list uses for row labels
   * (renderConfigModal computes and passes the real one for the current
   * terminal size). It exists so the wrap-clamp below can pre-empt a live
   * label growing past that wrap width
   * mid-tick, a structural change (an extra visible line) without an
   * interaction, by measuring wrapped line counts here, before the label
   * ever reaches the renderer.
   */
  getRenderModel(labelWrapWidth: number = DEFAULT_LABEL_WRAP_WIDTH): ConfigModalRenderModel {
    return this._pass(() => this._renderModel(labelWrapWidth));
  }

  private _renderModel(labelWrapWidth: number): ConfigModalRenderModel {
    // Pre-first-interaction: async onOpen loads may restructure freely (the
    // user hasn't engaged a cursor yet), sync so "Loading…" is replaced by
    // real content on the load's own requestRender, not the next keypress.
    const widthChanged = this.lastWrapWidth !== labelWrapWidth;
    this.lastWrapWidth = labelWrapWidth;
    if (this.active && (!this.interactedSinceOpen || (widthChanged && this.frozenView?.scrollInformationalLines))) this.syncStructure();
    const live = this._readView();
    if (live && live.bindingIdentity !== this.frozenView?.bindingIdentity) {
      this.frozenView = this._applyFilter(live);
      this.statusMessage = ''; this.pendingConfirmKey = null; this.scrollOffset = 0;
      this.selectedRowId = '';
    } else if (this.active && live && this._structureMoved(this._applyFilter(live))) {
      // The data changed under an engaged cursor: show it now, with no key. Rows are matched
      // by id, so the selection stays on the same row; a confirm armed on a row that went away
      // is dropped rather than moved onto another one.
      const selected = this.selectedRowId;
      this.syncStructure();
      if (this.selectedRowId !== selected) this._clearConfirm();
    }
    const frozen = this.frozenView;
    if (!frozen) {
      return { title: '', tabs: [], header: [], rows: [], hints: [], confirmPending: false, scroll: { offset: 0, total: 0, visible: this.visibleRows }, search: { query: this.filterQuery, matched: 0, total: 0 }, whole: false };
    }

    const tabs: ConfigModalRenderTab[] = frozen.tabs.map((ft) => {
      const lt = live?.tabs.find((t) => t.id === ft.id);
      return { id: ft.id, label: lt?.label ?? ft.label, active: ft.id === this.activeTabId };
    });

    const frozenTab = frozen.tabs.find((t) => t.id === this.activeTabId) ?? frozen.tabs[0];
    const liveTab = live?.tabs.find((t) => t.id === this.activeTabId);

    // Header: all-or-nothing live overlay. Same line count → use live values;
    // a count change is a structural change, synced above.
    const frozenHeader = frozenTab?.header ?? [];
    const liveHeader = liveTab?.header ?? [];
    const header = liveHeader.length === frozenHeader.length ? liveHeader : frozenHeader;

    // Rows: iterate the frozen id order; overlay the live row (value refresh) by
    // id, or keep the frozen row marked stale when its live counterpart is gone.
    const frozenRows = frozenTab?.rows ?? [];
    const allRows: ConfigModalRenderRow[] = frozenRows.map((fr) => {
      const lr = liveTab?.rows.find((r) => r.id === fr.id);
      const src = lr ?? fr;
      return {
        id: fr.id,
        label: this._clampRowLabel(fr.label, src.label, labelWrapWidth),
        style: src.style,
        selected: fr.id === this.selectedRowId,
        selectable: fr.selectable !== false && fr.header !== true,
        stale: lr === undefined,
        header: fr.header === true,
      };
    });

    const visible = this.visibleRows;
    const windowed = this._windowRowsByLineBudget(allRows, this.scrollOffset, visible, labelWrapWidth);

    // The search row is always live, so the surface, tab and action hints
    // always show; Esc sits on the title row as a keycap, not in the hints.
    const hints = [
      ...(frozen.hints ?? []),
      ...(frozenTab?.hints ?? []),
    ].map(chordHint).concat(this._actionHints());
    const unfilteredTab = this._readView()?.tabs.find((t) => t.id === this.activeTabId);
    const countSelectable = (rows: readonly ConfigModalRow[] | undefined): number =>
      (rows ?? []).filter((r) => r.selectable !== false && r.header !== true).length;

    return {
      title: live?.title ?? frozen.title,
      tabs,
      header,
      rows: windowed,
      emptyText: frozenRows.length === 0 ? (frozenTab?.emptyText ?? 'Nothing to show.') : undefined,
      degraded: live?.degraded ?? frozen.degraded,
      status: this.statusMessage || undefined,
      confirmPending: this.pendingConfirmKey !== null,
      hints,
      scroll: { offset: this.scrollOffset, total: allRows.length, visible },
      search: {
        query: this.filterQuery,
        matched: countSelectable(frozenRows),
        total: countSelectable(unfilteredTab?.rows),
      },
      whole: (live ?? frozen).whole === true,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /**
   * item 2 (wrap-clamp overlay): keep a live label within the FROZEN
   * row's line footprint until the next interaction boundary re-freezes it.
   * `frozenLabel` is what the row wrapped to when the structure was captured
   * (open/nav/filter keystroke); `liveLabel` is this tick's value. If the
   * live label would wrap into MORE lines than the frozen one, that is a
   * structural change (an extra visible row) happening without a keypress,
   * exactly the hazard this closes. Clamp to the frozen line count, ellipsis
   * on the last line to signal truncation; a live label that wraps to the
   * SAME or FEWER lines passes through untouched (not the documented hazard).
   * Identical strings short-circuit (the common per-tick case: unchanged or
   * non-selected/stale rows) without doing any wrap work.
   */
  private _clampRowLabel(frozenLabel: string, liveLabel: string, width: number): string {
    if (liveLabel === frozenLabel) return liveLabel;
    const frozenLineCount = Math.max(1, wrapText(frozenLabel, width).length);
    const liveLines = wrapText(liveLabel, width);
    if (liveLines.length <= frozenLineCount) return liveLabel;
    const clamped = liveLines.slice(0, frozenLineCount);
    const lastIdx = clamped.length - 1;
    clamped[lastIdx] = `${truncateDisplay(clamped[lastIdx]!, Math.max(1, width - 1))}…`;
    return clamped.join('\n');
  }

  /**
   * Modal sizing rule (owner, zero tolerance: a modal/list must never clip
   * its full descriptive text, size to content or scroll, never clip).
   * `scrollOffset`/`visible` are ROW-count based, which is exactly right when
   * every row wraps to one line, but the kit list renders each row's WRAPPED
   * lines inside a fixed list height (renderConfigModal passes that height
   * to setViewportRows). A
   * row whose label wraps to MULTIPLE lines can therefore push the total past
   * that budget, and the LAST row handed to the renderer gets cut off
   * mid-line instead of being deferred to the next scroll page, the
   * clipping hazard this closes.
   *
   * Windows `rows` starting at `scrollOffset`, greedily including whole rows
   * while their CUMULATIVE wrapped-line count (at `wrapWidth`) stays within
   * the `visible` line budget. Always includes at least the first candidate
   * row so the view is never empty, a single row that alone exceeds the
   * budget is shown in full rather than replaced with nothing; only a
   * SUBSEQUENT row that would overflow is deferred to scrolling instead of
   * being rendered partially.
   */
  private _windowRowsByLineBudget(
    rows: readonly ConfigModalRenderRow[],
    scrollOffset: number,
    visible: number,
    wrapWidth: number,
  ): ConfigModalRenderRow[] {
    const candidates = rows.slice(scrollOffset);
    const out: ConfigModalRenderRow[] = [];
    let usedLines = 0;
    for (const row of candidates) {
      const lineCount = Math.max(1, wrapText(row.label, wrapWidth).length);
      if (out.length > 0 && usedLines + lineCount > visible) break;
      out.push(row);
      usedLines += lineCount;
    }
    return out;
  }

  /** Native read-only facts opt in; ordinary selectable/legacy rows stay unchanged. */
  private _readView(surface: ConfigModalSurface | null = this.surface): ConfigModalView | null {
    if (!surface) return null;
    const shared = this.inPass && surface === this.surface;
    if (shared && this.passView !== undefined) return this.passView;
    const view = this._expandView(surface.buildView(surface === this.surface && this.activeTabId !== '' ? this.activeTabId : undefined));
    if (shared) this.passView = view;
    return view;
  }

  /** Run `body` as one pass: the live view is built at most once inside it. */
  private _pass<T>(body: () => T): T {
    if (this.inPass) return body();
    this.inPass = true;
    try {
      return body();
    } finally {
      this.inPass = false;
      this.passView = undefined;
    }
  }

  private _expandView(view: ConfigModalView): ConfigModalView {
    if (!view.scrollInformationalLines) return view;
    return { ...view, tabs: view.tabs.map(tab => ({ ...tab, rows: tab.rows.flatMap(row =>
      row.selectable === false && !row.header
        ? wrapText(row.label, Math.max(1, this.lastWrapWidth)).map((label, index) => ({ ...row, id: `${row.id}:line:${index}`, label }))
        : [row],
    ) })) };
  }

  /** Apply the active filter query to every tab's rows. A no-op passthrough when not filtering. */
  private _applyFilter(view: ConfigModalView): ConfigModalView {
    if (this.filterQuery === '') return view;
    const query = this.filterQuery.toLowerCase();
    return { ...view, tabs: view.tabs.map((tab) => this._filterTab(tab, query)) };
  }

  /**
   * Narrow one tab's rows to those matching `query` (case-insensitive
   * substring on the label). Non-selectable rows (section titles, honest
   * empty-state copy, warning banners) always pass through unfiltered,
   * they're context, not data. When the query excludes every selectable row
   * but the tab genuinely had some, append the honest "no rows match" line
   * (item 1's empty-result case) instead of silently showing nothing
   * or misleadingly falling back to the surface's own emptyText (which
   * describes "no data at all", not "no data matches your filter").
   */
  private _filterTab(tab: ConfigModalTab, query: string): ConfigModalTab {
    const kept = tab.rows.filter((r) => r.selectable === false || r.header === true || r.label.toLowerCase().includes(query));
    const hadSelectable = tab.rows.some((r) => r.selectable !== false && r.header !== true);
    const stillMatched = kept.some((r) => r.selectable !== false && r.header !== true);
    if (hadSelectable && !stillMatched) {
      return {
        ...tab,
        rows: [...kept, { id: FILTER_NO_MATCH_ROW_ID, label: `No rows match "${this.filterQuery}".`, selectable: false }],
      };
    }
    return { ...tab, rows: kept };
  }

  private _actionHints(): string[] {
    const actions = this.surface?.actions ?? [];
    const row = this.getSelectedRow();
    const out: string[] = [];
    for (const a of actions) {
      if (a.enabledFor && !a.enabledFor(row, this.activeTabId)) continue;
      out.push(`${actionKeyLabel(a.key)} ${a.label}`);
    }
    return out;
  }

  private _clearConfirm(): void {
    if (this.pendingConfirmKey !== null) {
      this.pendingConfirmKey = null;
      this.statusMessage = '';
    }
  }

  /** The live view (filtered as shown) has other tabs, other rows on this tab, or another header height. */
  private _structureMoved(live: ConfigModalView): boolean {
    const frozen = this.frozenView;
    if (!frozen) return true;
    if (frozen.tabs.length !== live.tabs.length || frozen.tabs.some((tab, i) => tab.id !== live.tabs[i]?.id)) return true;
    const frozenTab = this._frozenTab();
    const liveTab = live.tabs.find((t) => t.id === frozenTab?.id);
    if (!frozenTab || !liveTab) return frozenTab !== liveTab;
    if ((frozenTab.header?.length ?? 0) !== (liveTab.header?.length ?? 0)) return true;
    return frozenTab.rows.length !== liveTab.rows.length || frozenTab.rows.some((row, i) => row.id !== liveTab.rows[i]?.id);
  }

  private _frozenTab(): ConfigModalTab | undefined {
    return this.frozenView?.tabs.find((t) => t.id === this.activeTabId) ?? this.frozenView?.tabs[0];
  }

  private _liveTab(id: string): ConfigModalTab | undefined {
    return this._readView()?.tabs.find((t) => t.id === id);
  }

  private _selectableIds(tab: ConfigModalTab | undefined): string[] {
    return (tab?.rows ?? []).filter((r) => r.selectable !== false && r.header !== true).map((r) => r.id);
  }

  private _firstSelectableId(tab: ConfigModalTab | undefined): string {
    return this._selectableIds(tab)[0] ?? '';
  }

  /**
   * Keep the selected row inside the visible line budget and never scroll
   * past the point where the last rows fill the list. Counts wrapped lines
   * (at the last render's wrap width), matching _windowRowsByLineBudget.
   */
  private _clampScroll(): void {
    const tab = this._frozenTab();
    const rows = tab?.rows ?? [];
    const lines = rows.map((r) => Math.max(1, wrapText(r.label, this.lastWrapWidth).length));
    const span = (from: number, to: number): number => {
      let n = 0;
      for (let k = from; k <= to; k++) n += lines[k] ?? 0;
      return n;
    };
    const visible = Math.max(3, this.visibleRows);
    const idx = rows.findIndex((r) => r.id === this.selectedRowId);
    if (idx >= 0) {
      if (idx < this.scrollOffset) this.scrollOffset = idx;
      while (this.scrollOffset < idx && span(this.scrollOffset, idx) > visible) this.scrollOffset++;
    }
    let maxOffset = rows.length;
    while (maxOffset > 0 && span(maxOffset - 1, rows.length - 1) <= visible) maxOffset--;
    // Informational rows before the first or after the last selectable row
    // would otherwise never scroll into view: selecting the first selectable
    // row shows the rows above it, the last one shows the rows below it.
    const selectable = rows.map((r, k) => (r.selectable !== false && r.header !== true ? k : -1)).filter((k) => k >= 0);
    if (idx >= 0 && idx === selectable[selectable.length - 1]) {
      this.scrollOffset = Math.max(this.scrollOffset, Math.min(maxOffset, idx));
    }
    if (idx >= 0 && idx === selectable[0] && span(0, idx) <= visible) this.scrollOffset = 0;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }

}
