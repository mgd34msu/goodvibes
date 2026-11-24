import type { Line } from '@goodvibes/engine/platform/platform/types';
import { calcSessionCost, isModelPriced, type SessionPricing } from '@goodvibes/engine/platform/platform/providers';
import { voiceCaptureRowVisible, type VoiceCaptureIndicatorState } from '../voice-capture-status.js';
import type { ShellFooterView } from '../shell-footer-view.js';
import { formatUsd } from '../format.js';
import { activeTokens } from './theme.js';
import { renderComposer, COMPOSER_FIXED_ROWS } from './composer.js';
import { renderStatusLine, type StatusAsks, type StatusChip } from './status-line.js';
import { getSharedModeFlash } from '../session-permission-mode.js';
import { copyOutcomeWords, lastCopyOutcome } from '../clipboard.js';
import { renderThrobberLine, type ThrobberState } from './throbber.js';
import { renderBackToBottomPill, type BackToBottomState } from './back-to-bottom.js';
import { voiceCaptureChip } from './voice-capture-chip.js';

export interface SharedShellFooterOptions {
  readonly width: number;
  /** The keyboard is in the conversation work tree: the status line shows its keys. */
  readonly workTreeFocused?: boolean | undefined;
  readonly promptText: string;
  readonly promptLineCount: number;
  readonly promptCursorPos?: number | undefined;
  readonly promptFocused?: boolean | undefined;
  readonly usage: { available?: boolean; up: number; down: number; cacheRead?: number; cacheWrite?: number; fleetCostUsd?: number | null; /** The session cost as spent (each response at its own model's price), when the caller has it. */ costUsd?: number | undefined };
  readonly showExitNotice: boolean;
  readonly lastCopyTime: number;
  /** The model the session cost is priced against. */
  readonly model?: string | undefined;
  /** What the session cost is priced with when `usage.costUsd` is absent: the runtime's ProviderRegistry. */
  readonly pricing?: SessionPricing | undefined;
  /** The serving model's display name: the status bar's `model …` segment. */
  readonly modelLabel?: string | undefined;
  /** An agent or process view is showing (session-focus.ts). */
  readonly view?: (ShellFooterView | null) | undefined;
  /** The current branch: the status bar's `branch …` segment; absent outside a repository. */
  readonly branch?: string | undefined;
  /** The working tree differs from HEAD: `branch main, changed`. */
  readonly branchChanged?: boolean | undefined;
  /**
   * The mode in force in words (ModeInForceWords' chosen, inForce, chosenWhen,
   * because, failure): the status bar's `Permissions:` segment. Absent: no mode segment.
   */
  readonly modeWords?: ({ readonly chosen: string; readonly inForce?: string | undefined; readonly chosenWhen?: string | undefined; readonly chosenShort?: string | undefined; readonly because?: string | undefined; readonly failure?: boolean | undefined } | null) | undefined;
  /** The key that changes the mode, as bound ("shift+tab"). */
  readonly modeKey?: string | undefined;
  /** The mode just changed: the `Permissions:` segment flashes (session-permission-mode.ts). */
  readonly modeFlash?: boolean | undefined;
  /** Notices not yet seen in the notifications view: `2 notices`; none at zero. */
  readonly unreadNotices?: number | undefined;
  /** The newest unread notice's title, shown beside the count while the status row has room. */
  readonly newestNotice?: string | undefined;
  /** The key that opens the notifications, as bound ("ctrl+n"). */
  readonly noticesKey?: string | undefined;
  /** The model's context window; null when it is unknown (the meter says "unknown"). */
  readonly contextWindow?: (number | null) | undefined;
  readonly compactThreshold?: number | undefined;
  readonly dangerMode?: boolean | undefined;
  readonly lastInputTokens?: number | undefined;
  readonly contextUsageAvailable?: boolean | undefined;
  readonly commandArgsHint?: string | undefined;
  readonly runningAgentCount: number;
  readonly runningProcessCount: number;
  readonly indicatorFocused: boolean;
  readonly runningAgentProgress?: string | undefined;
  readonly composerFlags?: readonly string[] | undefined;
  readonly composerPendingRisk?: ('none' | 'approval-wait' | 'shell' | 'command' | 'remote') | undefined;
  /**
   * Current execution mode. Named by the status line's mode chip
   * and colors the composer's bar. Cycled by Shift+Tab and toggled by /plan.
   */
  /** Passive context pressure hint from buildContextStatusHint, a row above the composer. */
  readonly contextStatusHint?: (string | null) | undefined;
  /** Output of the user's scriptable status line (`statusline.command`), a row above the composer. */
  readonly scriptableStatusLine?: (string | null) | undefined;
  /** The one-key retry/switch-model affordance's transient hint, topmost while armed. */
  readonly retryHint?: (string | null) | undefined;
  /** True while power.keepAwake holds, renders the always-visible "sleep disabled" chip. */
  /** Live microphone state; a non-null visible state renders the microphone chip. */
  readonly voiceCapture?: (VoiceCaptureIndicatorState | null) | undefined;
  /** What main is doing while it works (a turn, a compaction): the throbber row. Null at rest. */
  readonly throbber?: (ThrobberState | null) | undefined;
  /** A main turn is running: the status line leads with what Esc does now (interrupt, or clear input). */
  readonly turnRunning?: boolean | undefined;
  /**
   * The output is scrolled away from its live bottom: the back-to-bottom pill
   * shows above the input area, and a running turn's esc hint says "back to
   * bottom" (Esc returns there and never interrupts while scrolled). Null or
   * absent at the bottom.
   */
  readonly backToBottom?: (BackToBottomState | null) | undefined;
}

export interface ShellFooterBuildResult {
  readonly lines: Line[];
  readonly height: number;
}

export interface WrappedPromptCursorInfo {
  readonly visibleLines: readonly string[];
  readonly visibleCursorLine: number;
  readonly visibleCursorCol: number;
}

export function statusCostText(
  usage: SharedShellFooterOptions['usage'],
  model: string | undefined,
  pricing: SessionPricing | undefined,
  includeFleet = false,
): string | null {
  if (usage.available === false) return 'usage unavailable';
  const inp = usage.up;
  const out = usage.down;
  // The session's cost as spent, each response at its own model's price; pricing
  // the totals at the current model is only for a caller that has no such figure.
  const main = typeof usage.costUsd === 'number' ? formatUsd(usage.costUsd, { estimated: true })
    : model && pricing && isModelPriced(pricing, model)
      ? formatUsd(calcSessionCost(pricing, inp, out, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, model), { estimated: true }) : null;
  const fleet = usage.fleetCostUsd;
  if (includeFleet && typeof fleet === 'number' && fleet > 0) return `you ${main ?? '~n/a'} · fleet ${formatUsd(fleet, { estimated: true })}`;
  return main;
}
export function promptCursorOffset(info: WrappedPromptCursorInfo): number | undefined {
  if (info.visibleCursorLine < 0) return undefined;
  const precedingChars = info.visibleLines.slice(0, info.visibleCursorLine).reduce((sum: number, line: string) => sum + line.length + 1, 0);
  return precedingChars + info.visibleCursorCol;
}
const WORK_TREE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['esc', 'back to typing'],
  ['↑↓', 'move between beads'],
  ['←→', 'fold / unfold'],
  ['enter', 'open'],
  ['y', 'copy'],
];

/**
 * The newest unread notice's subject (the feed lists newest first): its title,
 * or the first words of its text when it has no title; undefined when none is unread.
 */
export function newestUnreadNoticeTitle<Entry extends { readonly title: string; readonly body?: string | undefined }>(feed: { list(): readonly Entry[]; isUnread(entry: Entry): boolean }): string | undefined {
  const newest = feed.list().find((entry) => feed.isUnread(entry));
  if (!newest) return undefined;
  const title = newest.title.trim();
  if (title !== '') return title;
  const words = (newest.body ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return words.length > 8 ? `${words.slice(0, 8).join(' ')}…` : words.join(' ');
}

export function createShellFooter<Options extends SharedShellFooterOptions>(ports: {
  readonly blankRow: (width: number) => Line;
  readonly renderStatusLine?: typeof renderStatusLine | undefined;
  readonly renderThrobberLine?: typeof renderThrobberLine | undefined;
  readonly decorateStatus?: ((line: Line) => Line) | undefined;
  readonly hints?: ((options: Options) => readonly Line[]) | undefined;
  readonly barColor: (options: Options) => string;
  /** Optional chips after the kept ones (an attached image, the composer's intent), dropped first. */
  readonly flags: (options: Options) => StatusChip[];
  readonly powerNote: (options: Options) => string | undefined;
  readonly cost: (options: Options) => string | null;
  readonly compactFraction: (value: number | undefined) => number;
}) {
  let lastRenderedFooterHeight: number | null = null;
  const blankRow = ports.blankRow;
  const paint = ports.renderStatusLine ?? renderStatusLine;
  const decorate = ports.decorateStatus ?? ((line: Line) => line);
  function estimateShellFooterHeight(promptLineCount: number): number {
    return lastRenderedFooterHeight ?? COMPOSER_FIXED_ROWS + Math.max(1, promptLineCount) + 1;
  }
  function safetyChips(options: Options, includeDanger = true): StatusChip[] {
    const t = activeTokens();
    const chips: StatusChip[] = [];
    if (includeDanger && options.dangerMode) chips.push({ text: '! YOLO', fg: t.error, bold: true, keep: true });
    const voice = options.voiceCapture;
    if (voice && voiceCaptureRowVisible(voice)) chips.push(voiceCaptureChip(voice));
    const power = ports.powerNote(options);
    if (power) chips.push({ text: power, fg: t.warning, bold: true, keep: true });
    return chips;
  }
  function buildShellFooter(options: Options): ShellFooterBuildResult {
    const lines: Line[] = [];
    const view = options.view ?? null;
    // Passive hint rows, topmost first: the retry affordance (actionable, time
    // bounded), the context pressure hint, then the user's scriptable line.
    const above: Line[] = [];
    above.push(...(ports.hints?.(options) ?? []));
    // The throbber: main's activity, led by "main" inside a view.
    if (options.throbber)
      above.push(
        (ports.renderThrobberLine ?? renderThrobberLine)(options.width, view ? { ...options.throbber, owner: 'main' } : options.throbber),
      );
    // The back-to-bottom pill is a fill row: a full empty row keeps it off any text row above it.
    if (options.backToBottom) {
      if (above.length > 0) above.push(blankRow(options.width));
      above.push(renderBackToBottomPill(options.width, options.backToBottom));
    }
    // A full empty row keeps these rows off the transcript (a view's body ends with one already).
    if (above.length > 0 && !view) lines.push(blankRow(options.width));
    lines.push(...above);

    const focused = options.promptFocused ?? !options.indicatorFocused;
    lines.push(
      ...renderComposer({
        width: options.width,
        promptText: options.promptText,
        cursorPos: options.promptCursorPos,
        focused,
        argsHint: options.commandArgsHint,
        modeColor: view ? view.barColor : ports.barColor(options),
        placeholder: view?.placeholder,
        disabledReason: view?.disabledReason,
      }),
    );

    // The left end of the status line: the mode's words, then auto-approve
    // (unless the words already say YOLO), microphone and sleep, kept at any
    // width; the composer flags are dropped first.
    const words = options.modeWords ?? null;
    const asks: StatusAsks | null = words
      ? { chosen: words.chosen, inForce: words.inForce, chosenWhen: words.chosenWhen, chosenShort: words.chosenShort, because: words.because, failure: words.failure, key: options.modeKey, flash: options.modeFlash, flashMessage: getSharedModeFlash().message() ?? undefined }
      : null;
    const saysYolo = words !== null && [words.chosen, words.inForce ?? ''].some((text) => text.includes('YOLO'));
    const chips = [...safetyChips(options, !saysYolo), ...ports.flags(options)];

    const copied = Date.now() - options.lastCopyTime < 2000;
    // "Copied" only when a clipboard program confirmed it; OSC 52 gives no answer.
    const copiedWords = copyOutcomeWords(lastCopyOutcome());
    if (view) {
      // Inside an agent or process view: its keys (what Esc does first), then main kept in sight.
      lines.push(
        decorate(
          paint({
            width: options.width,
            chips: safetyChips(options),
            notice: options.showExitNotice
              ? { text: 'Press Ctrl+C again to exit', tone: 'error' }
              : (view.notice ?? (copied ? { text: copiedWords, tone: 'info' } : null)),
            keys: view.keys,
            // While main works its throbber names what it does; the trail would only repeat "working".
            trail: options.throbber ? null : (view.trail ?? null),
            cost: view.noContext ? null : (view.cost ?? null),
            context: null,
          }),
        ),
      );
      lastRenderedFooterHeight = lines.length;
      return { lines, height: lines.length };
    }
    // Each segment opens its view on a click (status-line.ts tagRegion); elsewhere on the row, Usage.
    lines.push(
      decorate(
        paint({
          width: options.width,
          // One word for what main is doing, before everything else: an open ask outranks a running turn.
          state: options.composerPendingRisk === 'approval-wait' ? 'waiting' : options.turnRunning ? 'working' : null,
          asks,
          chips,
          notices: options.unreadNotices && options.unreadNotices > 0 ? { count: options.unreadNotices, key: options.noticesKey, subject: options.newestNotice } : null,
          notice: options.showExitNotice
            ? { text: 'Press Ctrl+C again to exit', tone: 'error' }
            : copied
              ? { text: copiedWords, tone: 'info' }
              : null,
          // With text in the composer the next Esc clears it; scrolled back, it returns to the
          // bottom; only an empty composer's Esc at the bottom interrupts.
          busy: options.turnRunning
            ? { escAction: options.promptText.trim().length > 0 ? 'clear input' : options.backToBottom ? 'back to bottom' : undefined }
            : null,
          keys: options.workTreeFocused ? WORK_TREE_KEYS : null,
          branch: options.branch ? { name: options.branch, changed: options.branchChanged === true } : null,
          model: options.modelLabel ?? null,
          background: {
            agents: options.runningAgentCount,
            processes: options.runningProcessCount,
            focused: options.indicatorFocused,
            progress: options.runningAgentProgress,
          },
          cost: ports.cost(options),
          // null: the model's window is unknown, and the meter says so; 0 or
          // undefined: no meter (no model yet).
          context:
            options.contextWindow === null || (options.contextWindow !== undefined && options.contextWindow > 0)
              ? {
                  usedTokens: options.lastInputTokens ?? 0,
                  available: options.contextUsageAvailable,
                  windowTokens: options.contextWindow,
                  compactFraction: ports.compactFraction(options.compactThreshold),
                }
              : null,
        }),
      ),
    );
    lastRenderedFooterHeight = lines.length;
    return { lines, height: lines.length };
  }

  return { buildShellFooter, estimateShellFooterHeight };
}
