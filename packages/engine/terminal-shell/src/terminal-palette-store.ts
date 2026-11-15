/**
 * terminal-palette.ts, the terminal's own colours as reported at startup.
 *
 * `TerminalPalette` mirrors the platform type of the same name (the theme engine's
 * input for "use the terminal's palette" themes). Keep the two shapes identical:
 * `background` from OSC 11, `foreground` from OSC 10, and `ansi[0..15]` from
 * OSC 4;N. Every value is `#rrggbb`; a slot the terminal did not answer is
 * `undefined`.
 *
 * The store beside the type holds the result of the startup probe
 * (terminal-palette-probe.ts). It stays `null` until the probe finishes
 * (all replies in, or the window closes). The terminal system theme is derived from the published palette.
 */

/** Mirrors the platform `TerminalPalette` type. `ansi` always has 16 entries. */
export type TerminalPalette = {
  background?: string | undefined;
  foreground?: string | undefined;
  ansi: Array<string | undefined>;
};

/** Number of ANSI palette slots queried (OSC 4;0 .. OSC 4;15). */
export const TERMINAL_PALETTE_ANSI_SLOTS = 16;

/** A palette with every slot unanswered. */
export function emptyTerminalPalette(): TerminalPalette {
  return { ansi: new Array<string | undefined>(TERMINAL_PALETTE_ANSI_SLOTS).fill(undefined) };
}

let probedPalette: TerminalPalette | null = null;

/**
 * The palette reported by the terminal at startup, or null when the probe has
 * not finished (or never ran: non-TTY). A finished probe with no replies yields
 * a palette whose slots are all undefined.
 */
export function getTerminalPalette(): TerminalPalette | null {
  return probedPalette;
}

/**
 * Record the probe result. Called by the probe once; whoever acts on it is
 * told through the probe's own `onTerminalPalette` option.
 */
export function setTerminalPalette(palette: TerminalPalette): void {
  probedPalette = palette;
}

/** Test hook: forget the stored palette. */
export function resetTerminalPaletteForTests(): void {
  probedPalette = null;
}
