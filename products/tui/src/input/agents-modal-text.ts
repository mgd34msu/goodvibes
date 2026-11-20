/**
 * agents-modal-text.ts, the plain-text pieces the Agents modal shows: the
 * hosted session's header facts and rows.
 *
 * Every hosted fact is a field of the daemon's own record; nothing is derived
 * here.
 */

import { createEmptyLine, type Line } from '@goodvibes/engine/platform/platform/types';
import type { HostedSessionFeedState, HostedSessionRow } from '../views/hosted-session-feed.ts';
import type { PanelText as AgentsText } from '@goodvibes/engine/terminal-shell/work-board';
import { activeTokens } from '../renderer/theme.ts';
import { wrapText, getDisplayWidth, expandTabs } from '../utils/terminal-width.ts';

/** What the hosted session is, what it is doing, and what leaving it would do. */
export function hostedHeaderTexts(state: HostedSessionFeedState): AgentsText[] {
  const record = state.record;
  if (!record) return [];
  const lines: AgentsText[] = [
    { text: `${record.status} · ${record.turnCount} turn${record.turnCount === 1 ? '' : 's'} · ${record.messageCount} message${record.messageCount === 1 ? '' : 's'}`, tone: 'text' },
    { text: `workspace ${record.workspaceRoot}`, tone: 'faint' },
    {
      text: `${record.effectiveDetachPolicy === 'survive' ? 'leaving keeps it running (survive)' : 'leaving ends it (kill)'}, ${record.detachPolicy === null ? 'from the setting' : 'set for this session'}`,
      tone: record.effectiveDetachPolicy === 'survive' ? 'success' : 'warning',
    },
    { text: `attached: ${record.attachedClients.length > 0 ? record.attachedClients.join(', ') : 'nobody'}`, tone: 'muted' },
  ];
  if (record.status === 'terminated') lines.push({ text: `ended: ${record.terminatedReason ?? 'no reason recorded'}`, tone: 'error' });
  if (record.restoredFromDisk) lines.push({ text: 'restored from disk after a daemon restart', tone: 'warning' });
  if (record.saveError) lines.push({ text: `not saved: ${record.saveError}. What it did since its last save is lost if the daemon restarts.`, tone: 'error' });
  lines.push(state.streaming
    ? { text: 'live event stream open', tone: 'success' }
    : { text: `no live stream: ${state.streamNote ?? 'not subscribed'}`, tone: 'warning' });
  if (state.runningToolCalls.length > 0) {
    lines.push({ text: `running: ${state.runningToolCalls.map((call) => call.tool).join(', ')}`, tone: 'brand' });
  }
  if (state.droppedRows > 0) lines.push({ text: `${state.droppedRows} earlier row(s) dropped; reattach to backfill`, tone: 'faint' });
  return lines;
}

/** The hosted conversation's rows as text. */
export function hostedRowTexts(rows: readonly HostedSessionRow[]): AgentsText[] {
  return rows.map((row) => {
    const prefix = row.kind === 'user' ? 'you: ' : row.kind === 'tool' ? '' : row.kind === 'error' ? 'error: ' : '';
    const text = `${prefix}${row.text}${row.streaming ? ' …' : ''}`;
    if (row.kind === 'tool') return { text, tone: 'brand', glyph: '→' };
    if (row.kind === 'error') return { text, tone: 'error' };
    if (row.kind === 'user') return { text, tone: 'text', bold: true };
    if (row.kind === 'system') return { text, tone: 'faint' };
    return { text, tone: 'text' };
  });
}

/** Combining marks other than variation selectors (which change a glyph's width). */
const COMBINING_MARK = /^(?![\uFE00-\uFE0F\u{E0100}-\u{E01EF}])\p{M}$/u;

export interface HostedTranscriptLine {
  readonly line: Line;
  readonly row: number;
  /** Text offset within the styled row, for resize-stable viewport anchors. */
  readonly offset: number;
}

/** The full wrapped transcript with its retained row/text coordinates. */
export function hostedTranscriptLines(rows: readonly HostedSessionRow[], width: number): HostedTranscriptLine[] {
  const t = activeTokens();
  const out: HostedTranscriptLine[] = [];
  const textWidth = Math.max(8, width - 9);
  for (const [row, item] of hostedRowTexts(rows).entries()) {
    const fg = item.tone === 'error' ? t.error : item.tone === 'brand' ? t.brand : item.tone === 'faint' ? t.textFaint : t.text;
    const text = expandTabs(item.glyph ? `${item.glyph} ${item.text}` : item.text);
    let nextOffset = 0;
    for (const part of wrapText(text, textWidth)) {
      const offset = Math.max(nextOffset, text.indexOf(part, nextOffset));
      nextOffset = offset + Math.max(1, part.length);
      const line = createEmptyLine(width);
      let x = 5;
      let last = -1;
      for (const ch of part) {
        const w = getDisplayWidth(ch);
        if (w <= 0) {
          // A zero-width code point takes no cell of its own: a combining
          // accent joins the character before it; a joiner or variation
          // selector is dropped so the cell keeps the width counted for it.
          if (last >= 0 && COMBINING_MARK.test(ch)) line[last] = { ...line[last]!, char: line[last]!.char + ch };
          continue;
        }
        if (x + w > width - 4) break;
        line[x] = { ...line[x]!, char: ch, fg, bold: item.bold === true };
        if (w === 2) line[x + 1] = { ...line[x]!, char: '' };
        last = x;
        x += w;
      }
      out.push({ line, row, offset });
    }
  }
  return out;
}

/** Existing tail-only helper; the actual modal owns its scroll cursor separately. */
export function hostedBody(rows: readonly HostedSessionRow[], width: number, height: number): Line[] {
  return hostedTranscriptLines(rows, width).slice(-Math.max(1, height)).map(entry => entry.line);
}
