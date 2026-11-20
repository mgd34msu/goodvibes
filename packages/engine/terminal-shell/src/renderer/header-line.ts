/**
 * header-line.ts, the one-row header.
 *
 *   col 1   GoodVibes, bold, in the theme's brand -> brandEnd gradient
 *           (the theme's gradient, never the protected splash constant)
 *   then    the version (faint) and the session title (muted)
 *   right   only while the serving backend is not the configured one: the
 *           serving model and the failover marker in the warning color,
 *           ending at width-2
 *
 * No rule row under it; on the main screen one empty row (withHeaderGap)
 * keeps the output off it. The branch and the model are on the status bar,
 * labelled (`branch main, changed`, `model rt-1`). Inside an agent or process
 * view the title gives way to the breadcrumb (main › engineer, the last name
 * in its own color) and the right side names that session: the agent's
 * model, or the process's pid, uptime and port. On a narrow row the marker
 * falls back to its short form, then is dropped whole (a half-cut marker
 * reads worse than none); the title goes before it.
 */
import { type Line, createEmptyLine } from '@goodvibes/engine/platform/platform/types';
import { getDisplayWidth, interpolateColor, truncateDisplay } from '@goodvibes/engine/platform/platform/utils';
export interface GitHeaderInfo {
    readonly branch: string;
    readonly dirty: boolean;
    readonly ahead: number;
    readonly behind: number;
}
import { activeTokens } from './theme.js';
export interface HeaderPresentation {
    readonly brand: string;
    readonly defaultVersion: string;
    readonly versionPrefix?: string | undefined;
    readonly truncateModel?: boolean | undefined;
}
export function createHeaderRenderer(presentation: HeaderPresentation) {
    return (width: number, model: string, title?: string | undefined, gitInfo?: GitHeaderInfo | undefined, version = presentation.defaultVersion, modelNote?: string | undefined, view?: HeaderView | undefined): Line[] => renderHeaderLine(presentation, width, model, title, gitInfo, version, modelNote, view);
}
const BRAND_X = 1;
const GAP = 3;
interface Seg {
    readonly text: string;
    readonly fg: string;
    readonly bold?: boolean | undefined;
}
/** An agent or process view: the breadcrumb in place of the title, the session's own right side. */
export interface HeaderView {
    readonly onCrumb?: ((index: number, start: number, end: number) => void) | undefined;
    /** main, then each level down to the one shown; the last is drawn bold in its color. */
    readonly crumbs: ReadonlyArray<{
        readonly text: string;
        readonly fg: string;
        readonly bold?: boolean | undefined;
    }>;
    /** Replaces the branch and model on the right (the agent's model; pid · uptime · port). */
    readonly right: string;
    readonly rightFg?: string | undefined;
}
function put(line: Line, x: number, endX: number, seg: Seg): number {
    let cx = x;
    for (const ch of seg.text) {
        const w = getDisplayWidth(ch);
        if (w <= 0)
            continue;
        if (cx + w > endX)
            break;
        line[cx] = { char: ch, fg: seg.fg, bg: '', bold: seg.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
        if (w === 2 && cx + 1 < line.length)
            line[cx + 1] = { ...line[cx]!, char: '' };
        cx += w;
    }
    return cx;
}
/**
 * Render the header row.
 *
 * @param width   - Terminal columns.
 * @param model   - Serving model id (core/active-model-identity.ts), drawn
 *                  only beside the failover marker.
 * @param title   - Optional session title, truncated to fit.
 * @param _gitInfo - The branch is the status bar's (`branch main, changed`).
 * @param version - Defaults to the live build VERSION; tests pin a fixture.
 * @param modelNote - The failover marker (core/active-model-identity.ts), set
 *                    only while serving differs from the configured model.
 */
function renderHeaderLine(presentation: HeaderPresentation, width: number, model: string, title?: string | undefined, _gitInfo?: GitHeaderInfo | undefined, version: string = presentation.defaultVersion, modelNote?: string | undefined, view?: HeaderView | undefined): Line[] {
    const BRAND = presentation.brand;
    version = (presentation.versionPrefix ?? '') + version;
    const t = activeTokens();
    const line = createEmptyLine(width);
    for (const cell of line)
        cell.bg = '';
    const end = width - 1; // exclusive: the model ends at width-2
    if (view)
        return [renderViewHeader(line, width, version, view, BRAND)];
    // Right side first, so the title knows how much room it has.
    const leftMin = BRAND_X + getDisplayWidth(BRAND) + 1 + getDisplayWidth(version);
    const fits = (w: number): boolean => leftMin + GAP + w <= end;
    let note = '';
    if (modelNote) {
        const full = ` · ${modelNote}`;
        const short = ' · divergent';
        const baseW = getDisplayWidth(model);
        if (fits(baseW + getDisplayWidth(full)))
            note = full;
        else if (fits(baseW + getDisplayWidth(short)))
            note = short;
    }
    // The model is the status bar's; the header names it only with the failover marker.
    if (note && presentation.truncateModel && !fits(getDisplayWidth(model) + getDisplayWidth(note)))
        model = truncateDisplay(model, Math.max(0, end - leftMin - GAP - getDisplayWidth(note)));
    const rightW = note ? getDisplayWidth(model) + getDisplayWidth(note) : 0;
    const rightX = note ? Math.max(leftMin + GAP, end - rightW) : end + GAP;
    // Brand, version, title.
    let x = BRAND_X;
    [...BRAND].forEach((ch, i) => {
        x = put(line, x, end, { text: ch, fg: interpolateColor(t.brand, t.brandEnd, i / (BRAND.length - 1)), bold: true });
    });
    x = put(line, x + 1, end, { text: version, fg: t.textFaint });
    if (title) {
        const room = rightX - GAP - (x + 2);
        if (room >= 4)
            put(line, x + 2, rightX - GAP, { text: truncateDisplay(title, room), fg: t.textMuted });
    }
    if (note) {
        const rx = put(line, rightX, end, { text: model, fg: t.text });
        put(line, rx, end, { text: note, fg: t.warning });
    }
    return [line];
}
/** The header inside an agent or process view. */
function renderViewHeader(line: Line, width: number, version: string, view: HeaderView, BRAND: string): Line {
    const t = activeTokens();
    const end = width - 1;
    let x = BRAND_X;
    [...BRAND].forEach((ch, i) => {
        x = put(line, x, end, { text: ch, fg: interpolateColor(t.brand, t.brandEnd, i / (BRAND.length - 1)), bold: true });
    });
    x = put(line, x + 1, end, { text: version, fg: t.textFaint });
    const crumbsW = view.crumbs.reduce((s, c, i) => s + (i > 0 ? 3 : 0) + getDisplayWidth(c.text), 0);
    // The right side yields before the breadcrumb does: where you are matters more than the model name.
    const roomForRight = end - (x + 2 + crumbsW + GAP);
    const right = roomForRight >= 4 ? truncateDisplay(view.right, roomForRight) : '';
    const rightX = end - getDisplayWidth(right);
    const crumbEnd = right ? rightX - GAP : end;
    x += 2;
    view.crumbs.forEach((crumb, i) => {
        if (i > 0)
            x = put(line, x + 1, crumbEnd, { text: '›', fg: t.textFaint }) + 1;
        const start = x;
        const last = i === view.crumbs.length - 1;
        const room = crumbEnd - x;
        x = put(line, x, crumbEnd, { text: last ? truncateDisplay(crumb.text, Math.max(0, room)) : crumb.text, fg: crumb.fg, bold: crumb.bold });
        if (x > start)
            view.onCrumb?.(i, start, x);
    });
    if (right)
        put(line, rightX, end, { text: right, fg: view.rightFg ?? t.text });
    return line;
}
/**
 * The main screen's header block with its gap: the header row (and the
 * session chips row, when it shows), then one empty row, so output never
 * touches the header. An agent or process view's body starts with its own
 * empty row, so a view does not take this one.
 */
export function withHeaderGap(header: readonly Line[], width: number): Line[] {
    const gap = createEmptyLine(width);
    for (const cell of gap)
        cell.bg = '';
    return [...header, gap];
}
/** Rows the gap under the main screen's header adds. */
export const HEADER_GAP_ROWS = 1;
