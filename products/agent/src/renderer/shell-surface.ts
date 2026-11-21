import { renderThrobberLine } from './throbber.ts';
import { createShellFooter, statusCostText as priceUsage } from '@goodvibes/engine/terminal-shell/shell-footer';
import { presetForMode, type GatePresetName } from '@goodvibes/engine/platform/platform/gate';
import { type Line, createEmptyLine } from '@goodvibes/engine/platform/platform/types';
import type { SessionPricing } from '@goodvibes/engine/platform/platform/providers';
import { type VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { activeTokens, activeUiTones } from './theme.ts';
import { UIFactory } from './ui-factory.ts';
import { renderStatusLine, type StatusChip } from './status-line.ts';
import { type ThrobberState } from './throbber.ts';
import { type BackToBottomState } from './back-to-bottom.ts';

/**
 * shell-surface.ts, everything under the transcript, top to bottom:
 *
 *   blank row     one full empty row under the transcript, drawn only with
 *                 the throbber (a half row cannot be drawn between two rows
 *                 of plain text). An agent or process view's body already
 *                 ends with one, so views skip it.
 *   throbber      what main is doing right now, only while it works
 *                 (throbber.ts)
 *   back to bottom  the pill, centered, only while the output is scrolled
 *                 away from its live bottom (back-to-bottom.ts); a fill row,
 *                 so a full empty row keeps it off the text above it
 *   input area    ▄ cap, padding, text, padding, ▀ cap (composer.ts): the
 *                 caps are the half rows between the input area and the rows
 *                 above and below it
 *   status line   one row of session state
 *
 * At rest that is 6 rows (input area 5 + status 1); with the header, the
 * resting chrome is 7 rows. While main works, 2 more: the blank row and the
 * throbber; while the output is scrolled back, 2 more: an empty row and the
 * back-to-bottom pill. The composer holds only input (its placeholder, even
 * while the keyboard is in the work tree). The status line (status-line.ts)
 * opens with the mode in force in words (`Asks: Jev decides`, and why when it
 * differs) and its `shift+tab` key, then the chips that are never dropped for
 * lack of room: "! YOLO" in the error color while everything is
 * auto-approved, the live microphone and the power chip ("sleep disabled" /
 * "sleep held"); the composer's intent; the unread notices with `ctrl+n`;
 * while a turn runs, the `esc` interrupt keycap; any background work. On the
 * right: the cost, `context 34%`, `model …` and the `ctrl+p` keycap for the
 * Agent workspace.
 *
 * Inside an agent or process view (shell/session-views.ts) the composer's bar
 * takes that session's color and its own placeholder (or a one-line reason in
 * place of input), and the status line shows the view's keys, the first of
 * which says what the next Esc does, then main kept in sight.
 */

import type { ShellFooterView } from '@goodvibes/engine/terminal-shell/shell-footer-view';
export type { ShellFooterView };

export interface ShellFooterBuildOptions {
  readonly width: number;
  readonly promptText: string;
  readonly promptLineCount: number;
  readonly promptCursorPos?: number;
  readonly promptFocused?: boolean;
  /** The keyboard is in the conversation work tree: the status line shows its keys. */
  readonly workTreeFocused?: boolean;
  /** `costUsd` is the session cost as spent (each response at its own model's price); without it the totals are priced at `model`. */
  readonly usage: { available?: boolean; up: number; down: number; cacheRead?: number; cacheWrite?: number; costUsd?: number | undefined };
  readonly showExitNotice: boolean;
  readonly lastCopyTime: number;
  /** The model the session cost is priced against. */
  readonly model?: string;
  /** What the session cost is priced with when `usage.costUsd` is absent: the runtime's ProviderRegistry. */
  readonly pricing?: SessionPricing | undefined;
  /** An agent or process view is showing (core/session-focus.ts). */
  readonly view?: ShellFooterView | null;
  /** The current branch: the status bar's `branch …` segment; absent outside a repository. */
  readonly branch?: string;
  /** The serving model's display name: the status bar's `model …` segment. */
  readonly modelLabel?: string;
  /** The working tree differs from HEAD: `branch main, changed`. */
  readonly branchChanged?: boolean;
  /** The mode in force in words (ModeInForceWords): the status bar's `Asks:` segment. */
  readonly modeWords?: { readonly chosen: string; readonly inForce?: string; readonly because?: string } | null;
  /** The key that changes the mode, as bound ("shift+tab"). */
  readonly modeKey?: string;
  /** The mode just changed: the `Asks:` segment flashes. */
  readonly modeFlash?: boolean;
  /** Notices not yet seen in the notifications view: `2 notices`; none at zero. */
  readonly unreadNotices?: number;
  /** The key that opens the notifications, as bound ("ctrl+n"). */
  readonly noticesKey?: string;
  /** The model's context window; null when it is unknown (the meter says "unknown"). */
  readonly contextWindow?: number | null;
  /**
   * The compaction threshold. behavior.autoCompactThreshold is stored as a
   * percent (80); a fraction (0.8) is accepted too.
   */
  readonly compactThreshold?: number;
  readonly dangerMode?: boolean;
  readonly executionMode?: GatePresetName | 'unavailable';
  readonly lastInputTokens?: number;
  readonly contextUsageAvailable?: boolean;
  readonly commandArgsHint?: string;
  /** The interaction mode (quiet / balanced / operator), the mode chip's name at rest. */
  readonly hitlMode?: string;
  readonly runningAgentCount: number;
  readonly runningProcessCount: number;
  readonly indicatorFocused: boolean;
  readonly runningAgentProgress?: string;
  /** The submission intent's label (prompt, command, shell, plan, delegation, ...). */
  readonly composerMode?: string;
  readonly composerFlags?: readonly string[];
  readonly composerPendingRisk?: 'none' | 'approval-wait' | 'shell' | 'command' | 'remote';
  /**
   * The power status note (see power-status.ts's describePowerStatus),
   * "sleep disabled" while the owner keep-awake toggle holds, or
   * "held: <reasons>" while the automatic work inhibitor holds. A kept chip at
   * the left end of the status line beside the "! YOLO" warning: both are
   * safety-relevant and both stay visible at once.
   */
  readonly powerNote?: string;
  /** A contract's open question the next typed message answers (contract-question-composer.ts), a row above the composer. */
  readonly contractQuestionHint?: string | null;
  /** Live microphone state; a visible state renders the microphone chip. */
  readonly voiceCapture?: VoiceCaptureIndicatorState | null;
  /** What main is doing while it works (a turn, a compaction): the throbber row. Null at rest. */
  readonly throbber?: ThrobberState | null;
  /** A main turn is running: the status line leads with what Esc does now (interrupt, or clear input). */
  readonly turnRunning?: boolean;
  /**
   * The output is scrolled away from its live bottom: the back-to-bottom pill
   * shows above the input area, and a running turn's esc hint says "back to
   * bottom" (Esc returns there and never interrupts while scrolled). Null or
   * absent at the bottom.
   */
  readonly backToBottom?: BackToBottomState | null;
}

export interface ShellFooterBuildResult {
  readonly lines: Line[];
  readonly height: number;
}

function blankRow(width: number): Line {
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  return line;
}

/** The mode's name and the composer bar's color. */
function composerModeStyle(options: ShellFooterBuildOptions): { label: string; color: string } {
  const t = activeTokens();
  const intent = options.composerMode ?? 'prompt';
  switch (intent) {
    case 'shell':
      return { label: 'shell', color: t.accent };
    case 'command':
      return { label: 'command', color: t.info };
    case 'plan':
      return { label: 'plan', color: t.info };
    case 'delegation':
    case 'orchestration':
      return { label: intent, color: activeUiTones().chrome.remote };
    case 'memory pin':
      return { label: 'memory pin', color: t.secondary };
    default:
      return options.executionMode === 'unavailable'
        ? { label: 'Mode unavailable', color: t.warning }
        : { label: presetForMode(options.executionMode).label, color: t.brand };
  }
}

/**
 * The composer's intent as a chip after the mode's words while it is not an
 * ordinary prompt (shell, command, plan, delegation, memory pin): plan in the
 * info color, a request that leaves this terminal in the remote color.
 */
const INTENTS: ReadonlySet<string> = new Set(['shell', 'command', 'plan', 'delegation', 'orchestration', 'memory pin']);
function intentChips(options: ShellFooterBuildOptions): StatusChip[] {
  const t = activeTokens();
  if (!INTENTS.has(options.composerMode ?? 'prompt')) return [];
  const label = composerModeStyle(options).label;
  const remote = label === 'delegation' || label === 'orchestration';
  const fg = label === 'plan' ? t.info : remote ? activeUiTones().chrome.remote : t.textMuted;
  return [{ text: label, fg, bold: label === 'plan' || remote, keep: true }];
}

/** The compaction threshold as a fraction [0..1] (0.85 when unset or nonsense). */
function compactFraction(value: number | undefined): number {
  if (value === undefined || !(value > 0)) return 0.85;
  return Math.min(1, value > 1 ? value / 100 : value);
}

export const statusCostText = (usage: ShellFooterBuildOptions['usage'], model: string | undefined, pricing: SessionPricing | undefined) =>
  priceUsage(usage, model, pricing, false);

export const { buildShellFooter, estimateShellFooterHeight } = createShellFooter<ShellFooterBuildOptions>({
  blankRow,
  renderStatusLine,
  renderThrobberLine,
  cost: (options) => statusCostText(options.usage, options.model, options.pricing),
  barColor: (options) => composerModeStyle(options).color,
  powerNote: (options) => options.powerNote,
  compactFraction,
  flags: (options) => [
    ...intentChips(options),
    ...((options.composerFlags ?? []).includes('attachments') ? [{ text: 'image attached', fg: activeTokens().info }] : []),
  ],
  hints: (options) => (options.contractQuestionHint
    ? [UIFactory.stringToLine(`   ${options.contractQuestionHint}`, options.width, { fg: activeTokens().textMuted, bold: true })]
    : []),
});
