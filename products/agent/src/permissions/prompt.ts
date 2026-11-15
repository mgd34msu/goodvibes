import { PermissionPromptFacts } from '@goodvibes-jev/engine/terminal-shell/permission-prompt-facts';
import '@goodvibes-jev/engine/terminal-shell/permission-category-label';
import { activeTokens } from '../renderer/theme.ts';
import { beginModal, finishModal, wrapLines, type KitHint, type SurfaceLayer } from '../renderer/surface-kit.ts';
import { button, buttonWidth, type ButtonTone } from '../renderer/surface-kit-parts.ts';
import { modalHeightFor, modalTextWidth } from '../renderer/surface-kit-extra.ts';
import { buildPermissionApprovalBrief, execFileOperationLines, fallbackAnalysis } from '@goodvibes-jev/engine/platform/platform/permissions';

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
 *   y / Y  -> Allow once
 *   a / A  -> Allow always (this session)
 *   n / N  -> Deny
 *   Escape -> Deny
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
    add('Directory', request.workingDirectory ?? '(unknown)');
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
   * screen keeps its start and end around a "not shown" marker), and the three
   * choices. Drawn above every other modal; the keys (y / a / n, Esc denies)
   * live in shell/blocking-input.ts.
   */
  static createPromptLayer(screenWidth: number, screenHeight: number, request: PermissionRequest): SurfaceLayer {
    const tokens = activeTokens();
    const analysis = fallbackAnalysis(request);
    const brief = buildPermissionApprovalBrief(request);
    const { label, color } = this.getCategoryLabel(request.category);
    const high = analysis.riskLevel === 'high' || analysis.riskLevel === 'critical';
    const width = modalTextWidth(screenWidth, screenHeight);
    const labelW = 11;
    const valueW = Math.max(8, width - labelW - 1);
    const facts = this.promptFacts(request);
    const factRows = facts.reduce((n, fact) => n + wrapLines(fact.value, valueW).length, 0);
    const body = factRows + 2;
    const hints = promptHints(request);
    const height = modalHeightFor(screenWidth, screenHeight, { hints }, body);
    const f = beginModal(screenWidth, screenHeight, {
      title: brief.title,
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
    for (const fact of fitFactRows(facts, valueW, capacity, subjectIndex, tokens.warning)) {
      if (fact.label) f.canvas.put(f.l, y, fact.label, { fg: tokens.textFaint });
      f.canvas.put(f.l + labelW + 1, y++, fact.text, { fg: fact.fg });
    }
    // The choices, as chips on the last body row.
    let x = f.l;
    const by = f.bottom;
    for (const [key, text, tone] of promptChoices(request)) {
      if (x + buttonWidth(`${text} ${key}`) > f.r) break;
      x = button(f.canvas, x, by, `${text} ${key}`, false, tone) + 2;
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

/** Keycap hints of the permission dialog (the keys live in shell/blocking-input.ts). */
const PROMPT_HINTS: readonly KitHint[] = [
  ['y', 'allow once'],
  ['a', 'allow for this session'],
  ['n', 'deny'],
  ['esc', 'deny'],
];
const PROMPT_CHOICES: ReadonlyArray<readonly [key: string, text: string, tone: ButtonTone]> = [
  ['y', 'Allow once', 'primary'],
  ['a', 'Allow for session', 'warning'],
  ['n', 'Deny', 'danger'],
];

/** An ask the mode always puts to the owner again is not skipped by a remembered allow, so it is not offered. */
function remembersAllow(request: PermissionRequest): boolean {
  return request.rememberEffect !== 'owner-asked-again';
}
function promptHints(request: PermissionRequest): readonly KitHint[] {
  return remembersAllow(request) ? PROMPT_HINTS : PROMPT_HINTS.filter(([key]) => key !== 'a');
}
function promptChoices(request: PermissionRequest): typeof PROMPT_CHOICES {
  return remembersAllow(request) ? PROMPT_CHOICES : PROMPT_CHOICES.filter(([key]) => key !== 'a');
}
