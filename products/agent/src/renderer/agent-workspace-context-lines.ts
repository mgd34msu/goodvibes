/**
 * The pane beside the workspace's rows. It says, in plain words, what the
 * area is for and what the selected row will do, and shows only facts a
 * command prints: the selected row's command's own short report (read by
 * running that report exactly as the command does, so the pane and the
 * command cannot disagree; a report that reaches past this machine waits for
 * Ctrl+R), a setting's value as `/settings get` reads it, and
 * in Work & Approvals the work view `/work open` shows.
 */
import type { AgentWorkspace, AgentWorkspaceAction, AgentWorkspaceCategory } from '../input/agent-workspace.ts';
import { nativeWorkLedgerLines } from './native-work-ledger.ts';
import { WORKSPACE_PALETTE as PALETTE } from './fullscreen-workspace.ts';
import type { AgentWorkspaceContextLine as ContextLine } from './agent-workspace-style.ts';
import { formatDigestTime } from '../core/away-digest.ts';

/** Report lines shown in the pane; the rest is one command away. */
const REPORT_LINES = 8;

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
      { text: 'As /settings get shows it.', fg: PALETTE.dim, dim: true },
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
  // Four states, each in its own words: not read yet, reading, read (with when), could not read.
  const heading = (text: string): ContextLine[] => [{ text: '', fg: PALETTE.muted }, { text, fg: PALETTE.title, bold: true }];
  if (report.waiting) return [...heading(`${report.line}: not read yet`), { text: 'It reaches past this computer, so it is read only when you ask: press ctrl+r.', fg: PALETTE.dim, dim: true }];
  if (report.lines === null || report.readAt === undefined) return [...heading(`${report.line}: reading…`)];
  const when = `read at ${formatDigestTime(report.readAt)}`;
  if (report.failed !== undefined) return [...heading(`${report.line}: could not read (${when})`), { text: report.failed, fg: PALETTE.warn }, { text: 'Press ctrl+r to try again.', fg: PALETTE.dim, dim: true }];
  if (report.lines.length === 0) return [...heading(`As ${report.line} showed it, ${when}:`), { text: 'Nothing to show.', fg: PALETTE.muted }];
  const lines = heading(`As ${report.line} showed it, ${when}:`);
  lines.push(...report.lines.slice(0, REPORT_LINES).map((text): ContextLine => ({ text, fg: PALETTE.info })));
  if (report.lines.length > REPORT_LINES) lines.push({ text: `… the rest: ${report.line}`, fg: PALETTE.dim, dim: true });
  return lines;
}

/** Every line of the pane for the selected area and row. */
export function workspacePaneLines(workspace: AgentWorkspace, category: AgentWorkspaceCategory, action: AgentWorkspaceAction | null): ContextLine[] {
  const lines: ContextLine[] = [
    { text: category.label, fg: PALETTE.title, bold: true },
    { text: category.summary, fg: PALETTE.subtitle },
  ];
  if (action) {
    lines.push({ text: '', fg: PALETTE.muted }, { text: action.label, fg: PALETTE.title, bold: true }, ...whatItDoes(workspace, action), ...reportLines(workspace, action));
  }
  if (category.id === 'work') {
    lines.push({ text: '', fg: PALETTE.muted }, { text: 'Your work (/work open)', fg: PALETTE.title, bold: true });
    for (const text of nativeWorkLedgerLines(workspace.nativeWorkLedgerState)) lines.push({ text, fg: PALETTE.info });
  }
  return lines;
}
