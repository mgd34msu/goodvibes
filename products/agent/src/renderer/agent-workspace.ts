import type {
  AgentWorkspace,
  AgentWorkspaceAction,
  AgentWorkspaceCategory,
} from '../input/agent-workspace.ts';
import { workspaceActionLine } from '../input/workspace-actions.ts';
import type { SurfaceLayer } from './surface-kit.ts';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { GLYPHS } from './ui-primitives.ts';
import {
  getFullscreenWorkspaceMetrics,
  padDisplay,
  renderFullscreenWorkspace,
  stableWindow,
  WORKSPACE_PALETTE as PALETTE,
  type WorkspaceRow,
} from './fullscreen-workspace.ts';
import {
  buildActionResultRows,
  reserveForResult,
  settleResultScroll,
  windowResultRows,
} from './agent-workspace-result-rows.ts';

/**
 * Rows the actions pane spends on things that are not action items or result
 * lines: its column header, the blank separator, the status line, and the two
 * possible more-above/more-below markers. Counted so the split does not promise
 * the result room that the chrome has already taken, getting this wrong is
 * what let the result be squeezed out of a short pane entirely.
 */
const ACTION_CHROME_ROWS = 5;

/**
 * The subset of the workspace palette the result block draws with, read per
 * call so it follows the active theme (PALETTE itself is rebuilt in place).
 */
function resultPalette(): { text: string; good: string; muted: string; dim: string } {
  return {
    text: PALETTE.text,
    good: PALETTE.good,
    muted: PALETTE.muted,
    dim: PALETTE.dim,
  };
}
import { actionResultColor, type AgentWorkspaceContextLine as ContextLine } from './agent-workspace-style.ts';
import { workspacePaneLines } from './agent-workspace-context-lines.ts';
import { ONBOARDING_COMPLETE_SYNTHETIC_ACTION } from '../input/agent-workspace-onboarding-finish.ts';

function buildLeftRows(workspace: AgentWorkspace, height: number): WorkspaceRow[] {
  const rows: WorkspaceRow[] = [];
  let selectedRenderedIndex = 0;
  let lastGroup = '';
  workspace.categories.forEach((category, index) => {
    if (category.group !== lastGroup) {
      rows.push({ text: category.group, kind: 'group', bold: true });
      lastGroup = category.group;
    }
    const selected = index === workspace.selectedCategoryIndex;
    if (selected) selectedRenderedIndex = rows.length;
    const marker = selected ? GLYPHS.navigation.selected : ' ';
    rows.push({
      text: `  ${marker} ${category.label}`,
      selected: selected && workspace.focusPane === 'categories',
      kind: 'item',
      fg: selected ? PALETTE.text : PALETTE.muted,
      bold: selected,
    });
  });

  const visible = Math.max(1, height);
  const window = stableWindow(rows.length, selectedRenderedIndex, visible);
  const visibleRows = rows.slice(window.start, window.end);
  if (window.start > 0 && visibleRows.length > 0) {
    visibleRows[0] = { text: `${GLYPHS.navigation.moreAbove} ${window.start} more`, kind: 'more', fg: PALETTE.dim, dim: true };
  }
  if (window.end < rows.length && visibleRows.length > 0) {
    visibleRows[visibleRows.length - 1] = { text: `${GLYPHS.navigation.moreBelow} ${rows.length - window.end} more`, kind: 'more', fg: PALETTE.dim, dim: true };
  }
  while (visibleRows.length < height) visibleRows.push({ text: '', kind: 'empty' });
  return visibleRows.slice(0, height);
}

/** The right-hand column of an action row: the line it runs, or what kind of row it is. */
function actionCommand(action: AgentWorkspaceAction): string {
  if (action.kind === 'act' && action.act) return workspaceActionLine(action.act);
  if (action.kind === 'workspace') return 'open area';
  if (action.kind === 'setting') return action.settingKey ? `setting ${action.settingKey}` : 'setting';
  if (action.kind === 'settings-import') return 'import GoodVibes settings';
  if (action.kind === 'model-picker') return action.modelPickerFlow === 'model' ? 'model picker' : 'provider/model picker';
  if (action.kind === 'settings-modal') return action.settingsTarget ? `settings ${action.settingsTarget}` : 'settings';
  if (action.kind === 'onboarding-complete') return 'apply and close';
  // A guidance row runs nothing; what to do is in its detail.
  return action.command ?? '';
}

function isOnboardingCategory(category: AgentWorkspaceCategory): boolean {
  return category.group === 'ONBOARDING';
}

interface OnboardingActionColumns {
  readonly setting: string;
  readonly defaultValue: string;
  readonly currentValue: string;
}

function onboardingActionColumns(workspace: AgentWorkspace, action: AgentWorkspaceAction): OnboardingActionColumns {
  if (action.kind === 'setting') {
    return workspace.settingActionDisplay(action) ?? {
      setting: action.label,
      defaultValue: '(unknown)',
      currentValue: '(unknown)',
    };
  }
  return { setting: action.label, defaultValue: '', currentValue: '' };
}

/** A setting row in an area that also holds actions: its name, and its value now in the second column. */
function settingNow(workspace: AgentWorkspace, action: AgentWorkspaceAction): string {
  const shown = workspace.settingActionDisplay(action);
  return shown ? `now ${shown.currentValue}` : actionCommand(action);
}

function shouldRenderOnboardingSettingsTable(actions: readonly AgentWorkspaceAction[]): boolean {
  // The Setting / Default / Current table is for an area whose rows are all
  // settings. Where rows are actions, the columns are what each is and the line
  // it runs; a setting among them shows its value now.
  const nonFinish = actions.filter((a) => a.kind !== 'onboarding-complete');
  return nonFinish.length > 0 && nonFinish.every((a) => a.kind === 'setting');
}

function buildContextRows(workspace: AgentWorkspace, category: AgentWorkspaceCategory, action: AgentWorkspaceAction | null, width: number): WorkspaceRow[] {
  const lines: ContextLine[] = workspace.actionSearchActive
    ? [
      { text: 'Search', fg: PALETTE.title, bold: true },
      {
        text: workspace.actionSearchQuery.length > 0
          ? `${workspace.actionSearchResults.length} row${workspace.actionSearchResults.length === 1 ? '' : 's'} match "${workspace.actionSearchQuery}".`
          : 'Type to search every row of every area.',
        fg: workspace.actionSearchQuery.length > 0 && workspace.actionSearchResults.length === 0 ? PALETTE.warn : PALETTE.info,
      },
      { text: '', fg: PALETTE.muted },
      ...workspacePaneLines(workspace, category, action),
    ]
    : workspacePaneLines(workspace, category, action);

  return lines.flatMap((entry): WorkspaceRow[] => {
    if (entry.text.length === 0) return [{ text: '', kind: 'empty', dim: true }];
    return wrapText(entry.text, Math.max(1, width)).map((text, index): WorkspaceRow => ({
      text,
      fg: entry.fg,
      bold: entry.bold && index === 0,
      dim: entry.dim,
    }));
  });
}

function buildActionRows(workspace: AgentWorkspace, width: number, height: number): WorkspaceRow[] {
  const category = workspace.selectedActionCategory;
  const onboarding = isOnboardingCategory(category);
  // Apply the consistent Setting/Default/Current 3-column layout to EVERY category, not
  // just the ONBOARDING group. Different layouts across pages were confusing.
  const settingTable = !workspace.actionSearchActive
    && shouldRenderOnboardingSettingsTable(workspace.actions);
  const rows: WorkspaceRow[] = [];
  // The Default and Current columns are as wide as their widest value (never cut), up to
  // what leaves the label column 18 cells; a label longer than its column wraps onto more rows.
  const columnsByAction = settingTable ? workspace.actions.map((action) => onboardingActionColumns(workspace, action)) : [];
  const widestValue = columnsByAction.reduce((most, columns) => Math.max(most, getDisplayWidth(columns.defaultValue), getDisplayWidth(columns.currentValue)), getDisplayWidth('Current'));
  const valueWidth = settingTable
    ? Math.max(1, Math.min(widestValue, Math.floor((width - 6 - 18) / 2)))
    : 0;
  const labelWidth = settingTable
    ? Math.max(1, width - (valueWidth * 2) - 6)
    : Math.min(34, Math.max(18, Math.floor(width * 0.38)));
  const commandWidth = Math.max(10, width - labelWidth - 6);
  const labelRows = (label: string): string[] => (getDisplayWidth(label) <= labelWidth ? [label] : wrapText(label, labelWidth));
  if (workspace.actionSearchActive) {
    rows.push({
      text: `  Search: ${workspace.actionSearchQuery || '(type to filter actions)'}`,
      fg: workspace.actionSearchQuery.length > 0 && workspace.actions.length === 0 ? PALETTE.warn : PALETTE.info,
      bold: true,
    });
  }
  rows.push({
    text: settingTable
      ? `  ${padDisplay(workspace.actionSearchActive ? 'Result' : 'Setting', labelWidth)}  ${padDisplay('Default', valueWidth)}  ${padDisplay('Current', valueWidth)}`
      : `  ${padDisplay(workspace.actionSearchActive ? 'Result' : 'Action', labelWidth)}  ${padDisplay('Command', commandWidth)}`,
    fg: PALETTE.muted,
    bold: true,
  });

  // The finish footer row is appended to workspace.actions by the input layer
  // (shouldShowOnboardingFinishFooter). Detect it here by action id for special styling.
  const allActions = workspace.actions;
  const finishActionIndex = allActions.findIndex((a) => a.id === ONBOARDING_COMPLETE_SYNTHETIC_ACTION.id);

  // The result block is measured before the action list is windowed, so the
  // list gives up the room the result needs instead of the result being cut off
  // the bottom. Anything the result still cannot fit is reachable by scrolling.
  const chromeRows = workspace.actionSearchActive ? 3 : 2;
  const resultRows = workspace.lastActionResult
    ? buildActionResultRows(workspace.lastActionResult, {
      onboarding,
      width,
      titleColor: actionResultColor(workspace.lastActionResult),
      palette: resultPalette(),
      moreAbove: GLYPHS.navigation.moreAbove,
      moreBelow: GLYPHS.navigation.moreBelow,
    })
    : [];
  // Rows the action list and the result share, once the pane's own headers, the
  // blank separator, the status line and the two possible action markers are
  // paid for. Reserving out of this, rather than out of the raw height, is
  // what stops the reservation promising room the chrome has already spent.
  const usableRows = Math.max(0, height - ACTION_CHROME_ROWS);
  const reservedForResult = reserveForResult(resultRows.length, usableRows);
  const resultScroll = settleResultScroll(workspace, workspace.lastActionResult, resultRows.length, reservedForResult);

  const visibleRows = reservedForResult > 0
    ? Math.max(1, height - ACTION_CHROME_ROWS - reservedForResult)
    : Math.max(1, height - chromeRows);
  // A wrapped label takes more than one row: the window holds as many actions as their rows allow.
  const actionLabel = (index: number): string => {
    const action = allActions[index]!;
    const searchResult = workspace.actionSearchActive ? workspace.actionSearchResults[index] : null;
    return settingTable ? (columnsByAction[index]?.setting ?? action.label) : searchResult ? `${searchResult.category.label} / ${action.label}` : action.label;
  };
  const rowsOf = (span: { start: number; end: number }): number => {
    let used = 0;
    for (let index = span.start; index < span.end; index += 1) used += labelRows(actionLabel(index)).length;
    return used;
  };
  let visible = visibleRows;
  let window = stableWindow(allActions.length, workspace.selectedActionIndex, visible);
  while (visible > 1 && rowsOf(window) > visibleRows) {
    visible -= 1;
    window = stableWindow(allActions.length, workspace.selectedActionIndex, visible);
  }
  if (window.start > 0) rows.push({ text: `${GLYPHS.navigation.moreAbove} ${window.start} more action(s) above`, kind: 'more', fg: PALETTE.dim, dim: true });

  for (let index = window.start; index < window.end; index += 1) {
    const action = allActions[index]!;
    const isFinishFooterRow = finishActionIndex >= 0 && index === finishActionIndex;
    const selected = index === workspace.selectedActionIndex;
    const searchResult = workspace.actionSearchActive ? workspace.actionSearchResults[index] : null;
    const label = searchResult ? `${searchResult.category.label} / ${action.label}` : action.label;
    const marker = selected ? GLYPHS.navigation.selected : ' ';

    if (isFinishFooterRow) {
      // Sticky Finish setup footer row. It is shown only when setup can finish or
      // readiness is not known (shouldShowOnboardingFinishFooter): good colour when
      // a model answers, the neutral colour when it is not known.
      const ready = workspace.onboardingReadyToChat === true;
      const sep = `${GLYPHS.frame.horizontal.repeat(3)} Finish setup ${GLYPHS.frame.horizontal.repeat(3)}`;
      if (!selected) {
        rows.push({
          text: `  ${sep}`,
          kind: 'item',
          fg: PALETTE.dim,
          dim: true,
        });
      }
      const finishDetail = actionCommand(action);
      const text = settingTable
        ? `${marker} ${padDisplay('Finish setup', labelWidth)}  ${padDisplay(finishDetail, (valueWidth * 2) + 2)}`
        : `${marker} ${padDisplay('Finish setup', labelWidth)}  ${padDisplay(finishDetail, commandWidth)}`;
      rows.push({
        text,
        selected: selected && workspace.focusPane === 'actions',
        fg: ready ? PALETTE.good : selected ? PALETTE.text : PALETTE.info,
        bold: selected,
        kind: 'item',
      });
    } else {
      const columns = settingTable ? columnsByAction[index]! : null;
      const [first = '', ...rest] = labelRows(columns ? columns.setting : label);
      const text = columns
        ? `${marker} ${padDisplay(first, labelWidth)}  ${padDisplay(columns.defaultValue, valueWidth)}  ${padDisplay(columns.currentValue, valueWidth)}`
        : `${marker} ${padDisplay(first, labelWidth)}  ${padDisplay(action.kind === 'setting' ? settingNow(workspace, action) : actionCommand(action), commandWidth)}`;
      const style = {
        selected: selected && workspace.focusPane === 'actions',
        fg: action.safety === 'blocked' ? PALETTE.warn : selected ? PALETTE.text : PALETTE.info,
        bold: selected,
      };
      rows.push({ text, ...style });
      for (const more of rest) rows.push({ text: `  ${padDisplay(more, labelWidth)}`, ...style });
    }
  }

  if (window.end < allActions.length) rows.push({ text: `${GLYPHS.navigation.moreBelow} ${allActions.length - window.end} more action(s) below`, kind: 'more', fg: PALETTE.dim, dim: true });
  if (height > 6) rows.push({ text: '' });
  // Wrapped here, where the rows are budgeted, so the result window below
  // accounts for every row the status takes.
  for (const line of wrapText(`Status: ${workspace.status}`, Math.max(1, width))) rows.push({ text: line, fg: PALETTE.muted });
  // `reservedForResult` shrank the action window; this is what is actually left
  // once the headers, markers and status line have taken their rows. Windowing
  // against the real remainder is what keeps the total within the pane, so the
  // final slice can never be the thing that cuts the result.
  const availableForResult = Math.max(0, height - rows.length);
  for (const row of windowResultRows(resultRows, availableForResult, resultScroll, {
    palette: resultPalette(),
    moreAbove: GLYPHS.navigation.moreAbove,
    moreBelow: GLYPHS.navigation.moreBelow,
  })) {
    rows.push(row as WorkspaceRow);
  }

  while (rows.length < height) rows.push({ text: '', kind: 'empty' });
  return rows.slice(0, height);
}

/** Key / action pairs for the keycap hint row (Esc is the title row's keycap). */
function footerText(workspace: AgentWorkspace): string {
  if (workspace.actionSearchActive) {
    return 'Up/Down results · Enter open · Backspace edit search · Esc clear';
  }
  // A printable key closes the workspace into the composer, so refresh is Ctrl+R.
  return workspace.selectedActionCategory.id === 'work' ? (workspace.lastActionResult ? 'PgUp/PgDn result · Ctrl+PgUp/PgDn ledger · Esc close · Ctrl+R refresh · type to chat' : 'PgUp/PgDn ledger · Up/Down actions · Enter open · Esc close · Ctrl+R refresh · type to chat') : 'Up/Down move · Left/Right pane · Enter open · / search · Ctrl+] next area · Ctrl+R refresh · type to chat';
}

export function renderAgentWorkspace(workspace: AgentWorkspace, width: number, height: number): SurfaceLayer {
  const category = workspace.selectedActionCategory;
  const action = workspace.selectedAction;
  const footer = footerText(workspace);
  const baseOptions = {
    width,
    height,
    leftWidth: width < 90 ? undefined : 22,
    contextRatio: 0.4,
    minContextRows: 10,
    footer,
  };
  // The context is built first (it depends only on the width) so its share of
  // the panel can grow to what it needs while the actions keep their minimum.
  const contextWidth = getFullscreenWorkspaceMetrics(baseOptions).contextWidth;
  const contextRows = buildContextRows(workspace, category, action, contextWidth);
  const layoutOptions = { ...baseOptions, contextNeed: contextRows.length };
  const metrics = getFullscreenWorkspaceMetrics(layoutOptions);
  // Context longer than its share scrolls in every area (PgUp/PgDn, or
  // Ctrl+PgUp/PgDn while a result holds the plain keys) instead of being cut.
  let shownContextRows = contextRows;
  if (workspace.workContextScrollFor !== category.id) {
    workspace.workContextScroll = 0;
    workspace.workContextScrollFor = category.id;
  }
  if (category.id !== 'work' && contextRows.length <= metrics.contextRows) workspace.workContextScroll = 0;
  else {
    const count = Math.max(1, metrics.contextRows - 2);
    // PgUp/PgDn move the pane by what it shows, so a short pane skips nothing.
    workspace.contextPageRows = count;
    workspace.workContextScroll = Math.min(workspace.workContextScroll, Math.max(0, contextRows.length - count));
    // A pane longer than its room scrolls; the first and last rows say which way there is more.
    const visible = contextRows.slice(workspace.workContextScroll, workspace.workContextScroll + count);
    const more = contextRows.length - workspace.workContextScroll - visible.length;
    shownContextRows = [
      ...(workspace.workContextScroll > 0 ? [{ text: `${GLYPHS.navigation.moreAbove} more above (${workspace.lastActionResult ? 'Ctrl+PgUp' : 'PgUp'})`, fg: PALETTE.dim, dim: true }] : []),
      ...visible,
      ...(more > 0 ? [{ text: `${GLYPHS.navigation.moreBelow} more below (${workspace.lastActionResult ? 'Ctrl+PgDn' : 'PgDn'})`, fg: PALETTE.dim, dim: true }] : []),
    ];
  }

  return renderFullscreenWorkspace({
    width,
    height,
    title: 'Agent workspace',
    stateLabel: workspace.actionSearchActive ? 'Search' : workspace.focusPane === 'categories' ? 'Categories' : 'Actions',
    leftHeader: 'Operator Areas',
    mainHeader: workspace.actionSearchActive
      ? `Search actions · ${workspace.actions.length} result${workspace.actions.length === 1 ? '' : 's'}`
      : `${category.label} · ${workspace.actions.length} action${workspace.actions.length === 1 ? '' : 's'}`,
    leftRows: buildLeftRows(workspace, metrics.bodyRows),
    contextRows: shownContextRows,
    controlRows: buildActionRows(workspace, metrics.contextWidth, metrics.controlRows),
    footer,
    leftWidth: layoutOptions.leftWidth,
    contextRatio: layoutOptions.contextRatio,
    minContextRows: layoutOptions.minContextRows,
    contextNeed: layoutOptions.contextNeed,
  });
}
