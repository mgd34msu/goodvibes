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
import { AGENT_WORKSPACE_GROUP_TITLES } from '../input/agent-workspace-types.ts';
import { formatDigestTime } from '../core/away-digest.ts';

/** Consecutive areas under one heading; Home's section has no heading. */
interface RailSection {
  readonly title: string;
  readonly entries: { readonly category: AgentWorkspaceCategory; readonly index: number }[];
}

function railSections(categories: readonly AgentWorkspaceCategory[]): RailSection[] {
  const sections: RailSection[] = [];
  categories.forEach((category, index) => {
    const title = AGENT_WORKSPACE_GROUP_TITLES[category.group];
    const last = sections[sections.length - 1];
    if (last && last.title === title) last.entries.push({ category, index });
    else sections.push({ title, entries: [{ category, index }] });
  });
  return sections;
}

/**
 * The rows of `count` items to show in `budget` rows with `selected` among
 * them: a row on each side that has more is a marker, so the markers never
 * hide the selected item.
 */
function railWindow(count: number, selected: number, budget: number): { start: number; end: number } {
  if (count <= budget) return { start: 0, end: count };
  const room = Math.max(1, budget - 2);
  const start = Math.max(0, Math.min(selected - Math.floor(room / 2), count - room));
  const end = start + room;
  if (start === 0) return { start, end: Math.min(count, budget - 1) };
  if (end >= count) return { start: Math.max(0, count - (budget - 1)), end: count };
  return { start, end };
}

/** A plainly readable "more" marker (muted text, never the dim border colour). */
function moreRow(glyph: string, count: number, areas: boolean): WorkspaceRow {
  return { text: `${glyph} ${count} more${areas ? ` ${count === 1 ? 'area' : 'areas'}` : ''}`, kind: 'more', fg: PALETTE.muted };
}

/** Windowed `items`, with a marker on each side that has more; `areas` when every item is an area. */
function windowedItems(items: readonly WorkspaceRow[], selected: number, budget: number, areas: boolean): WorkspaceRow[] {
  const { start, end } = railWindow(items.length, selected, budget);
  return [
    ...(start > 0 ? [moreRow(GLYPHS.navigation.moreAbove, start, areas)] : []),
    ...items.slice(start, end),
    ...(end < items.length ? [moreRow(GLYPHS.navigation.moreBelow, items.length - end, areas)] : []),
  ];
}

/**
 * The area column. Every group heading stays on screen at every size. When
 * every area does not fit, the groups the selection is not in fold to their
 * heading and how many areas they hold ("Memory & habits (6)"), the everyday
 * group staying open first while there is room; moving the selection into a
 * folded group opens it. Only when the open group alone is taller than the
 * column does it scroll, with a "more areas" marker on the side that has more.
 */
function buildLeftRows(workspace: AgentWorkspace, height: number): WorkspaceRow[] {
  const sections = railSections(workspace.categories);
  const selectedSection = Math.max(0, sections.findIndex((section) => section.entries.some((entry) => entry.index === workspace.selectedCategoryIndex)));
  const itemRow = (category: AgentWorkspaceCategory, index: number): WorkspaceRow => {
    const selected = index === workspace.selectedCategoryIndex;
    return {
      text: `  ${selected ? GLYPHS.navigation.selected : ' '} ${category.label}`,
      selected: selected && workspace.focusPane === 'categories',
      kind: 'item',
      fg: selected ? PALETTE.text : PALETTE.muted,
      bold: selected,
    };
  };
  const rowsFor = (open: ReadonlySet<number>): { rows: WorkspaceRow[]; items: { from: number; to: number } } => {
    const rows: WorkspaceRow[] = [];
    let items = { from: 0, to: 0 };
    sections.forEach((section, s) => {
      const expanded = section.title === '' || open.has(s);
      if (section.title !== '') {
        rows.push(expanded
          ? { text: section.title, kind: 'group', bold: true }
          : { text: `${section.title} (${section.entries.length})`, kind: 'group', folded: true });
      }
      if (!expanded) return;
      const from = rows.length;
      for (const entry of section.entries) rows.push(itemRow(entry.category, entry.index));
      if (s === selectedSection) items = { from, to: rows.length };
    });
    return { rows, items };
  };

  let layout = rowsFor(new Set(sections.map((_, s) => s)));
  if (layout.rows.length > height) {
    const open = new Set([selectedSection]);
    const daily = (s: number): number => (workspace.categories[sections[s]!.entries[0]!.index]?.group === 'DAY-TO-DAY' ? 0 : 1);
    const others = sections.map((_, s) => s).filter((s) => s !== selectedSection && sections[s]!.title !== '').sort((a, b) => daily(a) - daily(b) || a - b);
    for (const s of others) {
      if (rowsFor(new Set([...open, s])).rows.length <= height) open.add(s);
    }
    layout = rowsFor(open);
  }

  let visibleRows = layout.rows;
  if (visibleRows.length > height) {
    const { from, to } = layout.items;
    const fixed = visibleRows.length - (to - from);
    const budget = height - fixed;
    const selectedInSection = visibleRows.slice(from, to).findIndex((row) => row.bold === true);
    visibleRows = budget >= 3
      ? [...visibleRows.slice(0, from), ...windowedItems(visibleRows.slice(from, to), Math.max(0, selectedInSection), budget, true), ...visibleRows.slice(to)]
      : windowedItems(visibleRows, Math.max(0, visibleRows.findIndex((row) => row.kind === 'item' && row.bold === true)), Math.max(1, height), false);
  }
  visibleRows = visibleRows.slice(0, height);
  while (visibleRows.length < height) visibleRows.push({ text: '', kind: 'empty' });
  return visibleRows;
}

/** The right-hand column of an action row: the line it runs, or what kind of row it is. */
function actionCommand(action: AgentWorkspaceAction): string {
  if (action.kind === 'act' && action.act) return workspaceActionLine(action.act);
  // `/agent <area>` opens any area of this workspace, so it is the line an area row runs.
  if (action.kind === 'workspace') return action.targetCategoryId ? `/agent ${action.targetCategoryId}` : 'opens another area';
  if (action.kind === 'setting') return action.settingKey ? `setting ${action.settingKey}` : 'setting';
  if (action.kind === 'settings-import') return '/setup import-settings';
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

/** The second column of an action row: what it runs, or a setting's value now. */
function commandColumn(workspace: AgentWorkspace, action: AgentWorkspaceAction): string {
  return action.kind === 'setting' ? settingNow(workspace, action) : actionCommand(action);
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
    // The pane the arrow keys move in has its heading in the accent colour; the other stays muted.
    fg: workspace.focusPane === 'actions' ? PALETTE.subtitle : PALETTE.muted,
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
  // A result says when it arrived: a reading taken earlier is not mistaken for one taken now.
  if (workspace.lastActionResult !== workspace.resultAtFor) {
    workspace.resultAtFor = workspace.lastActionResult;
    workspace.resultAt = Date.now();
  }
  const resultRows = workspace.lastActionResult
    ? buildActionResultRows(workspace.lastActionResult, {
      onboarding,
      width,
      titleColor: actionResultColor(workspace.lastActionResult),
      palette: resultPalette(),
      moreAbove: GLYPHS.navigation.moreAbove,
      moreBelow: GLYPHS.navigation.moreBelow,
      ...(workspace.lastActionResult.kind === 'guidance' || workspace.lastActionResult.kind === 'recap' ? {} : { at: formatDigestTime(workspace.resultAt) }),
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
  if (window.start > 0) rows.push({ text: `${GLYPHS.navigation.moreAbove} ${window.start} more above`, kind: 'more', fg: PALETTE.muted });

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
          fg: PALETTE.muted,
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
        : `${marker} ${padDisplay(first, labelWidth)}  ${padDisplay(commandColumn(workspace, action), commandWidth)}`;
      const style = {
        selected: selected && workspace.focusPane === 'actions',
        fg: action.safety === 'blocked' ? PALETTE.warn : selected ? PALETTE.text : PALETTE.info,
        bold: selected,
      };
      rows.push({ text, ...style });
      for (const more of rest) rows.push({ text: `  ${padDisplay(more, labelWidth)}`, ...style });
    }
  }

  if (window.end < allActions.length) rows.push({ text: `${GLYPHS.navigation.moreBelow} ${allActions.length - window.end} more below`, kind: 'more', fg: PALETTE.muted });
  if (height > 6) rows.push({ text: '' });
  // Wrapped here, where the rows are budgeted, so the result window below
  // accounts for every row the status takes.
  // No status line until something happened here: the area and its rows say what it is.
  if (workspace.status.trim() !== '') for (const line of wrapText(`Status: ${workspace.status}`, Math.max(1, width))) rows.push({ text: line, fg: PALETTE.muted });
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
  // A printable key closes the workspace into the composer (Esc there comes
  // back), so refresh is Ctrl+R. It is a keycap of its own ([a-z]; plain prose
  // would be dropped from the hint row) and comes first in every area. The row
  // stays short enough for two lines at 80 columns, so the area column keeps its rows.
  const typing = '[a-z] ask the assistant (Esc comes back)';
  return workspace.selectedActionCategory.id === 'work' ? (workspace.lastActionResult ? `${typing} · PgUp/PgDn result · Ctrl+PgUp/PgDn history · Enter open · Ctrl+R refresh` : `${typing} · PgUp/PgDn history · Up/Down move · Enter open · Ctrl+R refresh`) : `${typing} · Up/Down move · Left/Right pane · Enter open · / search · Ctrl+R refresh`;
}

export function renderAgentWorkspace(workspace: AgentWorkspace, width: number, height: number): SurfaceLayer {
  // The area on screen has its reports read by themselves (once while fresh; held readings are map lookups).
  if (!workspace.actionSearchActive) workspace.readShownAreaReports();
  const category = workspace.selectedActionCategory;
  const action = workspace.selectedAction;
  const footer = footerText(workspace);
  const baseOptions = {
    width,
    height,
    // Wide enough for the longest folded heading ("tools & knowledge (2)").
    leftWidth: width < 90 ? 21 : 22,
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
      ...(workspace.workContextScroll > 0 ? [{ text: `${GLYPHS.navigation.moreAbove} more above (${workspace.lastActionResult ? 'Ctrl+PgUp' : 'PgUp'})`, fg: PALETTE.muted }] : []),
      ...visible,
      ...(more > 0 ? [{ text: `${GLYPHS.navigation.moreBelow} more below (${workspace.lastActionResult ? 'Ctrl+PgDn' : 'PgDn'})`, fg: PALETTE.muted }] : []),
    ];
  }

  return renderFullscreenWorkspace({
    width,
    height,
    title: 'Agent workspace',
    // The Agent home, model and daemon this session works with; the selected pane shows by its highlight.
    stateLabel: workspace.identity || undefined,
    leftHeader: 'Areas',
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
