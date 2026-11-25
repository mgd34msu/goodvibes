// ---------------------------------------------------------------------------
// composer-fragments.ts, composer-adjacent transcript fragments extracted from
// ui-factory.ts (file-size hygiene): the mid-turn queued-message editable list
// and the optional "used N memories" provenance chip. Pure renderers; the
// UIFactory static methods are thin wrappers over these.
// ---------------------------------------------------------------------------

import { type Line } from '@goodvibes/engine/platform/platform/types';
import { renderConversationFragment } from './conversation-surface.js';
import { activeUiTones } from './theme.js';
import { activeTheme } from './theme.js';

/**
 * The mid-turn message queue rendered as an EDITABLE list. Each still-undelivered
 * message shows a 1-based number, the one the queue's controls in This conversation
 * name it by (queue.edit, queue.delete: the platform editQueuedMessage /
 * deleteQueuedMessage verbs). A delivered message has already left the queue, so the
 * list only ever shows what is still editable, delivery is immutability, made visible.
 */
export function renderQueuedMessageList(width: number, items: readonly { readonly id: string; readonly text: string }[]): Line[] {
  if (items.length === 0) return [];
  const t = activeUiTones();
  const bodyBg = activeTheme().collapsedBodyBg;
  const lines: Line[] = [];
  const header = `${items.length} queued: change or take one back in This conversation until it is sent`;
  lines.push(...renderConversationFragment(header, width, { prefix: ' ⧗ ', prefixFg: t.state.reasoning, text: t.fg.dim, bodyBg }));
  items.forEach((item, index) => {
    lines.push(...renderConversationFragment(item.text, width, { prefix: `   ${index + 1}. `, prefixFg: t.state.reasoning, text: t.fg.dim, bodyBg }));
  });
  return lines;
}

/**
 * One drilled-in memory-provenance row. `record` is the RESOLVED record summary
 * (undefined = still resolving, null = no longer available), the drill-in
 * shows a human summary, never a raw record id, matching the webui's detail
 * fetch (per-id, so one missing record never blanks the rest).
 */
export interface MemoryProvenanceEntry {
  readonly id: string;
  readonly record?: { readonly summary: string; readonly cls: string } | null | undefined;
}

/** The chip's key as the program binds it (toggle-memory-provenance), set each frame. */
let memoryProvenanceKey = 'Ctrl+G E';

/** Keep the chip's key in step with the key table ('(unbound)' names no key). */
export function setMemoryProvenanceKey(label: string): void {
  memoryProvenanceKey = label;
}

/**
 * The optional "used N memories" turn chip. Collapsed: one small line naming the
 * count with the drill-in hint. Expanded (its key, toggle-memory-provenance): the same line followed by one
 * line per memory, its resolved SUMMARY (with the record class), a "resolving…"
 * placeholder while the fetch is in flight, or an honest "no longer available"
 * for a record that has since been forgotten. Empty when no memories were used.
 */
export function renderMemoryProvenanceChip(width: number, count: number, entries: readonly MemoryProvenanceEntry[], expanded: boolean, key = memoryProvenanceKey): Line[] {
  if (count <= 0) return [];
  const t = activeUiTones();
  const bodyBg = activeTheme().collapsedBodyBg;
  const noun = count === 1 ? 'memory' : 'memories';
  // The key as bound (toggle-memory-provenance); unbound, the chip names no key.
  const press = key && key !== '(unbound)' ? `: ${key} to ${expanded ? 'hide' : 'list'}` : '';
  const header = `used ${count} ${noun}${press}`;
  const lines: Line[] = renderConversationFragment(header, width, { prefix: ' ◆ ', prefixFg: t.state.info, text: t.fg.dim, bodyBg });
  if (expanded) {
    entries.forEach((entry, index) => {
      const body = entry.record === undefined
        ? 'resolving…'
        : entry.record === null
          ? 'no longer available'
          : `${entry.record.summary}  ·  ${entry.record.cls}`;
      lines.push(...renderConversationFragment(body, width, { prefix: `   ${index + 1}. `, prefixFg: t.state.info, text: t.fg.dim, bodyBg }));
    });
  }
  return lines;
}
