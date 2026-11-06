import { createTerminalPolish } from '@goodvibes-jev/engine/terminal-shell/renderer/polish';
export * from './polish-core.ts';
export * from './polish-tables.ts';
export type * from '@goodvibes-jev/engine/terminal-shell/renderer/polish';
export const {
  buildGuidanceLine,
  buildViewTitle,
  buildBodyText,
  buildSectionHeader,
  buildKeyValueLine,
  buildShortcutLine,
  buildViewListRow,
  buildSearchInputLine,
  buildStatusPill,
  buildStatPill,
  buildMeterLine,
  buildEmptyState,
  buildSummaryBlock,
  buildDetailBlock,
  getViewWorkspaceContentBudget,
  getViewWorkspaceSectionRows,
  getViewScrollableSectionBudget,
  resolvePrimaryScrollableSection,
  resolveScrollableViewSection,
  resolveStackedScrollableSections,
  buildKeyboardHints,
  buildViewWorkspace,
} = createTerminalPolish({ padding: 2, cropSearchTail: true, reserveSummaryRow: true });
