/**
 * SelectionModal - Generic reusable selection modal with fuzzy search.
 * Used by /template, /sessions, /bookmarks, /tools, and focused pickers.
 */

export interface SelectionItem {
  id: string;
  label: string;
  detail?: string;        // selected-item help above the list
  category?: string;      // optional grouping header
  actions?: string;       // hint text for available actions (e.g., "[d] delete")
  fg?: string;             // optional foreground color override for this item
  primaryAction?: SelectionAction; // default Enter/Space behavior for this row
  adjustable?: boolean;   // supports left/right adjustment without leaving the modal
  adjustStep?: number;    // base step for left/right adjustments
  adjustMin?: number;     // minimum numeric value when adjustable
  adjustMax?: number;     // maximum numeric value when adjustable
  adjustPrecision?: number; // decimal places to preserve for numeric adjustments
}

export type SelectionAction = 'select' | 'delete' | 'edit' | 'toggle' | 'increment' | 'decrement';

export interface SelectionResult {
  item: SelectionItem;
  action: SelectionAction;
  step?: number;
}

/** Options shared by the widget, terminal input owners and queued requests. */
export interface SelectionOpenOptions {
  customItem?: ((query: string) => SelectionItem | null) | undefined;
  preSelectId?: string | undefined;
  allowSearch?: boolean | undefined;
  customActions?: Map<string, SelectionAction> | undefined;
  primaryVerbLabel?: string | undefined;
  /** Live preview of the highlighted row. */
  onHighlight?: ((item: SelectionItem | null) => void) | undefined;
  /** Input owners cancel the exact queued/displayed picker with this signal. */
  signal?: AbortSignal | undefined;
}

export class SelectionModal {
  public active = false;
  public title = '';
  /** The always-live search row's query (fuzzy). Typing edits it directly; there is no search mode. */
  public query = '';
  public items: SelectionItem[] = [];
  public filteredItems: SelectionItem[] = [];
  public selectedIndex = 0;
  public contextScroll = 0;
  public allowSearch = true;
  private customItem: ((query: string) => SelectionItem | null) | undefined;
  get allowsCustomValue(): boolean { return this.customItem !== undefined; }
  public customActions: Map<string, SelectionAction> = new Map();
  /**
   * vocab unification: overrides the default per-primaryAction Enter
   * verb ("Select"/"Toggle"/"Edit"/"Delete") shown in the footer hint. Used by
   * callers whose items are really commands (e.g. /help) so the hint reads
   * "[Enter] Run", matching the slash-command palette's own verb, instead of
   * the generic "Select".
   */
  public primaryVerbLabel: string | undefined = undefined;
  /** Live-preview hook: called when the highlighted row changes (see open()). */
  private onHighlight: ((item: SelectionItem | null) => void) | undefined = undefined;
  private lastHighlightedId: string | null | undefined = undefined;

  /** Open the modal with items and title */
  open(
    title: string,
    items: SelectionItem[],
    opts?: SelectionOpenOptions
  ): void {
    this.title = title;
    this.items = items;
    this.customItem = opts?.customItem;
    this.query = '';
    this.contextScroll = 0;
    this.allowSearch = opts?.allowSearch ?? true;
    this.customActions = opts?.customActions ?? new Map();
    this.primaryVerbLabel = opts?.primaryVerbLabel;
    this.active = true;
    this.filterItems();

    // Pre-select by id if provided
    if (opts?.preSelectId) {
      const idx = this.filteredItems.findIndex(it => it.id === opts.preSelectId);
      this.selectedIndex = idx >= 0 ? idx : 0;
    } else {
      this.selectedIndex = 0;
    }
    this.onHighlight = opts?.onHighlight;
    this.lastHighlightedId = undefined;
    this.emitHighlight();
  }

  close(): void {
    this.customItem = undefined;
    this.onHighlight = undefined;
    this.lastHighlightedId = undefined;
    this.active = false;
    this.title = '';
    this.query = '';
    this.contextScroll = 0;
    this.items = [];
    this.filteredItems = [];
    this.selectedIndex = 0;
    this.customActions = new Map();
    this.primaryVerbLabel = undefined;
  }

  moveUp(): void {
    // Skip category headers (items with no id-based content, filtered items include only selectable ones)
    if (this.filteredItems.length === 0) return;
    this.selectedIndex = this.selectedIndex > 0
      ? this.selectedIndex - 1
      : this.filteredItems.length - 1;
    this.emitHighlight();
  }

  moveDown(): void {
    if (this.filteredItems.length === 0) return;
    this.selectedIndex = this.selectedIndex < this.filteredItems.length - 1
      ? this.selectedIndex + 1
      : 0;
    this.emitHighlight();
  }

  /** Update fuzzy search filter */
  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
    this.filterItems();
    this.emitHighlight();
  }

  /** Scroll help without moving the selected option. */
  scrollContext(delta: number): void {
    this.contextScroll = Math.max(0, this.contextScroll + delta);
  }

  /** Get currently highlighted item */
  getSelected(): SelectionItem | null {
    if (this.filteredItems.length === 0) return null;
    return this.filteredItems[this.selectedIndex] ?? null;
  }

  /** Notify onHighlight when the highlighted row differs from the last one reported. */
  private emitHighlight(): void {
    this.contextScroll = 0;
    if (!this.onHighlight) return;
    const item = this.getSelected();
    const id = item?.id ?? null;
    if (id === this.lastHighlightedId) return;
    this.lastHighlightedId = id;
    this.onHighlight(item);
  }

  /** Fuzzy match items against query, resets filteredItems */
  private filterItems(): void {
    if (this.query.length === 0) {
      this.filteredItems = this.items.slice();
      return;
    }

    const scored = this.items
      .map(item => ({ item, ...this.fuzzyMatch(this.query, item.label + ' ' + (item.detail ?? '') + ' ' + (item.category ?? '')) }))
      .filter(r => r.match)
      .sort((a, b) => b.score - a.score);

    this.filteredItems = scored.map(r => r.item);
    const custom = this.customItem?.(this.query.trim());
    if (custom && !this.filteredItems.some(item => item.id === custom.id)) this.filteredItems.push(custom);
    if (this.selectedIndex >= this.filteredItems.length) {
      this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
    }
  }

  /** Fuzzy match: does the query match the candidate? */
  private fuzzyMatch(query: string, candidate: string): { match: boolean; score: number } {
    if (query.length === 0) return { match: true, score: 0 };
    const lowerQuery = query.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();

    // Substring match (highest priority)
    const subIdx = lowerCandidate.indexOf(lowerQuery);
    if (subIdx !== -1) {
      return { match: true, score: 100 - subIdx };
    }

    // Character-by-character fuzzy match
    let qi = 0;
    let score = 0;
    for (let ci = 0; ci < lowerCandidate.length && qi < lowerQuery.length; ci++) {
      if (lowerCandidate[ci] === lowerQuery[qi]) {
        qi++;
        score += 1;
      }
    }
    if (qi === lowerQuery.length) {
      return { match: true, score };
    }
    return { match: false, score: 0 };
  }
}

/** Shared modal opener; products retain the composition that presents it. */
export type OpenSelection = (
  title: string,
  items: SelectionItem[],
  opts: SelectionOpenOptions | undefined,
  callback: (result: SelectionResult | null) => void,
) => void;
