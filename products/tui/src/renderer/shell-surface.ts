import { createShellFooter, statusCostText as priceUsage } from '@goodvibes-jev/engine/terminal-shell/shell-footer';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import '@goodvibes-jev/engine/sdk/platform/providers';
import { UIFactory } from './ui-factory.ts';
import { type VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { activeTokens, activeUiTones } from './theme.ts';
import { permissionModeLabel, permissionModeTone } from '../core/permission-mode.ts';
import { SLEEP_DISABLED_CHIP } from '../core/power-status.ts';
import './composer.ts';
import { renderStatusLine, type StatusChip } from './status-line.ts';
import { type ThrobberState } from './throbber.ts';
import { type BackToBottomState } from './back-to-bottom.ts';
import './voice-capture-chip.ts';
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
import type { ShellFooterView } from '@goodvibes-jev/engine/terminal-shell/shell-footer-view';
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
  readonly usage: { available?: boolean; up: number; down: number; cacheRead?: number; cacheWrite?: number; fleetCostUsd?: number | null };
  readonly showExitNotice: boolean;
  readonly lastCopyTime: number;
  /** The model the session cost is priced against; not drawn (the header names the model). */
  readonly model?: string;
  readonly workingDir?: string;
  /** The home directory, drawn as ~ at the start of the working directory. */
  readonly homeDirectory?: string;
  /** An agent or process view is showing (session-focus.ts). */
  readonly view?: ShellFooterView | null;
  /** The current branch (and dirty marker), shown beside the directory at rest. */
  readonly branch?: string;
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
  /**
   * Current execution mode. Named by the status line's mode chip
   * and colors the composer's bar. Cycled by Shift+Tab and toggled by /plan.
   */
  readonly permissionMode?: string;
  /** Passive context pressure hint from buildContextStatusHint, a row above the composer. */
  readonly contextStatusHint?: string | null;
  /** Output of the user's scriptable status line (`statusline.command`), a row above the composer. */
  readonly scriptableStatusLine?: string | null;
  /** The one-key retry/switch-model affordance's transient hint, topmost while armed. */
  readonly retryHint?: string | null;
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

/**
 * The status line's mode chip: the approval mode (muted; plan in the info
 * color), or "! YOLO" in the error color while everything is
 * auto-approved. While the warning shows, only plan keeps its name beside it
 * (a read-only posture still worth knowing); another execution label next to it
 * would only repeat or contradict it.
 */
function modeChips(permissionMode: string | undefined, dangerMode: boolean): StatusChip[] {
  const t = activeTokens();
  const chips: StatusChip[] = [];
  if (!dangerMode || permissionMode === 'plan') {
    chips.push({
      text: permissionModeLabel(permissionMode),
      fg: permissionMode === 'plan' ? t.info : t.textMuted,
      bold: permissionMode === 'plan',
      keep: true,
    });
  }
  if (dangerMode) chips.push({ text: '! YOLO', fg: t.error, bold: true, keep: true });
  return chips;
}

/** The chips no view hides: auto-approve, the live microphone, sleep disabled. */

/** Format a USD amount with a precision that suits its magnitude. */

/** "~$0.246", or "you ~$0.25 · fleet ~$0.47" once delegated agents have cost something (estimates, hence the ~). */

export const statusCostText = (usage: ShellFooterBuildOptions['usage'], model: string | undefined) => priceUsage(usage, model, true);

export { promptCursorOffset, type WrappedPromptCursorInfo } from '@goodvibes-jev/engine/terminal-shell/shell-footer';

export const { buildShellFooter, estimateShellFooterHeight } = createShellFooter<ShellFooterBuildOptions>({
  blankRow,
  renderStatusLine,
  cost: (options) => statusCostText(options.usage, options.model),
  decorateStatus: (line) => tagFooterLine(line, 'usage'),
  hints(options) {
    const t = activeTokens();
    const above: Line[] = [];
    if (options.submissionStatus) {
      const status = options.submissionStatus.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
      for (const line of wrapText(status, Math.max(1, options.width - 6)).slice(0, 4))
        above.push(UIFactory.stringToLine(`   ${line}`, options.width, { fg: t.textMuted }));
    }
    if (options.retryHint) above.push(UIFactory.stringToLine(`   ${options.retryHint}`, options.width, { fg: t.textMuted, bold: true }));
    if (options.contextStatusHint)
      above.push(UIFactory.stringToLine(`   ${options.contextStatusHint}`, options.width, { fg: t.textMuted }));
    if (options.scriptableStatusLine)
      above.push(UIFactory.stringToLine(`   ${options.scriptableStatusLine}`, options.width, { fg: t.textMuted }));
    return above;
  },
  barColor: (options) => composerBarColor(options.permissionMode, options.composerPendingRisk === 'shell'),
  modeChips: (options) => modeChips(options.permissionMode, options.dangerMode === true),
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
