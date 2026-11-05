import { drawDiffRow as draw } from '@goodvibes-jev/engine/terminal-shell/diff-rows';
export { parseChanges, languageForPath, type ChangeFile, type ChangeHunk, type ChangeLine, type ChangeLineKind } from '@goodvibes-jev/engine/terminal-shell/changes-model';
export { buildDiffRows, semanticChips, DIFF_GUTTER, type DiffRow } from '@goodvibes-jev/engine/terminal-shell/diff-rows';
export const drawDiffRow = (canvas: Parameters<typeof draw>[0], panel: Parameters<typeof draw>[1], y: number, row: Parameters<typeof draw>[3], options: Parameters<typeof draw>[5] = {}) => draw(canvas, panel, y, row, -1, options);
