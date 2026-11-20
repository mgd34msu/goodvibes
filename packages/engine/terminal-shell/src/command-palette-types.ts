/**
 * command-palette-types.ts, the shapes the command palette and its renderer
 * share (kept apart so the renderer never imports the modal it draws).
 */

export type PaletteGroup = 'Suggested' | 'Session' | 'Views' | 'Settings' | 'Commands' | 'Keyboard shortcuts';

export interface PaletteEntry {
  /** A command row: the command's primary name. A shortcut row: `key:<n>`, never run. */
  readonly id: string;
  /** A command to run, or a keyboard shortcut to read. */
  readonly kind: 'command' | 'shortcut';
  /** Human title for the row: the command's plain title, or what the key does. */
  readonly title: string;
  /** One sentence: what the command is for (the detail pane, and the narrow screen's line under the list). */
  readonly summary: string;
  readonly description: string;
  readonly category: string;
  readonly group: Exclude<PaletteGroup, 'Suggested'>;
  readonly aliases: readonly string[];
  /** Extra search words (former view names and the like). */
  readonly keywords: readonly string[];
  /** What the command can do, by its actions' labels (a described command); empty otherwise. */
  readonly actions: readonly string[];
  readonly argsHint?: string | undefined;
  /** True when the command has required arguments: Enter fills the composer. */
  readonly needsArgs: boolean;
  /** Right column: the slash command, or a shortcut's key. */
  readonly right: string;
  /** A row that runs a command with words already given (`/settings open permissions.mode`). */
  readonly line?: { readonly command: string; readonly args: readonly string[] } | undefined;
}

export type PaletteRunMode = 'run' | 'fill';

export interface PaletteSection {
  readonly group: PaletteGroup;
  readonly entries: readonly PaletteEntry[];
}

/** What the palette renderer reads from the palette. */
export interface PaletteView {
  readonly searching?: boolean;
  readonly query: string;
  readonly entries: readonly PaletteEntry[];
  sections(): PaletteSection[];
  flat(): PaletteEntry[];
  getSelected(): PaletteEntry | null;
  describe(id: string): string | undefined;
}

/** A titled group of keys, as an app's key table and fixed keys give them (key, what it does). */
export interface ShortcutGroup { readonly title: string; readonly items: ReadonlyArray<readonly [key: string, action: string]> }
