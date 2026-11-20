import { PermissionPromptFacts } from '@goodvibes-jev/engine/terminal-shell/permission-prompt-facts';
import { enterAnswer } from '@goodvibes-jev/engine/terminal-shell/blocking-permission-input';
import { activeTokens } from '../renderer/theme.ts';
import { beginModal, clipText, finishModal, wrapLines, type KitHint, type SurfaceLayer } from '../renderer/surface-kit.ts';
import { button, buttonWidth, type ButtonTone } from '../renderer/surface-kit-parts.ts';
import { modalHeightFor, modalTextWidth } from '../renderer/surface-kit-extra.ts';
import { renderDiffView } from '../renderer/diff-view.ts';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { approvalDiffText, approvalHunkDiffText } from './approval-diff.ts';
import type { HunkSelectionState } from '@goodvibes-jev/engine/terminal-shell/hunk-selection';
import { approvalQuestion, buildPermissionApprovalBrief, execFileOperationLines, execRunPlace, fallbackAnalysis } from '@goodvibes-jev/engine/platform/platform/permissions';

import type {
  PermissionPromptRequest,
  PermissionPromptDecision,
  PermissionRequestHandler,
  PermissionRequest,
} from '@goodvibes-jev/engine/platform/platform/permissions';
export type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest };

/**
 * PermissionPromptUI - Renders a permission prompt as a kit modal layer.
 *
 * Stamped over the dimmed screen, above every other modal, while a request
 * is pending. The prompt blocks orchestrator execution until the user responds.
 *
 * Keys:
 *   y / Y        -> Allow once
 *   a then Enter -> Allow for this session
 *   n / N, Esc   -> Deny (the model is told; Ctrl+C stops the turn)
 *   Enter        -> Allow once, or Deny for what cannot be undone
 */
export class PermissionPromptUI extends PermissionPromptFacts {
  /**
   * "Who is asking" line for the two attribution kinds (platform 1.6.1) that have
   * no OTHER rendered channel for it. `background-agent` attribution is
   * deliberately excluded here: it already flows into the fleet
   * ProcessRegistry via `metadata.agentId` (set by the
   * engine's createBrokeredPermissionManager), so a spawned agent's
   * pending ask is attributed on its own ProcessNode. An MCP server
   * elicitation or a sandbox host-access escalation has no ProcessNode to
   * attach to, this prompt is the ONLY place a user learns who/what is
   * asking, so those two kinds render an explicit line. Returns null for
   * `background-agent` and for no-attribution (foreground) requests.
   */
  private static attributionLine(request: PermissionPromptRequest): string | null {
    const attribution = request.attribution;
    if (!attribution) return null;
    if (attribution.kind === 'mcp-server') {
      return `MCP server: ${attribution.serverName}`;
    }
    if (attribution.kind === 'sandbox-escalation') {
      return `Sandbox ${attribution.sandbox}: ${attribution.escalations.join(', ')}`;
    }
    return null;
  }

  /**
   * The facts of a request as label / value pairs. The dialog shows every one; the subject is every
   * command, path, URL or task the call carries (or, for a tool with no known subject, its whole
   * argument object), one per line, and when too long for the screen it is cut in the middle with a marker.
   */
  static promptFacts(request: PermissionRequest): Array<{ label: string; value: string; fg: string }> {
    const tokens = activeTokens();
    const analysis = fallbackAnalysis(request);
    const brief = buildPermissionApprovalBrief(request);
    const { color } = this.getCategoryLabel(request.category);
    const facts: Array<{ label: string; value: string; fg: string }> = [];
    const add = (label: string, value: string, fg: string = tokens.textMuted): void => {
      facts.push({ label, value, fg });
    };
    add('Tool', request.tool, tokens.text);
    const attribution = this.attributionLine(request);
    if (attribution) add('Asked by', attribution);
    // Risk comes before the command or path: that subject can run to many rows, and
    // whatever the screen has to cut must never be the risk.
    add('Risk', `${analysis.riskLevel} (${analysis.classification})`, color);
    add(brief.subjectLabel, brief.subjectValues.join('\n'), tokens.text);
    const fileOps = execFileOperationLines(request.args);
    if (fileOps.length > 0) add('File ops', fileOps.join('\n'), tokens.warning);
    // An exec call can name its own directory (top level or per command) and
    // environment; the owner approves where it runs, not the session's directory.
    const place = request.tool === 'exec' ? execRunPlace(request.args) : undefined;
    add('Directory', place?.workingDirectory ?? request.workingDirectory ?? '(unknown)', place?.workingDirectory ? tokens.text : tokens.textMuted);
    if (place && place.commandLines.length > 0) add('Per command', place.commandLines.join('\n'), tokens.text);
    if (analysis.surface || analysis.blastRadius)
      add('Surface', `${analysis.surface ?? 'generic'}${analysis.blastRadius ? `  radius=${analysis.blastRadius}` : ''}`);
    if (analysis.host) add('Host', analysis.host);
    add('Summary', analysis.summary, tokens.text);
    add('Decision', brief.decisionModeLabel);
    if (analysis.sideEffects && analysis.sideEffects.length > 0) add('Effects', analysis.sideEffects.join(', '));
    for (const reason of analysis.reasons) add('Review', reason);
    add('Checklist', brief.checklist);
    return facts;
  }

  /**
   * The permission dialog as a kit modal layer: an amber cap (red for a high
   * risk), the request's title, the facts wrapped (a command or path longer than the
   * screen keeps its start and end around a "not shown" marker), for a `write` or
   * `edit` the change itself as a diff under the facts, and the three choices.
   * Drawn above every other modal; the keys (y / a / n, Esc denies) live in
   * shell/blocking-input.ts. A command waiting on its terminal shows the answer
   * being typed, masked, in place of the choices. A multi-edit `edit` shows its
   * hunks with checkboxes instead (space toggles, j/k move, Enter applies the
   * selected ones, y applies all, n denies), the keys the TUI card uses.
   */
  static createPromptLayer(
    screenWidth: number,
    screenHeight: number,
    request: PermissionRequest & { readonly replyBuffer?: string | undefined; readonly hunkState?: HunkSelectionState | undefined; readonly rememberArmed?: boolean | undefined },
    view: { readonly awaitingTab?: boolean | undefined } = {},
  ): SurfaceLayer {
    const tokens = activeTokens();
    const analysis = fallbackAnalysis(request);
    const brief = buildPermissionApprovalBrief(request);
    const { label, color } = this.getCategoryLabel(request.category);
    const high = analysis.riskLevel === 'high' || analysis.riskLevel === 'critical';
    const width = modalTextWidth(screenWidth, screenHeight);
    const labelW = 11;
    const valueW = Math.max(8, width - labelW - 1);
    const facts = this.promptFacts(request);
    const hunkState = request.hunkState;
    if (hunkState) {
      facts.push({ label: 'Hunks', value: `${hunkState.selected.size} of ${hunkState.hunks.length} selected`, fg: hunkState.selected.size === 0 ? tokens.warning : tokens.text });
    }
    if (isExecPrompt(request)) {
      const typed = [...(request.replyBuffer ?? '')].length;
      facts.push({ label: 'Answer', value: typed > 0 ? '•'.repeat(typed) : '(type the answer; Enter sends it)', fg: tokens.text });
    }
    const factRows = facts.reduce((n, fact) => n + wrapLines(fact.value, valueW).length, 0);
    // No change can show more source lines than the screen has rows, so none past that are drawn.
    const diff = hunkState ? approvalHunkDiffText(hunkState, Math.max(1, screenHeight)) : approvalDiffText(request, Math.max(1, screenHeight));
    const diffLines = diff ? renderDiffView(diff.text, width) : [];
    const body = factRows + diffLines.length + (diff && diff.hiddenLines > 0 ? 1 : 0) + 2;
    // While the composer holds a draft every key but Tab and Ctrl+C types into it.
    // After `a` the card itself says what Enter now does (a toast waits while the card is open).
    const hints = view.awaitingTab ? AWAITING_TAB_HINTS : hunkState ? HUNK_HINTS : request.rememberArmed ? REMEMBER_ARMED_HINTS
      : promptHints(request, (request.replyBuffer ?? '').length > 0);
    const height = modalHeightFor(screenWidth, screenHeight, { hints }, body);
    const f = beginModal(screenWidth, screenHeight, {
      title: approvalQuestion(request),
      sub: label.toLowerCase(),
      hints,
      height,
      center: true,
      cap: high ? 'danger' : 'warning',
      titleGlyph: { char: '△', fg: color },
      escKey: false,
    });
    let y = f.top;
    const capacity = Math.max(0, f.bottom - 1 - f.top);
    const subjectIndex = facts.findIndex((fact) => fact.label === brief.subjectLabel);
    const diffRows = fitDiffRows(diffLines, diff ?? { hiddenLines: 0, totalLines: 0 }, capacity, factRows);
    for (const fact of fitFactRows(facts, valueW, capacity - diffRows.length, subjectIndex, tokens.warning)) {
      if (fact.label) f.canvas.put(f.l, y, fact.label, { fg: tokens.textFaint });
      f.canvas.put(f.l + labelW + 1, y++, fact.text, { fg: fact.fg });
    }
    for (const row of diffRows) {
      if (typeof row === 'string') f.canvas.put(f.l, y++, clipText(row, width), { fg: tokens.warning });
      else drawLine(f.canvas.lines[y++], f.l, row);
    }
    // The choices, as chips on the last body row.
    let x = f.l;
    const by = f.bottom;
    for (const [key, text, tone] of hunkState ? HUNK_CHOICES : promptChoices(request)) {
      if (x + buttonWidth(`${text} ${key}`) > f.r) break;
      x = button(f.canvas, x, by, `${text} ${key}`, request.rememberArmed === true && key === 'a', tone) + 2;
    }
    return finishModal(f);
  }
}

/**
 * Lay the wrapped facts out in `capacity` rows. When they do not fit, the subject (command or
 * path) is cut in the middle first, so its start and its end both stay visible, with a marker
 * saying how many rows are not shown. If the other facts still do not fit (a very small
 * terminal) the rows after the last one that fits are replaced by the same kind of marker.
 */
function fitFactRows(
  facts: ReadonlyArray<{ label: string; value: string; fg: string }>,
  valueW: number,
  capacity: number,
  subjectIndex: number,
  markerFg: string,
): Array<{ label: string; text: string; fg: string }> {
  const wrapped = facts.map((fact) => wrapLines(fact.value, valueW));
  const total = wrapped.reduce((n, rows) => n + rows.length, 0);
  const subject = subjectIndex >= 0 ? wrapped[subjectIndex]! : null;
  if (total > capacity && subject) {
    const budget = Math.max(3, capacity - (total - subject.length));
    if (subject.length > budget) {
      const head = Math.ceil((budget - 1) / 2);
      const tail = budget - 1 - head;
      const hidden = subject.length - head - tail;
      wrapped[subjectIndex] = [
        ...subject.slice(0, head),
        `… ${hidden} more row${hidden === 1 ? '' : 's'} not shown …`,
        ...subject.slice(subject.length - tail),
      ];
    }
  }
  const rows: Array<{ label: string; text: string; fg: string }> = [];
  facts.forEach((fact, index) => {
    wrapped[index]!.forEach((text, row) => rows.push({ label: row === 0 ? fact.label : '', text, fg: fact.fg }));
  });
  if (rows.length <= capacity) return rows;
  const shown = Math.max(0, capacity - 1);
  const hidden = rows.length - shown;
  return [
    ...rows.slice(0, shown),
    ...(capacity > 0 ? [{ label: '', text: `… ${hidden} more row${hidden === 1 ? '' : 's'} not shown; enlarge the terminal …`, fg: markerFg }] : []),
  ];
}

/** Rows a diff keeps when the card is short of room, so a cramped screen still shows the start of the change. */
const MIN_DIFF_ROWS = 6;

/**
 * The diff rows the card draws in `capacity` rows that the facts share. The facts come first;
 * the diff takes what they leave, but never fewer than MIN_DIFF_ROWS while the card has them.
 * A diff that does not fit, or whose source was longer than was drawn, keeps its start and ends
 * in a marker row (a string) saying the rest is not shown and how long the whole change is.
 */
function fitDiffRows(
  lines: readonly Line[],
  source: { readonly hiddenLines: number; readonly totalLines: number },
  capacity: number,
  factRows: number,
): Array<Line | string> {
  if (lines.length === 0 || capacity <= 0) return [];
  const budget = Math.min(capacity, Math.max(Math.min(MIN_DIFF_ROWS, capacity), capacity - factRows));
  if (source.hiddenLines === 0 && lines.length <= budget) return [...lines];
  const shown = Math.min(lines.length, Math.max(0, budget - 1));
  return [...lines.slice(0, shown), `… the rest of the change is not shown (${source.totalLines} diff lines in all); enlarge the terminal …`];
}

/** Copy a rendered row onto the card from column `x`. */
function drawLine(target: Line | undefined, x: number, row: Line): void {
  if (!target) return;
  row.forEach((cell, i) => {
    if (x + i < target.length) target[x + i] = cell;
  });
}

/** Keycap hints of the permission dialog (the keys live in shell/blocking-input.ts). */
const PROMPT_HINTS: readonly KitHint[] = [
  ['y, enter', 'allow once'],
  ['a then enter', 'allow for this session'],
  ['n, esc', 'deny'],
];
/** For what cannot be undone Enter answers No (terminal-shell blocking-permission-input.ts enterAnswer). */
const PROMPT_HINTS_ENTER_DENIES: readonly KitHint[] = [
  ['y', 'allow once'],
  ['a then enter', 'allow for this session'],
  ['n, esc, enter', 'deny'],
];
const REMEMBER_ARMED_HINTS: readonly KitHint[] = [
  ['enter', 'allow for the rest of this session'],
  ['any other key', 'go back'],
];
const AWAITING_TAB_HINTS: readonly KitHint[] = [
  ['tab', 'answer this request (your draft stays)'],
  ['ctrl+c', 'deny and stop the turn'],
];
const PROMPT_CHOICES: ReadonlyArray<readonly [key: string, text: string, tone: ButtonTone]> = [
  ['y', 'Allow once', 'primary'],
  ['a', 'Allow for session', 'warning'],
  ['n', 'Deny', 'danger'],
];

/** An ask whose answer is not remembered (it offers an empty remember list) does not offer "for session". */
export function remembersAllow(request: Pick<PermissionRequest, 'rememberOptions'>): boolean {
  return request.rememberOptions === undefined || request.rememberOptions.length > 0;
}
/** An ask to type the answer a running command is waiting for on its terminal. */
function isExecPrompt(request: PermissionRequest): boolean {
  return request.attribution?.kind === 'exec-prompt';
}
function promptHints(request: PermissionRequest, typed = false): readonly KitHint[] {
  if (isExecPrompt(request)) return [['⏎', 'send answer'], ['esc', typed ? 'clear' : 'decline'], ['ctrl+c', 'stop turn']];
  const hints = enterAnswer(request) === 'deny' ? PROMPT_HINTS_ENTER_DENIES : PROMPT_HINTS;
  return remembersAllow(request) ? hints : hints.filter(([key]) => key !== 'a then enter');
}
/** A multi-edit card: the hunk keys shared with the TUI (terminal-shell hunk-selection.ts). */
const HUNK_HINTS: readonly KitHint[] = [
  ['space', 'toggle hunk'],
  ['j/k', 'move'],
  ['enter', 'apply selected'],
  ['y', 'apply all'],
  ['n, esc', 'deny'],
];
const HUNK_CHOICES: typeof PROMPT_CHOICES = [
  ['⏎', 'Apply selected', 'primary'],
  ['y', 'Apply all', 'warning'],
  ['n', 'Deny', 'danger'],
];
const EXEC_PROMPT_CHOICES: typeof PROMPT_CHOICES = [
  ['⏎', 'Send answer', 'primary'],
  ['esc', 'Decline', 'danger'],
];
function promptChoices(request: PermissionRequest): typeof PROMPT_CHOICES {
  if (isExecPrompt(request)) return EXEC_PROMPT_CHOICES;
  return remembersAllow(request) ? PROMPT_CHOICES : PROMPT_CHOICES.filter(([key]) => key !== 'a');
}
