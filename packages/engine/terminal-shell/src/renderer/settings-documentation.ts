import { getDisplayWidth } from '@goodvibes/engine/platform/platform/utils';
import { activeTokens } from './theme.js';
import { clipText, tailText, wrapLines } from './surface-kit.js';
export interface DocLine {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean | undefined;
}
/**
 * One line of settings help with its kind stated by the code that wrote it:
 * `fact` (faint; folded into the one facts row when `folded` is set, left out
 * when `onRow` because the selected row already shows it), `warning` (shown
 * first, in the warning color), `heading` (bold) or `text`. A blank `text`
 * line separates paragraphs.
 */
export interface HelpLine {
  readonly kind: 'fact' | 'warning' | 'heading' | 'text';
  readonly text: string;
  readonly folded?: string | undefined;
  readonly onRow?: boolean | undefined;
}

/** The plain text of help lines, for callers that print them. */
export function helpLineText(lines: readonly HelpLine[]): string[] {
  return lines.map((line) => line.text);
}

/** A prose line; '' separates paragraphs. */
export const helpText = (text: string): HelpLine => ({ kind: 'text', text });
/** A section title. */
export const helpHeading = (text: string): HelpLine => ({ kind: 'heading', text });
/** A constraint or confirmation, shown first in the warning color. */
export const helpWarning = (text: string): HelpLine => ({ kind: 'warning', text });
/** A `Label: value` fact; `folded` is its entry in the one facts row. */
export const helpFact = (label: string, value: string, folded?: string): HelpLine =>
  ({ kind: 'fact', text: `${label}: ${value}`, ...(folded === undefined ? {} : { folded }) });

export function fitValue(value: string, width: number, editing: boolean, label = ''): string {
  if (editing) return tailText(value, Math.max(8, width - getDisplayWidth(label) - 4));
  return clipText(value, Math.max(8, Math.floor(width * 0.45)));
}
/** Products supply documentation content; wrapping, fact folding and windowing have one implementation. */
export function createSettingsDocumentation<
  Modal extends {
    contextScroll?: number | undefined;
  },
>(
  context: (modal: Modal) => readonly HelpLine[],
  presentation: {
    readonly clampStoredOffset: boolean;
    readonly countIndicatorRow: boolean;
  },
) {
  function docLines(modal: Modal, hasSelection: boolean, width: number): DocLine[] {
    const t = activeTokens();
    // Every line states its kind; nothing is read from its wording.
    const source = context(modal);
    // With a selected row, the first line (its name) is already on the row.
    const lines = (hasSelection ? source.slice(1) : source).filter((line) => line.onRow !== true);
    const facts = lines.flatMap((line) => (line.kind === 'fact' && line.folded !== undefined ? [line.folded] : []));
    const rest = lines.filter((line) => !(line.kind === 'fact' && line.folded !== undefined));
    const out: DocLine[] = [];
    // Confirmations and constraints must be visible before optional metadata,
    // even when the help viewport is short. They remain outside the options.
    for (const line of rest.filter((line) => line.kind === 'warning'))
      for (const wrapped of wrapLines(line.text, width)) out.push({ text: wrapped, fg: t.warning });
    if (facts.length > 0) for (const wrapped of wrapLines(facts.join(' · '), width)) out.push({ text: wrapped, fg: t.textFaint });
    for (const line of rest) {
      if (line.kind === 'warning') continue;
      if (line.text === '') {
        if (out.length > 0 && out[out.length - 1]!.text !== '') out.push({ text: '', fg: t.textMuted });
        continue;
      }
      const bold = line.kind === 'heading';
      const fg = bold ? t.text : line.kind === 'fact' ? t.textFaint : t.textMuted;
      for (const wrapped of wrapLines(line.text, width)) out.push({ text: wrapped, fg, bold });
    }
    while (out.length > 0 && out[out.length - 1]!.text === '') out.pop();
    return out;
  }
  function settingsDocumentation(modal: Modal, width: number): string[] {
    return docLines(modal, false, width).map((line) => line.text);
  }
  function windowDoc(modal: Modal, lines: DocLine[], budget: number): DocLine[] {
    const t = activeTokens();
    if (lines.length <= budget) return lines;
    const maxOffset = Math.max(0, lines.length - budget);
    const offset = Math.max(0, Math.min(modal.contextScroll ?? 0, maxOffset));
    if (presentation.clampStoredOffset) modal.contextScroll = offset;
    const shown = lines.slice(offset, offset + budget);
    if (offset > 0) shown[0] = { text: `${offset + (presentation.countIndicatorRow ? 1 : 0)} more ↑ · pgup`, fg: t.textFaint };
    const below = lines.length - offset - budget;
    if (below > 0) shown[shown.length - 1] = { text: `${below + (presentation.countIndicatorRow ? 1 : 0)} more ↓ · pgdn`, fg: t.textFaint };
    return shown;
  }
  return { docLines, windowDoc, settingsDocumentation };
}
