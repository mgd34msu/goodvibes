/** One diff parser and painter serves opened tool bodies and the Changes modal. */
import { activeDiffTones, activeTokens } from './theme.js';
import { clipText, type SurfaceCanvas } from './surface-kit.js';
import type { KitInset } from './surface-kit-parts.js';
import { highlightCodeLines, syntaxHighlightGeneration, syntaxHighlightMisses } from './code-block.js';
import { diffRowTints } from './diff-tint.js';
import type { SemanticDiff } from '../semantic-diff.js';
import { getDisplayWidth } from '@goodvibes-jev/engine/sdk/platform/utils';
import { languageForPath, type ChangeFile, type ChangeHunk, type ChangeLine } from '../changes-model.js';
/** Width of the line-number gutter inside the diff inset. */
export const DIFF_GUTTER = 5;
const GUTTER = DIFF_GUTTER;
/** One drawn row of a diff: a file header, a hunk separator, or a (wrapped) code line. */
export type DiffRow = {
    readonly kind: 'file';
    readonly text: string;
} | {
    readonly kind: 'sep';
    readonly hunk: number;
    readonly text: string;
} | {
    readonly kind: 'line';
    readonly hunk: number;
    readonly line: ChangeLine;
    readonly first: boolean;
    readonly text: string;
    readonly tokens: ReadonlyArray<{
        text: string;
        fg: string;
        bold?: boolean | undefined;
        italic?: boolean | undefined;
    }> | null;
};
/** Syntax tokens per hunk, remembered until the theme changes. */
/** A hunk's tokens; `generation` is set when they were the regex placeholder (a parse was on its way). */
const tokenMemo = new WeakMap<ChangeHunk, {
    theme: object;
    lines: ReturnType<typeof highlightCodeLines>;
    generation: number | undefined;
}>();
function hunkTokens(file: ChangeFile, hunk: ChangeHunk): ReturnType<typeof highlightCodeLines> {
    const theme = activeTokens();
    const memo = tokenMemo.get(hunk);
    // Placeholder tokens are kept only until the hunk's parse lands.
    if (memo && memo.theme === theme && (memo.generation === undefined || memo.generation === syntaxHighlightGeneration()))
        return memo.lines;
    const missesBefore = syntaxHighlightMisses();
    const lines = highlightCodeLines(hunk.lines.map((line) => line.text), languageForPath(file.path));
    tokenMemo.set(hunk, { theme, lines, generation: syntaxHighlightMisses() !== missesBefore ? syntaxHighlightGeneration() : undefined });
    return lines;
}
/** Split syntax tokens into rows of at most `width` cells. */
function wrapTokens(tokens: ReadonlyArray<{
    text: string;
    fg: string;
    bold?: boolean | undefined;
    italic?: boolean | undefined;
}>, width: number): Array<Array<{
    text: string;
    fg: string;
    bold?: boolean | undefined;
    italic?: boolean | undefined;
}>> {
    const rows: Array<Array<{
        text: string;
        fg: string;
        bold?: boolean | undefined;
        italic?: boolean | undefined;
    }>> = [[]];
    let used = 0;
    for (const token of tokens) {
        let piece = '';
        for (const ch of token.text.replace(/\t/g, '  ')) {
            const w = getDisplayWidth(ch);
            if (w <= 0)
                continue;
            if (used + w > width) {
                if (piece)
                    rows[rows.length - 1]!.push({ ...token, text: piece });
                rows.push([]);
                piece = '';
                used = 0;
            }
            piece += ch;
            used += w;
        }
        if (piece)
            rows[rows.length - 1]!.push({ ...token, text: piece });
    }
    return rows;
}
/**
 * The rows a diff draws as, code wrapped to `codeWidth` under its own gutter.
 * Shared with the conversation work tree, which draws an opened edit with the
 * same rows (lane-graph/paint.ts).
 */
export function buildDiffRows(diffFiles: readonly ChangeFile[], codeWidth: number, fileHeaders: boolean): {
    rows: DiffRow[];
    hunkStarts: number[];
} {
    const rows: DiffRow[] = [];
    const hunkStarts: number[] = [];
    let hunkNo = 0;
    const total = diffFiles.reduce((n, f) => n + f.hunks.length, 0);
    for (const file of diffFiles) {
        if (fileHeaders)
            rows.push({ kind: 'file', text: `${file.path}  +${file.added} −${file.removed}` });
        if (file.headerOnly) {
            const why = file.note ?? (file.headerLines.some((l) => l.startsWith('Binary')) ? 'binary file, no line changes to show' : 'no line changes (mode or rename only)');
            rows.push({ kind: 'file', text: why });
            continue;
        }
        for (const hunk of file.hunks) {
            hunkStarts.push(rows.length);
            rows.push({ kind: 'sep', hunk: hunkNo, text: `⋯ line ${hunk.review.newStart}` + (total > 1 ? `  ·  hunk ${hunkNo + 1} of ${total}` : '') });
            const tokens = hunkTokens(file, hunk);
            hunk.lines.forEach((line, i) => {
                if (line.kind === 'note') {
                    rows.push({ kind: 'line', hunk: hunkNo, line, first: true, text: line.text, tokens: null });
                    return;
                }
                const wrapped = wrapTokens(tokens[i] ?? [{ text: line.text, fg: activeTokens().text }], codeWidth);
                wrapped.forEach((part, k) => rows.push({ kind: 'line', hunk: hunkNo, line, first: k === 0, text: '', tokens: part }));
            });
            hunkNo++;
        }
    }
    return { rows, hunkStarts };
}
/**
 * Draw one diff row inside inset `p`: the change tint across the row, a
 * separate tint on the line-number gutter, the number, the sign and the
 * syntax-colored code. `lineNumbers: false` leaves the numbers out (a diff
 * whose line numbers are not known).
 */
export function drawDiffRow(canvas: SurfaceCanvas, p: KitInset, y: number, row: DiffRow, selectedHunk: number, options: {
    readonly lineNumbers?: boolean | undefined;
} = {}): void {
    const t = activeTokens();
    if (row.kind === 'file') {
        canvas.put(p.l, y, clipText(row.text, p.r - p.l + 1), { fg: t.text, bold: true, bg: p.bg });
        return;
    }
    const tones = activeDiffTones();
    if (row.kind === 'sep') {
        const on = row.hunk === selectedHunk;
        canvas.put(p.l, y, clipText(row.text, p.r - p.l + 1), { fg: on ? t.brand : tones.hunk, bold: on, bg: p.bg });
        return;
    }
    const line = row.line;
    const gutterEnd = p.l + GUTTER - 1;
    if (line.kind === 'add' || line.kind === 'del') {
        const tints = diffRowTints(p.bg);
        canvas.tint(p.x, y, p.w, line.kind === 'add' ? tints.addedRow : tints.removedRow);
        canvas.tint(p.x, y, gutterEnd - p.x + 2, line.kind === 'add' ? tints.addedGutter : tints.removedGutter);
    }
    if (line.kind === 'note') {
        canvas.put(p.l + GUTTER + 3, y, clipText(row.text, p.r - p.l - GUTTER - 2), { fg: t.textFaint });
        return;
    }
    if (row.first) {
        const n = line.kind === 'del' ? line.oldNo : line.newNo;
        if (n !== null && options.lineNumbers !== false)
            canvas.right(gutterEnd, y, String(n).slice(-GUTTER), { fg: t.diffLineNumber });
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        canvas.put(gutterEnd + 2, y, sign, { fg: line.kind === 'add' ? tones.add : line.kind === 'del' ? tones.del : t.textFaint });
    }
    let x = gutterEnd + 4;
    for (const token of row.tokens ?? [])
        x = canvas.put(x, y, token.text, { fg: token.fg, bold: token.bold, italic: token.italic });
}
/** The ◈ summary's chips ("~ fn withRetry", "+ import x"), colored by kind. */
export function semanticChips(diff: SemanticDiff): Array<{
    text: string;
    fg: string;
}> {
    const t = activeTokens();
    const chips: Array<{
        text: string;
        fg: string;
    }> = [];
    for (const s of diff.symbols) {
        const glyph = s.kind === 'added' ? '+' : s.kind === 'removed' ? '-' : '~';
        chips.push({ text: `${glyph} ${s.symbolKind === 'function' ? 'fn' : s.symbolKind} ${s.name}`, fg: s.kind === 'added' ? t.success : s.kind === 'removed' ? t.error : t.warning });
    }
    for (const i of diff.imports) {
        const glyph = i.kind === 'added' ? '+' : i.kind === 'removed' ? '-' : '~';
        chips.push({ text: `${glyph} import ${i.specifier}`, fg: i.kind === 'added' ? t.success : i.kind === 'removed' ? t.error : t.warning });
    }
    return chips;
}
/** The ◈ summary row(s); returns the row after them. */
