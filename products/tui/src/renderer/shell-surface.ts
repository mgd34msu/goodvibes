import { createShellFooter, statusCostText as priceUsage } from '@goodvibes/engine/terminal-shell/shell-footer';
import type { Line } from '@goodvibes/engine/platform/platform/types';
import type { SessionPricing } from '@goodvibes/engine/platform/platform/providers';
import { UIFactory } from './ui-factory.ts';
import { type VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { activeTokens, activeUiTones } from './theme.ts';
import { permissionModeTone } from '../core/permission-mode.ts';
import { SLEEP_DISABLED_CHIP } from '../core/power-status.ts';
import { renderStatusLine, type StatusChip } from './status-line.ts';
import { type ThrobberState } from './throbber.ts';
import { type BackToBottomState } from './back-to-bottom.ts';
import { tagFooterLine } from './footer-targets.ts';
import { wrapText } from '../utils/terminal-width.ts';

/**
 * shell-surface.ts, everything under the transcript, top to bottom:
 *
 *   blank row     one full empty row under the transcript, drawn only when a
 *                 text row follows (a half row cannot be drawn between two
 *                 rows of plain text). An agent or process view's body
 *                 already ends with one, so views skip it.
 *   hint rows     the retry affordance, context pressure, the scriptable
 *                 status line, when they have something to say
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
 * At rest that is 6 rows (input area 5 + status 1), and with the header the
 * resting chrome is 7. While main works, 2 more: the blank row and the
 * throbber; while the output is scrolled back, 2 more: an empty row and the
 * back-to-bottom pill. The input area holds only input (its placeholder,
 * even while the keyboard is in the work tree). Token totals, the per-turn
 * history, tool count, notification mode, the session spine and the web
 * surface address live in the Usage modal and /status, not on the main
 * screen. What stays always visible is safety: the approval mode and the
 * auto-approve warning, the live microphone and the sleep-disabled chip (the
 * left end of the status line), the failover marker (the header, after the
 * model) and the compaction-pressure hint (a hint row above the input area).
 */

/**
 * The work tree's keys, shown on the status line while the keyboard is in it.
 * Esc leads: the way back to typing is never dropped for lack of room; the
 * other keys give way from the end (status-line.ts keeps whole keys in order).
 */
import type { ShellFooterView } from '@goodvibes/engine/terminal-shell/shell-footer-view';
export type { ShellFooterView };

export interface ShellFooterBuildOptions {
  readonly submissionStatus?: string | null;
  readonly width: number;
  /** The keyboard is in the conversation work tree: the status line shows its keys. */
  readonly workTreeFocused?: boolean;
  readonly promptText: string;
  readonly promptLineCount: number;
  readonly promptCursorPos?: number;
  readonly promptFocused?: boolean;
  /** `costUsd` is the session cost as spent (each response at its own model's price); without it the totals are priced at `model`. */
  readonly usage: { available?: boolean; up: number; down: number; cacheRead?: number; cacheWrite?: number; fleetCostUsd?: number | null; costUsd?: number | undefined };
  readonly showExitNotice: boolean;
  readonly lastCopyTime: number;
  /** The model the session cost is priced against. */
  readonly model?: string;
  /** What the session cost is priced with when `usage.costUsd` is absent: the runtime's ProviderRegistry. */
  readonly pricing?: SessionPricing | undefined;
  /** An agent or process view is showing (session-focus.ts). */
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
  readonly compactThreshold?: number;
  readonly dangerMode?: boolean;
  readonly lastInputTokens?: number;
  readonly contextUsageAvailable?: boolean;
  readonly commandArgsHint?: string;
  readonly runningAgentCount: number;
  readonly runningProcessCount: number;
  readonly indicatorFocused: boolean;
  readonly runningAgentProgress?: string;
  readonly composerFlags?: readonly string[];
  readonly composerPendingRisk?: 'none' | 'approval-wait' | 'shell' | 'command' | 'remote';
  /** The execution mode in force: colors the composer's bar. Cycled by Shift+Tab and toggled by /plan. */
  readonly permissionMode?: string;
  /** Passive context pressure hint from buildContextStatusHint, a row above the composer. */
  readonly contextStatusHint?: string | null;
  /** Output of the user's scriptable status line (`statusline.command`), a row above the composer. */
  readonly scriptableStatusLine?: string | null;
  /** The one-key retry/switch-model affordance's transient hint, topmost while armed. */
  readonly retryHint?: string | null;
  /** A contract's open question the next typed message answers (contract-question-composer.ts). */
  readonly contractQuestionHint?: string | null;
  /** True while power.keepAwake holds, renders the always-visible "sleep disabled" chip. */
  readonly powerKeepAwake?: boolean;
  /** Live microphone state; a non-null visible state renders the microphone chip. */
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

/** The status line under the composer. */

function blankRow(width: number): Line {
  const line = UIFactory.stringToLine('', width);
  for (const cell of line) cell.bg = '';
  return line;
}

/**
 * Real height of the most recently rendered footer. estimateShellFooterHeight
 * prefers it so the pre-render viewport math accounts for the hint rows the
 * static formula cannot see. Null before any footer has rendered.
 */

/**
 * The wrapped-prompt shape the composer reports each frame, the subset
 * promptCursorOffset needs (see InputHandler.getWrappedPromptInfo).
 */

/**
 * Flatten a wrapped-prompt cursor position (line + column) into the single
 * character offset the composer's `cursorPos` expects, counting one separator
 * per wrapped line. Undefined when the cursor is not on a visible line.
 */

/** Rows the footer will take for this many prompt rows (exact when no hint rows show). */

/** The composer's bar color: the session mode, or shell while a shell command is typed. */
function composerBarColor(permissionMode: string | undefined, shell: boolean): string {
  const t = activeTokens();
  if (shell) return t.accent;
  const tone = permissionModeTone(permissionMode);
  return tone === 'info' ? t.info : tone === 'caution' ? t.warning : t.brand;
}

/** "~$0.246", or "you ~$0.25 · fleet ~$0.47" once delegated agents have cost something (estimates, hence the ~). */
export const statusCostText = (usage: ShellFooterBuildOptions['usage'], model: string | undefined, pricing: SessionPricing | undefined) =>
  priceUsage(usage, model, pricing, true);

export { promptCursorOffset, type WrappedPromptCursorInfo } from '@goodvibes/engine/terminal-shell/shell-footer';

export const { buildShellFooter, estimateShellFooterHeight } = createShellFooter<ShellFooterBuildOptions>({
  blankRow,
  renderStatusLine,
  cost: (options) => statusCostText(options.usage, options.model, options.pricing),
  decorateStatus: (line) => tagFooterLine(line, 'usage'),
  hints(options) {
    const t = activeTokens();
    const above: Line[] = [];
    if (options.submissionStatus) {
      const status = options.submissionStatus.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
      for (const line of wrapText(status, Math.max(1, options.width - 6)).slice(0, 4))
        above.push(UIFactory.stringToLine(`   ${line}`, options.width, { fg: t.textMuted }));
    }
    if (options.contractQuestionHint) above.push(UIFactory.stringToLine(`   ${options.contractQuestionHint}`, options.width, { fg: t.textMuted, bold: true }));
    if (options.retryHint) above.push(UIFactory.stringToLine(`   ${options.retryHint}`, options.width, { fg: t.textMuted, bold: true }));
    if (options.contextStatusHint)
      above.push(UIFactory.stringToLine(`   ${options.contextStatusHint}`, options.width, { fg: t.textMuted }));
    if (options.scriptableStatusLine)
      above.push(UIFactory.stringToLine(`   ${options.scriptableStatusLine}`, options.width, { fg: t.textMuted }));
    return above;
  },
  barColor: (options) => composerBarColor(options.permissionMode, options.composerPendingRisk === 'shell'),
  powerNote: (options) => (options.powerKeepAwake ? SLEEP_DISABLED_CHIP : undefined),
  compactFraction: (value) => (value && value > 0 ? value : 0.85),
  flags(options) {
    const t = activeTokens();
    const chips: StatusChip[] = [];
    for (const flag of options.composerFlags ?? []) {
      if (flag === 'shell') continue;
      const remote = flag === 'orchestration' && options.composerPendingRisk === 'remote';
      chips.push({ text: flag, fg: remote ? activeUiTones().chrome.remote : t.textFaint, bold: remote });
    }
    return chips;
  },
});
