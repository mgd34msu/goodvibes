import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { calcSessionCost, isModelPriced } from '@goodvibes-jev/engine/sdk/platform/providers';
import { voiceCaptureRowVisible, type VoiceCaptureIndicatorState } from '../voice-capture-status.js';
import type { ShellFooterView } from '../shell-footer-view.js';
import { activeTokens } from './theme.js';
import { renderComposer, COMPOSER_FIXED_ROWS } from './composer.js';
import { renderStatusLine, type StatusChip } from './status-line.js';
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
  readonly usage: { available?: boolean; up: number; down: number; cacheRead?: number; cacheWrite?: number; fleetCostUsd?: number | null };
  readonly showExitNotice: boolean;
  readonly lastCopyTime: number;
  /** The model the session cost is priced against; not drawn (the header names the model). */
  readonly model?: string | undefined;
  readonly workingDir?: string | undefined;
  /** The home directory, drawn as ~ at the start of the working directory. */
  readonly homeDirectory?: string | undefined;
  /** An agent or process view is showing (session-focus.ts). */
  readonly view?: (ShellFooterView | null) | undefined;
  /** The current branch (and dirty marker), shown beside the directory at rest. */
  readonly branch?: string | undefined;
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

function fmtCost(usd: number): string {
  if (!(usd > 0)) return '0.00';
  if (usd < 0.01) return usd.toFixed(4);
  if (usd < 1) return usd.toFixed(3);
  return usd.toFixed(2);
}
export function statusCostText(usage: SharedShellFooterOptions['usage'], model: string | undefined, includeFleet = false): string | null {
  if (usage.available === false) return 'usage unavailable';
  const inp = usage.up;
  const out = usage.down;
  const main =
    model && isModelPriced(model) ? `~$${fmtCost(calcSessionCost(inp, out, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, model))}` : null;
  const fleet = usage.fleetCostUsd;
  if (includeFleet && typeof fleet === 'number' && fleet > 0) return `you ${main ?? '~n/a'} · fleet ~$${fmtCost(fleet)}`;
  return main;
}
function displayDirectory(workingDir: string | undefined, homeDirectory: string | undefined): string | undefined {
  if (!workingDir) return undefined;
  const home = homeDirectory ?? (typeof process !== 'undefined' ? (process.env.HOME ?? '') : '');
  if (!home) return workingDir;
  if (workingDir === home) return '~';
  return workingDir.startsWith(home.endsWith('/') ? home : `${home}/`)
    ? '~' + workingDir.slice(home.replace(/\/$/, '').length)
    : workingDir;
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

export function createShellFooter<Options extends SharedShellFooterOptions>(ports: {
  readonly blankRow: (width: number) => Line;
  readonly renderStatusLine?: typeof renderStatusLine | undefined;
  readonly decorateStatus?: ((line: Line) => Line) | undefined;
  readonly hints?: ((options: Options) => readonly Line[]) | undefined;
  readonly barColor: (options: Options) => string;
  readonly modeChips: (options: Options) => StatusChip[];
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
    if (options.throbber) above.push(renderThrobberLine(options.width, view ? { ...options.throbber, owner: 'main' } : options.throbber));
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

    // The left end of the status line: mode, auto-approve, microphone and
    // sleep are kept at any width; the composer flags are dropped first.
    const chips = [...ports.modeChips(options), ...safetyChips(options, false), ...ports.flags(options)];

    const copied = Date.now() - options.lastCopyTime < 2000;
    if (view) {
      // Inside an agent or process view: its keys (what Esc does first), then main kept in sight.
      lines.push(
        decorate(
          paint({
            width: options.width,
            chips: safetyChips(options),
            notice: options.showExitNotice
              ? { text: 'Press Ctrl+C again to exit', tone: 'error' }
              : (view.notice ?? (copied ? { text: 'Copied', tone: 'info' } : null)),
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
    // A click anywhere on the status line (the context bar, the cost) opens Usage.
    lines.push(
      decorate(
        paint({
          width: options.width,
          chips,
          notice: options.showExitNotice
            ? { text: 'Press Ctrl+C again to exit', tone: 'error' }
            : copied
              ? { text: 'Copied', tone: 'info' }
              : null,
          // With text in the composer the next Esc clears it; scrolled back, it returns to the
          // bottom; only an empty composer's Esc at the bottom interrupts.
          busy: options.turnRunning
            ? { escAction: options.promptText.trim().length > 0 ? 'clear input' : options.backToBottom ? 'back to bottom' : undefined }
            : null,
          keys: options.workTreeFocused ? WORK_TREE_KEYS : null,
          directory: displayDirectory(options.workingDir, options.homeDirectory),
          branch: options.branch,
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
