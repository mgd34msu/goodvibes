/**
 * status-line.ts, the one row directly under the composer: the status bar.
 *
 * Left, in order:
 *   - `Asks:` (faint) and the mode in force (ModeInForceWords): the chosen
 *     mode's label (`Jev decides`) when it is in force; when it is not, what
 *     is (`you, for now`, warning), then the choice and when it takes effect
 *     (` · Jev decides once a decision model is set`), then a failure
 *     (` · decision model unreachable`, faint); then the key that changes it
 *     as a keycap (` shift+tab `). Never dropped. After a change it flashes
 *     (drawn inverse) while `flash` is set.
 *   - the chips that must stay visible (auto-approve, the live microphone,
 *     sleep disabled), never dropped; optional chips after them (an attached
 *     image, the composer's intent) are dropped first;
 *   - `2 notices` and the key that opens them (` ctrl+n `), absent at zero;
 *   - while a main turn runs, the `esc` keycap with what Esc does now;
 *   - a background-work summary while agents or processes run (highlighted
 *     with its keys while it owns keyboard focus), truncated into the room
 *     that is left.
 *   In place of the last three: a notice the person must see now (the "press
 *   Ctrl+C again" exit guard, a copy receipt), or the keys of the view the
 *   keyboard is in (the work tree, an agent or process view) and its trail.
 *
 * Right, two columns between segments, ending at width-4: the cost (when the
 * model is priced), `context 34%`, `branch main, changed` (`, changed` only
 * while the working tree differs from HEAD; absent outside a repository),
 * `model rt-1`, then the `ctrl+p` keycap with "menu".
 *
 * Every segment is a click target (tagRegion): the mode opens the mode
 * picker, the notices the notifications, context the context inspector,
 * branch the changes, model the model picker, the cost Usage, the summary the
 * agents, the menu keycap the palette.
 *
 * When the row is short, pieces give way in this order until it fits: the
 * menu keycap, the cost, optional chips; the choice shortens (`Jev decides
 * once a decision model is set` to `you chose Jev decides`; the rest is on a click); the
 * notices lose their keycap (the count stays), the branch loses its state
 * word (`branch main`), the context goes, the branch goes; a failure
 * (`decision model unreachable`, `decision model failing`) shortens
 * (`unreachable`); the background summary (unless it holds focus), the model,
 * the notices, the mode's keycap; last a failure goes. `Asks:` with the mode
 * in force (`you, for now`) and the choice, the kept chips and the esc hint
 * always stay. A segment given up
 * before a later step freed the room comes back when it fits (the model, then
 * the context, the branch, the cost, the menu keycap, the choice's whole words).
 */
import { type Line, createEmptyLine } from '@goodvibes/engine/platform/platform/types';
import { getDisplayWidth, truncateDisplay } from '@goodvibes/engine/platform/platform/utils';
import { activeTokens } from './theme.js';
import { keycapHintsWidth, paintKeycapHints } from './surface-kit-parts.js';
import type { KitHint } from './surface-kit.js';
/** From this fraction of the window the context percent turns to the warning color. */
const CONTEXT_WARN_FRACTION = 0.65;
/** Left pieces sit this far apart; left and right sides keep at least this much between them. */
const GAP = 3;
/** Right segments sit this far apart. */
const RIGHT_GAP = 2;
/** Left edge of the status line (the fill column of the composer above). */
const LEFT_X = 3;
/** Columns between the chips at the left end. */
const CHIP_GAP = 2;
/** Columns between a segment's words and its keycap. */
const KEY_GAP = 2;
/** The room a background summary keeps before the model gives way to it. */
const SUMMARY_MIN = 20;
/** What a click on a part of the status line opens. */
export type StatusTarget = 'mode' | 'notices' | 'context' | 'changes' | 'model' | 'usage' | 'agents' | 'commands';
/** A chip at the left end of the status line. */
export interface StatusChip {
    readonly text: string;
    readonly fg: string;
    readonly bold?: boolean | undefined;
    /** A filled chip (the wake indicator's banner prominence); no fill otherwise. */
    readonly bg?: string | undefined;
    /** Never dropped for lack of room (auto-approve, microphone, sleep). */
    readonly keep?: boolean | undefined;
}
/** The mode segment: ModeInForceWords' chosen/inForce/chosenWhen/because/failure, and the key that changes the mode. */
export interface StatusAsks {
    readonly chosen: string;
    readonly inForce?: string | undefined;
    readonly chosenWhen?: string | undefined;
    readonly chosenShort?: string | undefined;
    readonly because?: string | undefined;
    readonly failure?: boolean | undefined;
    /** The key that changes the mode as bound ("shift+tab"); no keycap when absent. */
    readonly key?: string | undefined;
    /** Drawn inverse: the mode just changed (a short flash, never a transcript line). */
    readonly flash?: boolean | undefined;
    /** While flashing, this one line replaces the words (first run's "You're set: answering with rt-1"). */
    readonly flashMessage?: string | undefined;
}
/** Unread notices and the key that opens them. */
export interface StatusNotices {
    readonly count: number;
    readonly key?: string | undefined;
}
/** The current branch and whether the working tree differs from HEAD. */
export interface StatusBranch {
    readonly name: string;
    readonly changed: boolean;
}
/** A main turn is running: the status line leads with what Esc does now. */
export interface StatusBusyState {
    /** What the next Esc does, when not "interrupt" (the composer has text: "clear input"). */
    readonly escAction?: string | undefined;
}
export interface StatusBackgroundState {
    readonly agents: number;
    readonly processes: number;
    /** True while the background summary owns keyboard focus. */
    readonly focused: boolean;
    /** Optional one-line progress of the running agents. */
    readonly progress?: string | undefined;
}
export interface StatusContextState {
    readonly available?: boolean | undefined;
    /** Tokens in the last request (0 while unknown). */
    readonly usedTokens: number;
    /**
     * The model's context window, or null when nothing states it (a guessed
     * window, or one a larger accepted request disproved): the segment reads
     * "context unknown", since no percent can be computed.
     */
    readonly windowTokens: number | null;
    /** Compaction threshold as a fraction [0..1]. */
    readonly compactFraction: number;
}
export interface StatusLineOptions {
    /** Product pointer routing records metadata without changing the painted row. */
    readonly tagRegion?: ((line: Line, start: number, end: number, target: StatusTarget) => void) | undefined;
    readonly width: number;
    /** The mode segment; absent inside an agent or process view. */
    readonly asks?: (StatusAsks | null) | undefined;
    /** Chips after the mode segment, drawn left to right; see the file header. */
    readonly chips?: readonly StatusChip[] | undefined;
    readonly notices?: (StatusNotices | null) | undefined;
    readonly notice?: ({
        readonly text: string;
        readonly tone: 'error' | 'info';
    } | null) | undefined;
    readonly busy?: (StatusBusyState | null) | undefined;
    readonly branch?: (StatusBranch | null) | undefined;
    /** The serving model's display name. */
    readonly model?: (string | null) | undefined;
    readonly background?: (StatusBackgroundState | null) | undefined;
    /** Formatted cost text ("~$0.246", "you ~$0.25 · fleet ~$0.47"); omitted when unknown. */
    readonly cost?: (string | null) | undefined;
    readonly context?: (StatusContextState | null) | undefined;
    /**
     * Keys of the view the keyboard is in, shown in place of the notices, the
     * esc hint and the background summary (the conversation work tree: move,
     * fold, open, copy, back).
     */
    readonly keys?: (readonly KitHint[] | null) | undefined;
    /** A piece drawn after the keys (an agent view keeps main in sight: "◐ main · working"). */
    readonly trail?: ({
        readonly text: string;
        readonly fg: string;
    } | null) | undefined;
}
interface Run {
    readonly text: string;
    readonly fg: string;
    readonly bold?: boolean | undefined;
    readonly bg?: string | undefined;
}
function putText(line: Line, x: number, endX: number, run: Run): number {
    let cx = x;
    for (const ch of run.text) {
        const w = getDisplayWidth(ch);
        if (w <= 0)
            continue;
        if (cx + w > endX || cx >= line.length)
            break;
        line[cx] = { char: ch, fg: run.fg, bg: run.bg ?? '', bold: run.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
        if (w === 2 && cx + 1 < line.length)
            line[cx + 1] = { ...line[cx]!, char: '' };
        cx += w;
    }
    return cx;
}
function putRuns(line: Line, x: number, endX: number, runs: readonly Run[]): number {
    let cx = x;
    for (const run of runs)
        cx = putText(line, cx, endX, run);
    return cx;
}
function runsWidth(runs: readonly Run[]): number {
    return runs.reduce((sum, r) => sum + getDisplayWidth(r.text), 0);
}
/** A keycap: the key bold on the keycap fill, one column of fill either side. */
function keycapRun(key: string): Run {
    const t = activeTokens();
    return { text: ` ${key} `, fg: t.text, bg: t.border, bold: true };
}
function contextFraction(state: StatusContextState): number {
    if (state.windowTokens === null || !(state.windowTokens > 0))
        return 0;
    return Math.max(0, Math.min(1, state.usedTokens / state.windowTokens));
}
/** "context 34%" (the percent in the warning color from 65%, the error color at the compaction threshold), "context unknown", "context unavailable". */
function contextRuns(state: StatusContextState): Run[] {
    const t = activeTokens();
    const label: Run = { text: 'context ', fg: t.textFaint };
    if (state.available === false)
        return [label, { text: 'unavailable', fg: t.textMuted }];
    if (state.windowTokens === null)
        return [label, { text: 'unknown', fg: t.textMuted }];
    const used = contextFraction(state);
    const threshold = Math.max(0, Math.min(1, state.compactFraction > 0 ? state.compactFraction : 1));
    const hot = used >= threshold ? t.error : used >= CONTEXT_WARN_FRACTION ? t.warning : null;
    return [label, { text: `${Math.round(used * 100)}%`, fg: hot ?? t.textMuted, bold: hot !== null }];
}
/** The mode's reason in its short form: "decision model unreachable" → "unreachable"; null when it has none. */
function shortBecause(because: string): string | null {
    const last = because.split(' ').pop() ?? '';
    return last === 'unreachable' || last === 'failing' ? last : null;
}
/** How much of the mode segment is drawn. */
interface AsksForm {
    /** The choice and when it takes effect (`Jev decides once a decision model is set`), or in a few words (`you chose Jev decides`). */
    readonly choice: 'full' | 'short';
    /** A failure reason (`decision model unreachable`), whole, short or gone. */
    readonly because: 'full' | 'short' | 'none';
    readonly key: boolean;
}
function asksWordRuns(asks: StatusAsks, form: AsksForm): Run[] {
    const t = activeTokens();
    const flash = asks.flash === true;
    // Inverse while flashing: the whole of the words on the text color, in the
    // panel color (the theme's background can be the terminal's own, no color).
    const paint = (text: string, fg: string, bold?: boolean): Run => flash
        ? { text, fg: t.backgroundPanel, bg: t.text, bold: true }
        : { text, fg, bold };
    if (flash && asks.flashMessage) return [paint(asks.flashMessage, t.text, true)];
    if (!asks.inForce)
        return [paint('Asks: ', t.textFaint), paint(asks.chosen, t.textMuted, false)];
    // The mode in force leads; the choice follows; a failure comes last.
    const runs: Run[] = [paint('Asks: ', t.textFaint), paint(asks.inForce, t.warning, true)];
    const choice = form.choice === 'full' ? asks.chosenWhen ?? asks.chosen : asks.chosenShort ?? asks.chosen;
    runs.push(paint(' · ', t.textFaint), paint(choice, t.textMuted, false));
    // Only a failure is drawn here: a reason that states a choice is what the choice's own words say.
    // A failure with no short form stays whole until it goes.
    const because = asks.failure === true && asks.because
        ? form.because === 'full' ? asks.because : form.because === 'short' ? (shortBecause(asks.because) ?? asks.because) : null
        : null;
    if (because)
        runs.push(paint(' · ', t.textFaint), paint(because, t.textFaint));
    return runs;
}
function asksWidth(asks: StatusAsks, form: AsksForm): number {
    return runsWidth(asksWordRuns(asks, form)) + (form.key && asks.key ? KEY_GAP + getDisplayWidth(asks.key) + 2 : 0);
}
function noticesRuns(notices: StatusNotices): Run[] {
    const t = activeTokens();
    return [{ text: `${notices.count} notice${notices.count === 1 ? '' : 's'}`, fg: t.info, bold: true }];
}
function noticesWidth(notices: StatusNotices, withKey: boolean): number {
    return runsWidth(noticesRuns(notices)) + (withKey && notices.key ? KEY_GAP + getDisplayWidth(notices.key) + 2 : 0);
}
/** `branch main, changed`; with `short`, the state word goes (`branch main`). */
function branchRuns(branch: StatusBranch, short = false): Run[] {
    const t = activeTokens();
    return [{ text: 'branch ', fg: t.textFaint }, { text: branch.changed && !short ? `${branch.name}, changed` : branch.name, fg: t.textMuted }];
}
function modelRuns(model: string): Run[] {
    const t = activeTokens();
    return [{ text: 'model ', fg: t.textFaint }, { text: model, fg: t.textMuted }];
}
function backgroundSummary(bg: StatusBackgroundState): string {
    const parts: string[] = [];
    if (bg.agents > 0)
        parts.push(`${bg.agents} agent${bg.agents === 1 ? '' : 's'} running`);
    if (bg.processes > 0)
        parts.push(`${bg.processes} process${bg.processes === 1 ? '' : 'es'} running`);
    if (parts.length === 0)
        return 'no background work';
    return parts.join(' · ');
}
function backgroundHints(bg: StatusBackgroundState): KitHint[] {
    return bg.focused
        ? (bg.agents + bg.processes > 0 ? [['⏎', 'open'], ['esc', 'back']] : [['esc', 'back']])
        : [['⏎', 'view']];
}
/** What the row shows, decided before anything is painted. */
interface Plan {
    asks: AsksForm;
    chips: StatusChip[];
    notices: boolean;
    /** The notices segment keeps its `ctrl+n` keycap. */
    noticesKey: boolean;
    /** The branch drops its state word (`, changed`). */
    branchShort: boolean;
    summary: boolean;
    cost: boolean;
    context: boolean;
    branch: boolean;
    model: boolean;
    menu: boolean;
}
const MENU: KitHint[] = [['ctrl+p', 'menu']];
/** A bound key as a keycap shows it ("Shift+tab" → "shift+tab"); undefined when the action is unbound. */
export function keycapLabel(comboLabel: string): string | undefined {
    return comboLabel === '(unbound)' ? undefined : comboLabel.toLowerCase();
}
/** Render the status line. */
export function renderStatusLine(options: StatusLineOptions): Line {
    const t = activeTokens();
    const width = options.width;
    const line = createEmptyLine(width);
    for (const cell of line)
        cell.bg = '';
    const rightEdge = width - 3; // exclusive: right-aligned text ends at width-4
    const asks = options.asks ?? null;
    const chips = options.chips ?? [];
    const keys = options.keys && options.keys.length > 0 ? options.keys : null;
    const notice = options.notice ?? null;
    // The notices count, the esc hint and the summary give way to a notice or a view's keys.
    const restMode = !notice && !keys;
    const notices = restMode && options.notices && options.notices.count > 0 ? options.notices : null;
    const escHints: KitHint[] | null = restMode && options.busy ? [['esc', options.busy.escAction ?? 'interrupt']] : null;
    const bg = restMode && options.background && (options.background.focused || options.background.agents + options.background.processes > 0)
        ? options.background
        : null;
    const ctx = options.context && (options.context.windowTokens === null || options.context.windowTokens > 0) ? options.context : null;
    const branch = options.branch ?? null;
    const model = options.model ?? null;
    const cost = options.cost ?? null;
    const plan: Plan = {
        asks: { choice: 'full', because: 'full', key: true },
        chips: [...chips],
        notices: notices !== null,
        noticesKey: true,
        branchShort: false,
        summary: bg !== null,
        cost: cost !== null,
        context: ctx !== null,
        branch: branch !== null,
        model: model !== null,
        menu: true,
    };
    const summaryText = bg ? backgroundSummary(bg) + (bg.progress ? ` · ${bg.progress}` : '') : '';
    const summaryNeed = bg
        ? Math.min(getDisplayWidth(`◐ ${summaryText}`), SUMMARY_MIN) + (bg.focused ? GAP + keycapHintsWidth(backgroundHints(bg)) : 0)
        : 0;
    // Fixed left content after the chips (a notice's text or a view's keys) takes what it needs, up to the row.
    const leadW = notice ? getDisplayWidth(notice.text) : keys ? keycapHintsWidth(keys.slice(0, 1)) : 0;
    const leftWidths = (p: Plan): number[] => {
        const widths: number[] = [];
        if (asks)
            widths.push(asksWidth(asks, p.asks));
        if (p.chips.length > 0)
            widths.push(p.chips.reduce((s, c, i) => s + (i > 0 ? CHIP_GAP : 0) + getDisplayWidth(c.text), 0));
        if (p.notices && notices)
            widths.push(noticesWidth(notices, p.noticesKey));
        if (leadW > 0)
            widths.push(leadW);
        if (escHints)
            widths.push(keycapHintsWidth(escHints));
        if (p.summary)
            widths.push(summaryNeed);
        return widths;
    };
    const rightWidths = (p: Plan): number[] => {
        const widths: number[] = [];
        if (p.cost && cost)
            widths.push(getDisplayWidth(cost));
        if (p.context && ctx)
            widths.push(runsWidth(contextRuns(ctx)));
        if (p.branch && branch)
            widths.push(runsWidth(branchRuns(branch, p.branchShort)));
        if (p.model && model)
            widths.push(runsWidth(modelRuns(model)));
        return widths;
    };
    const total = (p: Plan): number => {
        const left = leftWidths(p);
        const right = rightWidths(p);
        const leftW = left.reduce((s, w, i) => s + (i > 0 ? GAP : 0) + w, 0);
        const rightW = right.reduce((s, w, i) => s + (i > 0 ? RIGHT_GAP : 0) + w, 0)
            + (p.menu ? (right.length > 0 ? GAP : 0) + keycapHintsWidth(MENU) : 0);
        return LEFT_X + leftW + (rightW > 0 ? GAP + rightW : 0);
    };
    const fits = (): boolean => total(plan) <= rightEdge;
    // The decision model failing or out of reach, as opposed to a choice the owner made.
    const failureReason = asks?.failure === true && asks.because !== undefined;
    // Give way in the order of the file header, stopping as soon as the row fits.
    const steps: Array<() => void> = [
        () => { plan.menu = false; },
        () => { plan.cost = false; },
        ...chips.map(() => () => {
            const idx = plan.chips.map((c) => c.keep === true).lastIndexOf(false);
            if (idx >= 0)
                plan.chips.splice(idx, 1);
        }),
        // The choice shortens first (it is never dropped); a failure is kept to the last.
        ...(asks?.inForce ? [() => { plan.asks = { ...plan.asks, choice: 'short' as const }; }] : []),
        () => { plan.noticesKey = false; },
        () => { plan.branchShort = true; },
        () => { plan.context = false; },
        () => { plan.branch = false; },
        ...(failureReason ? [() => { plan.asks = { ...plan.asks, because: 'short' }; }] : []),
        () => { if (!bg?.focused) plan.summary = false; },
        () => { plan.model = false; },
        () => { plan.notices = false; },
        () => { plan.asks = { ...plan.asks, key: false }; },
        ...(failureReason ? [() => { plan.asks = { ...plan.asks, because: 'none' }; }] : []),
    ];
    for (const step of steps) {
        if (fits())
            break;
        step();
    }
    // A later step can free more room than an earlier drop needed (the reason
    // going): give the dropped segments back, most important first, until one does not fit.
    const restores: Array<[() => boolean, () => void, () => void]> = [
        [() => model !== null && !plan.model, () => { plan.model = true; }, () => { plan.model = false; }],
        [() => ctx !== null && !plan.context, () => { plan.context = true; }, () => { plan.context = false; }],
        [() => branch !== null && !plan.branch, () => { plan.branch = true; }, () => { plan.branch = false; }],
        [() => cost !== null && !plan.cost, () => { plan.cost = true; }, () => { plan.cost = false; }],
        [() => !plan.menu, () => { plan.menu = true; }, () => { plan.menu = false; }],
        [() => plan.asks.choice === 'short', () => { plan.asks = { ...plan.asks, choice: 'full' }; }, () => { plan.asks = { ...plan.asks, choice: 'short' }; }],
    ];
    for (const [dropped, restore, undo] of restores) {
        if (!dropped())
            continue;
        restore();
        if (fits())
            continue;
        // A less important segment never takes room a more important one could not have.
        undo();
        break;
    }
    // Paint the right side first, right to left, so the left side knows where it must stop.
    let rx = rightEdge;
    const rightStart = (w: number): number => rx - w;
    if (plan.menu) {
        const w = keycapHintsWidth(MENU);
        paintKeycapHints(line, rightStart(w), rx, MENU, { fg: t.textFaint });
        options.tagRegion?.(line, rx - w, rx, 'commands');
        rx -= w + GAP;
    }
    const rightSegments: Array<{ runs: Run[]; target: StatusTarget }> = [];
    if (plan.cost && cost)
        rightSegments.push({ runs: [{ text: cost, fg: t.textMuted }], target: 'usage' });
    if (plan.context && ctx)
        rightSegments.push({ runs: contextRuns(ctx), target: 'context' });
    if (plan.branch && branch)
        rightSegments.push({ runs: branchRuns(branch, plan.branchShort), target: 'changes' });
    if (plan.model && model)
        rightSegments.push({ runs: modelRuns(model), target: 'model' });
    let drewRight = false;
    for (let i = rightSegments.length - 1; i >= 0; i--) {
        const seg = rightSegments[i]!;
        if (drewRight)
            rx -= RIGHT_GAP - GAP; // segments sit RIGHT_GAP apart; rx already stepped back GAP
        const w = runsWidth(seg.runs);
        const start = rightStart(w);
        if (start < LEFT_X)
            break;
        putRuns(line, start, rx, seg.runs);
        options.tagRegion?.(line, start, rx, seg.target);
        rx = start - GAP;
        drewRight = true;
    }
    // rx is now the right side's first column minus GAP: the left side may run up to it.
    const leftMax = Math.max(LEFT_X, rx);
    let x = LEFT_X;
    const next = (): number => (x > LEFT_X ? x + GAP : x);
    if (asks) {
        const start = x;
        x = putRuns(line, x, rightEdge, asksWordRuns(asks, plan.asks));
        if (plan.asks.key && asks.key)
            x = putText(line, x + KEY_GAP, rightEdge, keycapRun(asks.key));
        options.tagRegion?.(line, start, x, 'mode');
    }
    if (plan.chips.length > 0) {
        let cx = next();
        plan.chips.forEach((chip, i) => {
            if (i > 0)
                cx += CHIP_GAP;
            cx = putText(line, cx, chip.keep ? rightEdge : leftMax, { text: chip.text, fg: chip.fg, bold: chip.bold, bg: chip.bg });
        });
        x = cx;
    }
    if (notice) {
        const from = next();
        x = putText(line, from, Math.max(from, leftMax), { text: truncateDisplay(notice.text, Math.max(0, leftMax - from)), fg: notice.tone === 'error' ? t.error : t.info, bold: true });
        return line;
    }
    if (keys) {
        const from = next();
        // As many whole keys as fit, in order.
        const shown: KitHint[] = [];
        for (const key of keys) {
            if (keycapHintsWidth([...shown, key]) > leftMax - from)
                break;
            shown.push(key);
        }
        x = shown.length > 0 ? paintKeycapHints(line, from, leftMax, shown, { fg: t.textFaint }) : from;
        const trail = options.trail;
        if (trail && shown.length === keys.length && x + GAP + getDisplayWidth(trail.text) <= leftMax)
            putText(line, x + GAP, leftMax, { text: trail.text, fg: trail.fg });
        return line;
    }
    if (plan.notices && notices) {
        const start = next();
        x = putRuns(line, start, rightEdge, noticesRuns(notices));
        if (notices.key && plan.noticesKey)
            x = putText(line, x + KEY_GAP, rightEdge, keycapRun(notices.key));
        options.tagRegion?.(line, start, x, 'notices');
    }
    if (escHints)
        x = paintKeycapHints(line, next(), rightEdge, escHints, { fg: t.textFaint });
    if (plan.summary && bg) {
        const start = next();
        const hints = backgroundHints(bg);
        const end = leftMax;
        if (bg.focused) {
            const text = truncateDisplay(`▸ ${summaryText}`, Math.max(0, end - start - keycapHintsWidth(hints) - GAP));
            x = putText(line, start, end, { text, fg: t.text, bold: true, bg: t.backgroundSelected });
            x = paintKeycapHints(line, x + GAP, end, hints, { fg: t.textFaint });
        }
        else {
            const text = truncateDisplay(`◐ ${summaryText}`, Math.max(0, end - start));
            x = putText(line, start, end, { text, fg: t.brand, bold: true });
        }
        if (x > start)
            options.tagRegion?.(line, start, x, 'agents');
    }
    return line;
}
