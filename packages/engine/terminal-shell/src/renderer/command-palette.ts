/**
 * renderCommandPalette, the one help list (`?`, `/help`, `/commands`, Ctrl+P)
 * drawn with the surface kit.
 *
 *   ✦ Commands                                                     esc
 *
 *   ▏Type a command, setting, model or key     156 commands and keys
 *
 *   ✦ suggested                                Switch model
 *     Changes                     /changes     /model
 *     Switch model  rt-1            /model     rt-1
 *   ✦ session
 *     Resume a session             /resume     Choose the model new turns use.
 *   …
 *   ✦ keyboard shortcuts                       Finds: provider, llm
 *     Open the command palette      Ctrl+P
 *
 *   ↑↓ move   ⏎ run   tab fill composer                   120 more ↓
 *
 * Each row is a plain title with the slash command (or a shortcut's key)
 * right-aligned and dim. The detail pane shows the selected command's summary,
 * its actions by label when it has more than one, and the words that find it.
 * The count beside the search and the "more" count both count listed rows. On an 80-column terminal there is
 * no detail pane: the selected row's summary is one
 * dim line under the list.
 */

import type { PaletteEntry, PaletteView } from '../command-palette-types.js';
import { activeTokens } from './theme.js';
import { beginModal, clipText, finishModal, scrollCountText, searchRow, type SurfaceLayer } from './surface-kit.js';
import { drawList, type KitRow } from './surface-kit-list.js';
import { inset, insetLines, type KitInset } from './surface-kit-parts.js';

function rowsFor(palette: PaletteView): KitRow[] {
  const selected = palette.getSelected();
  const rows: KitRow[] = [];
  const searching = palette.query.trim().length > 0;
  for (const section of palette.sections()) {
    if (!searching || section.group === 'Keyboard shortcuts') rows.push({ header: section.title ?? section.group });
    for (const entry of section.entries) {
      const live = entry.kind === 'command' ? palette.describe(entry.id) : undefined;
      rows.push({
        label: live ? `${entry.title}  ${live}` : entry.title,
        right: entry.right,
        selected: entry === selected,
      });
    }
  }
  if (rows.length === 0) rows.push({ label: palette.searching ? 'Finding commands…' : `Nothing matches "${palette.query}".`, muted: true });
  return rows;
}

function drawDetail(palette: PaletteView, entry: PaletteEntry | null, canvas: Parameters<typeof insetLines>[0], p: KitInset): void {
  const t = activeTokens();
  if (!entry) {
    insetLines(canvas, p, p.l, p.top, [{ text: 'Type to search every command and key by its name, its title or what it does.', style: { fg: t.textMuted } }]);
    return;
  }
  const blank = { text: '', style: {} };
  if (entry.kind === 'shortcut') {
    insetLines(canvas, p, p.l, p.top, [
      { text: entry.right, style: { fg: t.brand, bold: true } },
      blank,
      { text: entry.title, style: { fg: t.textMuted } },
      ...(entry.summary !== entry.title ? [blank, { text: entry.summary, style: { fg: t.textFaint } }] : []),
    ]);
    return;
  }
  const live = palette.describe(entry.id);
  // A command with one action does that one thing, which its summary already
  // says: its label is left out. With several, each label names a choice.
  const actions = entry.actions.length > 1
    ? entry.actions.filter((label) => label.toLowerCase() !== entry.summary.toLowerCase() && label.toLowerCase() !== entry.title.toLowerCase())
    : [];
  insetLines(canvas, p, p.l, p.top, [
    { text: entry.title, style: { fg: t.text, bold: true } },
    { text: entry.line ? `/${entry.line.command} ${entry.line.args.join(' ')}` : `/${entry.id}`, style: { fg: t.brand } },
    ...(live ? [{ text: live, style: { fg: t.textMuted } }] : []),
    blank,
    ...(entry.summary ? [{ text: entry.summary, style: { fg: t.textMuted } }, blank] : []),
    ...actions.map((label) => ({ text: label, style: { fg: t.text } })),
    ...(actions.length > 0 ? [blank] : []),
    ...(entry.keywords.length > 0 ? [{ text: `Finds: ${entry.keywords.join(', ')}`, style: { fg: t.textFaint } }] : []),
  ]);
}

export function renderCommandPalette(palette: PaletteView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const selected = palette.getSelected();
  const f = beginModal(screenWidth, screenHeight, {
    title: 'Commands',
    hints: selected?.kind === 'shortcut'
      ? [['↑↓', 'move']]
      : [['↑↓', 'move'], ['⏎', 'run'], ['tab', 'fill composer'], ...(palette.query.trim() ? [] : [['ctrl+]', 'next group'] as [string, string]])],
  });
  // Every count here is of listed rows (commands and keys), the same rows the "more" count below counts.
  const total = palette.entries.length;
  const shown = palette.flat().length;
  searchRow(f, f.top, palette.query, 'Type a command, setting, model or key', palette.query ? `${shown} of ${total}` : `${total} commands and keys`);

  const body = f.top + 2;
  const inner = f.r - f.l + 1;
  // A detail pane when there is room for it (wider than an 80-column
  // terminal); below that the list takes the width and the selected row's
  // summary is one line under it.
  const sideBySide = inner >= 80;
  const x1 = sideBySide ? f.l + Math.floor(inner * 0.55) - 1 : f.r;
  const listBottom = sideBySide ? f.bottom : f.bottom - 2;
  const result = drawList(f.canvas, { mouseNavigation: true, rows: rowsFor(palette), top: body, bottom: listBottom, x0: f.l, x1, scrollKey: { owner: palette, name: 'list' } });
  if (sideBySide) {
    const p = inset(f.canvas, x1 + 3, body, f.r + 2 - (x1 + 3) + 1, f.bottom - body + 1);
    drawDetail(palette, selected, f.canvas, p);
  } else if (selected?.summary) {
    f.canvas.put(f.l, f.bottom, clipText(selected.summary, inner), { fg: activeTokens().textMuted });
  }
  f.hintRight = scrollCountText(result.above, result.below);
  return finishModal(f);
}
