/**
 * The pane beside the workspace's rows. It says, in plain words, what the
 * area is for and what the selected row will do, and shows only facts a
 * command prints: the selected row's command's own short report (read by
 * running that report exactly as the command does, so the pane and the
 * command cannot disagree), a setting's value as `/settings get` reads it, and
 * in Work & Approvals the work view `/work open` shows.
 */
import type { AgentWorkspace, AgentWorkspaceAction, AgentWorkspaceCategory } from '../input/agent-workspace.ts';
import { nativeWorkLedgerLines } from './native-work-ledger.ts';
import { WORKSPACE_PALETTE as PALETTE } from './fullscreen-workspace.ts';
import type { AgentWorkspaceContextLine as ContextLine } from './agent-workspace-style.ts';

/** Report lines shown in the pane; the rest is one command away. */
const REPORT_LINES = 8;

export function compactText(text: string, maxWidth = 104): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxWidth ? normalized : `${normalized.slice(0, maxWidth - 3).trimEnd()}...`;
}

/** The command whose report goes with a row, if it has one. */
function reportCommandOf(action: AgentWorkspaceAction): string | undefined {
  if (action.kind === 'act') return action.act?.command;
  if (action.kind === 'model-picker') return 'model';
  return undefined;
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
  const command = reportCommandOf(action);
  const report = command ? workspace.commandReport(command) : undefined;
  if (!report) return [];
  const lines: ContextLine[] = [{ text: '', fg: PALETTE.muted }, { text: `Now, as ${report.line} shows it:`, fg: PALETTE.title, bold: true }];
  if (report.lines === null) return [...lines, { text: 'Reading…', fg: PALETTE.dim, dim: true }];
  if (report.lines.length === 0) return [...lines, { text: 'Nothing to show.', fg: PALETTE.muted }];
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
