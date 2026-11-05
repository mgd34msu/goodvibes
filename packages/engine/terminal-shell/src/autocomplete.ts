export interface AutocompleteCommand { readonly name: string; readonly description: string }
export interface AutocompleteRegistry<Command extends AutocompleteCommand> {
  fuzzyMatch(query: string): AutocompleteResult<Command>[];
}
/**
 * AutocompleteResult - A ranked match from the command registry.
 */
export interface AutocompleteResult<Command extends AutocompleteCommand = AutocompleteCommand> {
  command: Command;
  score: number;
}

/**
 * AutocompleteState - All state for the autocomplete dropdown.
 * When `active` is false the dropdown is hidden.
 */
export interface AutocompleteState<Command extends AutocompleteCommand = AutocompleteCommand> {
  active: boolean;
  query: string;
  results: AutocompleteResult<Command>[];
  selectedIndex: number;
  /**
   * (item 4): how many leading entries of `results` belong to the
   * curated "common" tier, only meaningful when `query === ''` (0
   * otherwise, since a typed filter searches everything and the common/rest
   * split no longer applies). The renderer uses this to draw a separator
   * before the alphabetical rest.
   */
  commonCount: number;
}

/**
 * AutocompleteEngine - Manages autocomplete state for the slash command prompt.
 *
 * Usage:
 *   - Call `update(query)` whenever the partial command text changes.
 *   - Call `moveDown()` / `moveUp()` for arrow key navigation.
 *   - Call `getSelected()` to retrieve the currently highlighted command.
 *   - Call `reset()` on Escape or after a command executes.
 */
export class AutocompleteEngine<Command extends AutocompleteCommand = AutocompleteCommand> {
  private state: AutocompleteState<Command> = {
    active: false,
    query: '',
    results: [],
    selectedIndex: 0,
    commonCount: 0,
  };

  constructor(private readonly registry: AutocompleteRegistry<Command>, private readonly commonNames: ReadonlySet<string> = new Set()) {}

  /**
   * update - Refresh the autocomplete results for the given query.
   * Activates the dropdown whenever query changes.
   */
  update(query: string): void {
    this.state.query = query;
    this.state.results = this.registry.fuzzyMatch(query);
    this.state.active = true;
    // fuzzyMatch('') sorts the curated common tier first (score 2),
    // then the alphabetical rest (score 1), both tiers alphabetical within
    // themselves. Count the leading common run to tell the renderer where to
    // draw the separator. A non-empty query means every command was scored on
    // its actual match quality, not tier, so the common/rest split does not
    // apply, the resulting 0 is not a real answer to "how many are common"
    // and is unused because renderAutocompleteOverlay itself gates on the
    // query string too, but zeroing here keeps the field internally honest.
    let commonCount = 0;
    if (query === '') {
      for (const result of this.state.results) {
        if (!this.commonNames.has(result.command.name)) break;
        commonCount++;
      }
    }
    this.state.commonCount = commonCount;
    // Clamp selection to new result count
    if (this.state.selectedIndex >= this.state.results.length) {
      this.state.selectedIndex = Math.max(0, this.state.results.length - 1);
    }
  }

  /** Move selection down one item (wraps around). */
  moveDown(): void {
    if (this.state.results.length === 0) return;
    this.state.selectedIndex = (this.state.selectedIndex + 1) % this.state.results.length;
  }

  /** Move selection up one item (wraps around). */
  moveUp(): void {
    if (this.state.results.length === 0) return;
    this.state.selectedIndex =
      (this.state.selectedIndex - 1 + this.state.results.length) % this.state.results.length;
  }

  /** Return the currently selected command, if any. */
  getSelected(): Command | undefined {
    const { results, selectedIndex } = this.state;
    return results[selectedIndex]?.command;
  }

  /** Reset autocomplete to inactive state. */
  reset(): void {
    this.state = {
      active: false,
      query: '',
      results: [],
      selectedIndex: 0,
      commonCount: 0,
    };
  }

  /** Read-only snapshot of current state. */
  getState(): Readonly<AutocompleteState<Command>> {
    return this.state;
  }

  /**
   * isActive - True when the dropdown should be shown.
   */
  get isActive(): boolean {
    return this.state.active && this.state.results.length > 0;
  }
}
