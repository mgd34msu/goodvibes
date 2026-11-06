import { getDisplayWidth } from '@goodvibes-jev/engine/sdk/platform/utils';
import { activeTokens } from './theme.js';
import { clipText, tailText, wrapLines } from './surface-kit.js';
export interface DocLine {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean | undefined;
}
const FACT_PREFIXES = [
  'Key:',
  'Current:',
  'Default:',
  'Type:',
  'Source:',
  'Feature:',
  'Setting:',
  'Applies:',
  'Connection:',
  'Role:',
  'Trust mode:',
  'State:',
  'Active route:',
  'Preferred route:',
  'OAuth configured:',
  'Freshness:',
  'Expires:',
];
const WARN_PREFIXES = [
  'Locked:',
  'Conflict:',
  'Pending restart:',
  'Not available in this build:',
  'Confirmation required:',
  'Kill reason:',
  'Secret handling:',
];
const FOLDED_FACTS: ReadonlyArray<readonly [string, (value: string) => string]> = [
  ['Key: ', (v) => v],
  ['Default: ', (v) => `default ${v}`],
  ['Type: ', (v) => v],
  ['Source: ', (v) => `source ${v}`],
];
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
  context: (modal: Modal) => readonly string[],
  presentation: {
    readonly clampStoredOffset: boolean;
    readonly countIndicatorRow: boolean;
  },
) {
  function docLines(modal: Modal, hasSelection: boolean, width: number): DocLine[] {
    const t = activeTokens();
    const source = context(modal);
    // With a selected row, the first line (its name) is already on the row.
    const lines = hasSelection ? source.slice(1) : source;
    const facts: string[] = [];
    const rest: string[] = [];
    for (const line of lines) {
      if (line.startsWith('Current: ')) continue;
      const fact = FOLDED_FACTS.find(([prefix]) => line.startsWith(prefix));
      if (fact) facts.push(fact[1](line.slice(fact[0].length)));
      else rest.push(line);
    }
    const out: DocLine[] = [];
    if (facts.length > 0) for (const wrapped of wrapLines(facts.join(' · '), width)) out.push({ text: wrapped, fg: t.textFaint });
    for (const line of rest) {
      if (line === '') {
        if (out.length > 0 && out[out.length - 1]!.text !== '') out.push({ text: '', fg: t.textMuted });
        continue;
      }
      const fg = WARN_PREFIXES.some((p) => line.startsWith(p))
        ? t.warning
        : FACT_PREFIXES.some((p) => line.startsWith(p))
          ? t.textFaint
          : t.textMuted;
      const bold = line.endsWith(':');
      for (const wrapped of wrapLines(line, width)) out.push({ text: wrapped, fg: bold ? t.text : fg, bold });
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
