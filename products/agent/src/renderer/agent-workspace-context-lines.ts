/**
 * The pane beside the workspace's rows. It says, in plain words, what the
 * area is for and what the selected row will do, and shows only facts a
 * command prints: the selected row's command's own short report (read by
 * running that report exactly as the command does, so the pane and the
 * command cannot disagree; it is read by itself in the background when its
 * area is shown, and Ctrl+R reads it again), a setting's value as
 * `/settings get` reads it.
 */
import { AGENT_WORKSPACE_REPORT_FRESH_MS, type AgentWorkspace, type AgentWorkspaceAction, type AgentWorkspaceCategory } from '../input/agent-workspace.ts';
import { WORKSPACE_PALETTE as PALETTE } from './fullscreen-workspace.ts';
import type { AgentWorkspaceContextLine as ContextLine } from './agent-workspace-style.ts';
import { formatDigestTime } from '../core/away-digest.ts';

/** Report lines shown in the pane; the rest is one command away. */
const REPORT_LINES = 8;

/**
 * A reading of a report that reaches past this computer (questions waiting on
 * you, host tasks and processes, mailboxes, a provider) is marked "may be out
 * of date" once it is older than AGENT_WORKSPACE_REPORT_FRESH_MS: those change
 * on their own. A report that reads only this computer (notes, skills,
 * routines, personas, homes, secrets, settings) lists stored things that change
 * only when you change them, and a change made from this workspace reads it
 * again, so it is never marked. Decided when the pane is drawn: nothing ticks.
 */

export function compactText(text: string, maxWidth = 104): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxWidth ? normalized : `${normalized.slice(0, maxWidth - 3).trimEnd()}...`;
}

function whatItDoes(workspace: AgentWorkspace, action: AgentWorkspaceAction): ContextLine[] {
  if (action.kind === 'setting') {
    const facts = workspace.settingFacts(action);
    if (!facts) return [{ text: action.detail, fg: PALETTE.muted }];
    return [
      { text: facts.description, fg: PALETTE.muted },
      { text: `${facts.label}: ${facts.currentValue}${facts.currentValue === facts.defaultValue ? ' (the default)' : ` (default ${facts.defaultValue})`}`, fg: PALETTE.info },
      { text: 'As /settings get shows it.', fg: PALETTE.muted },
    ];
  }
  if (action.kind === 'workspace' && action.targetCategoryId) {
    const target = workspace.categories.find((category) => category.id === action.targetCategoryId);
    return [{ text: target ? `Opens ${target.label}: ${target.summary}` : action.detail, fg: PALETTE.muted }];
  }
  return [{ text: action.detail, fg: action.safety === 'blocked' ? PALETTE.warn : PALETTE.muted }];
}

function reportLines(workspace: AgentWorkspace, action: AgentWorkspaceAction): ContextLine[] {
  const command = workspace.reportCommandFor(action);
  const report = command ? workspace.commandReport(command) : undefined;
  if (!report) return [];
  // Three states, each in its own words: reading, read (with when), could not read (with why).
  const heading = (text: string): ContextLine[] => [{ text: '', fg: PALETTE.muted }, { text, fg: PALETTE.title, bold: true }];
  if (report.lines === null || report.readAt === undefined) return [...heading(`${report.line}: reading…`)];
  const failedHeading = (): ContextLine[] => [{ text: '', fg: PALETTE.muted }, { text: `${report.line}: could not read it (tried at ${formatDigestTime(report.readAt!)})`, fg: PALETTE.warn, bold: true }];
  if (report.daemonUnanswered !== undefined) {
    // The connected daemon did not answer: said plainly, with what is shown instead (the command's own
    // lines when it fell back to this computer), and it is read again by itself when the daemon answers.
    const shown = report.lines.length > 0
      ? report.lines.slice(0, REPORT_LINES).map((text): ContextLine => ({ text, fg: PALETTE.info }))
      : [{ text: `The daemon at ${report.daemonUnanswered} did not answer.`, fg: PALETTE.warn }];
    return [...failedHeading(), ...shown, { text: 'GoodVibes reads this again when that daemon answers.', fg: PALETTE.muted }];
  }
  if (report.failed !== undefined) return [...failedHeading(), { text: report.failed, fg: PALETTE.warn }, { text: 'GoodVibes reads this again the next time you open this area; ctrl+r to try now.', fg: PALETTE.muted }];
  const stale = workspace.reportReach(action) === 'past' && Date.now() - report.readAt > AGENT_WORKSPACE_REPORT_FRESH_MS;
  const readHeading = (): ContextLine[] => [
    { text: '', fg: PALETTE.muted },
    { text: `As ${report.line} showed it, read at ${formatDigestTime(report.readAt!)}${stale ? ', may be out of date: ctrl+r to read again' : ''}:`, fg: stale ? PALETTE.warn : PALETTE.title, bold: true },
  ];
  if (report.lines.length === 0) return [...readHeading(), { text: 'Nothing to show.', fg: PALETTE.muted }];
  const lines = readHeading();
  lines.push(...report.lines.slice(0, REPORT_LINES).map((text): ContextLine => ({ text, fg: PALETTE.info })));
  if (report.lines.length > REPORT_LINES) lines.push({ text: `… the rest: ${report.line}`, fg: PALETTE.muted });
  return lines;
}

/** Every line of the pane for the selected area and row. */
export function workspacePaneLines(workspace: AgentWorkspace, category: AgentWorkspaceCategory, action: AgentWorkspaceAction | null): ContextLine[] {
  // The selected row first (the area is named in the header), then what the area is for.
  const lines: ContextLine[] = [];
  if (action) {
    lines.push({ text: action.label, fg: PALETTE.title, bold: true }, ...whatItDoes(workspace, action), ...reportLines(workspace, action), { text: '', fg: PALETTE.muted });
  }
  lines.push(
    { text: category.label, fg: PALETTE.title, bold: true },
    { text: category.summary, fg: PALETTE.subtitle },
  );
  return lines;
}
