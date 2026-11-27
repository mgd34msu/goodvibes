import { completeArguments, type ArgumentCompletion } from './command-actions/completion.js';
import { readList, type ListRow } from './command-actions/lists.js';
import type { CommandDescription, ListName } from './command-actions/types.js';
import { isAcceptedCommandWord } from './command-registry.js';

export interface AutocompleteCommand {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[] | undefined;
  /** Set on a command built with defineCommand: completion continues past its name. */
  readonly described?: CommandDescription<never> | undefined;
}
export interface AutocompleteRegistry<Command extends AutocompleteCommand> {
  fuzzyMatch(query: string): AutocompleteResult<Command>[];
  get?(name: string): Command | undefined;
}
/**
 * Where completion reads a live list (the command context) and how it says the
 * rows arrived, so the dropdown is drawn again. Without it, completion stops at
 * action words, option names and fixed choices.
 */
export interface AutocompleteListSource {
  readonly context: () => unknown;
  readonly rowsArrived: () => void;
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
  /** Completion past a described command's name (actions, a blank's values, options); results are empty then. */
  argument?: ArgumentCompletion | undefined;
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

  /** Live list rows read for this dropdown, by list and earlier answers; cleared when the dropdown closes. */
  private listRows = new Map<string, readonly ListRow[] | 'reading'>();

  constructor(
    private readonly registry: AutocompleteRegistry<Command>,
    private readonly commonNames: ReadonlySet<string> = new Set(),
    private readonly lists?: AutocompleteListSource | undefined,
  ) {}

  /** Rows of a live list for completion: read once per open dropdown, in the background. */
  private readRows(list: ListName, earlier: Readonly<Record<string, string>>): readonly ListRow[] | undefined {
    const key = `${list}\u0000${JSON.stringify(earlier)}`;
    const held = this.listRows.get(key);
    if (held === 'reading') return undefined;
    if (held) return held;
    if (!this.lists) return [];
    const source = this.lists;
    // A read lands in the map of the dropdown it was started for; once that dropdown is reset, nothing reads it.
    const rowsMap = this.listRows;
    rowsMap.set(key, 'reading');
    void readList(list, source.context(), earlier).then(
      (rows) => { rowsMap.set(key, rows); },
      () => { rowsMap.set(key, []); },
    ).then(() => {
      if (this.listRows !== rowsMap) return;
      if (!this.state.active || !this.state.argument) return;
      this.update(this.state.query);
      source.rowsArrived();
    });
    return undefined;
  }

  /** The completion past a described command's name, or undefined. */
  private argumentCompletion(query: string): ArgumentCompletion | undefined {
    const space = query.indexOf(' ');
    if (space < 0) return undefined;
    const described = this.registry.get?.(query.slice(0, space))?.described;
    if (!described) return undefined;
    return completeArguments(described, query.slice(space + 1), (list, earlier) => this.readRows(list, earlier));
  }

  /**
   * update - Refresh the autocomplete results for the given query.
   * Activates the dropdown whenever query changes.
   */
  update(query: string): void {
    // A re-ranked list makes the old numeric index point at an unrelated command; only a repeat of the same query keeps the highlight.
    if (query !== this.state.query || !this.state.active) this.state.selectedIndex = 0;
    this.state.query = query;
    if (query.includes(' ')) {
      const argument = this.argumentCompletion(query);
      this.state.argument = argument;
      this.state.results = [];
      this.state.commonCount = 0;
      this.state.active = argument !== undefined;
      if (argument && this.state.selectedIndex >= argument.items.length) this.state.selectedIndex = Math.max(0, argument.items.length - 1);
      return;
    }
    this.state.argument = undefined;
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
    // An accepted word typed exactly (`/exit`) is what Enter runs: no fuzzy match is
    // highlighted over it, unless a command or alias has that very name.
    const exact = this.state.results.some(({ command }) => command.name === query || command.aliases?.includes(query) === true);
    if (isAcceptedCommandWord(query) && !exact) this.state.selectedIndex = -1;
    // An unlisted command typed in full (`/memory`) is never offered, and nothing offered is highlighted over it:
    // Enter runs the line as typed.
    if (!exact && query !== '' && this.registry.get?.(query) !== undefined) this.state.selectedIndex = -1;
  }

  /** Move selection down one item (wraps around). */
  moveDown(): void {
    const count = this.state.argument?.items.length ?? this.state.results.length;
    if (count === 0) return;
    this.state.selectedIndex = (this.state.selectedIndex + 1) % count;
  }

  /** Move selection up one item (wraps around). */
  moveUp(): void {
    const count = this.state.argument?.items.length ?? this.state.results.length;
    if (count === 0) return;
    this.state.selectedIndex = (Math.max(0, this.state.selectedIndex) - 1 + count) % count;
  }

  /**
   * The composer line with the highlighted argument completion put in place of
   * the word being typed, or undefined when the dropdown lists commands.
   */
  completeArgument(prompt: string): string | undefined {
    const argument = this.state.argument;
    const item = argument?.items[this.state.selectedIndex];
    if (!argument || !item) return undefined;
    const value = /\s/.test(item.value) ? JSON.stringify(item.value) : item.value;
    return `${prompt.slice(0, prompt.length - argument.partial.length)}${value} `;
  }

  /** Return the currently selected command, if any. */
  getSelected(): Command | undefined {
    const { results, selectedIndex } = this.state;
    return results[selectedIndex]?.command;
  }

  /** Reset autocomplete to inactive state. */
  reset(): void {
    this.listRows = new Map();
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
    if (this.state.argument) return this.state.active && (this.state.argument.items.length > 0 || this.state.argument.pending === true);
    return this.state.active && this.state.results.length > 0;
  }
}
