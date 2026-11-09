import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { createEmptyLine } from '@goodvibes-jev/engine/platform/platform/types';

import { buildViewLine, type ViewPalette } from './polish-core.js';
import { getSurfaceContentRows, getTrackedVisibleWindow, getVisibleWindow, type VisibleWindow } from '../surface-layout.js';
import type { createTerminalPolishBlocks, TerminalPolishPresentation } from './polish-blocks.js';
export interface ViewWorkspaceSection {
  readonly title?: string | undefined;
  readonly lines: readonly Line[];
}
export interface PrimaryScrollableViewSectionConfig {
  readonly title?: string | undefined;
  readonly fixedLines?: readonly Line[] | undefined;
  readonly scrollableLines: readonly Line[];
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly guardRows?: number | undefined;
  readonly minRows?: number | undefined;
  readonly appendWindowSummary?:
    | {
        readonly dimColor?: string | undefined;
        readonly formatter?: ((window: VisibleWindow) => Line) | undefined;
      }
    | undefined;
}
export interface ScrollableViewSectionConfig {
  readonly title?: string | undefined;
  readonly fixedLines?: readonly Line[] | undefined;
  readonly scrollableLines: readonly Line[];
  readonly scrollOffset: number;
  readonly selectedIndex?: number | undefined;
  readonly guardRows?: number | undefined;
  readonly minRows?: number | undefined;
  readonly appendWindowSummary?:
    | {
        readonly dimColor?: string | undefined;
        readonly formatter?: ((window: VisibleWindow) => Line) | undefined;
      }
    | undefined;
}
export interface StackedScrollableViewSectionConfig extends ScrollableViewSectionConfig {
  readonly weight?: number | undefined;
}
export interface ViewWorkspaceConfig {
  readonly title: string;
  readonly intro?: string | undefined;
  readonly sections: readonly ViewWorkspaceSection[];
  readonly footerLines?: readonly Line[] | undefined;
  readonly palette: ViewPalette;
}
export function createTerminalPolishWorkspace(
  presentation: TerminalPolishPresentation,
  blocks: ReturnType<typeof createTerminalPolishBlocks>,
) {
  const { buildViewTitle, buildBodyText, buildSectionHeader } = blocks;
  function getViewWorkspaceIntroRows(width: number, intro: string | undefined, palette: ViewPalette): number {
    return intro ? buildBodyText(width, intro, palette, palette.dim).length : 0;
  }
  function getViewWorkspaceContentBudget(
    width: number,
    height: number,
    config: Pick<ViewWorkspaceConfig, 'intro' | 'footerLines' | 'palette'>,
  ): number {
    const footerLines = [...(config.footerLines ?? [])];
    const chromeRows = 1 + getViewWorkspaceIntroRows(width, config.intro, config.palette) + footerLines.length;
    return Math.max(
      1,
      getSurfaceContentRows({
        viewportHeight: height,
        chromeRows,
        minContentRows: 4,
        maxContentRows: Math.max(4, height - chromeRows),
        minTotalRows: 8,
        maxTotalRows: Math.max(8, height),
        targetRatio: 1,
      }),
    );
  }
  function getViewWorkspaceSectionRows(section: ViewWorkspaceSection): number {
    return (section.title ? 1 : 0) + section.lines.length;
  }
  function getViewScrollableSectionBudget(
    width: number,
    height: number,
    options: {
      readonly intro?: string | undefined;
      readonly footerLines?: readonly Line[] | undefined;
      readonly palette: ViewPalette;
      readonly beforeSections?: readonly ViewWorkspaceSection[] | undefined;
      readonly currentSectionTitle?: string | undefined;
      readonly currentSectionFixedRows?: number | undefined;
      readonly afterSections?: readonly ViewWorkspaceSection[] | undefined;
      readonly minRows?: number | undefined;
    },
  ): number {
    const contentBudget = getViewWorkspaceContentBudget(width, height, options);
    const beforeRows = (options.beforeSections ?? []).reduce((sum, section) => sum + getViewWorkspaceSectionRows(section), 0);
    const afterRows = (options.afterSections ?? []).reduce((sum, section) => sum + getViewWorkspaceSectionRows(section), 0);
    const currentHeaderRows = options.currentSectionTitle ? 1 : 0;
    const currentFixedRows = Math.max(0, options.currentSectionFixedRows ?? 0);
    return Math.max(options.minRows ?? 1, contentBudget - beforeRows - currentHeaderRows - currentFixedRows - afterRows);
  }
  function resolvePrimaryScrollableSection(
    width: number,
    height: number,
    options: {
      readonly intro?: string | undefined;
      readonly footerLines?: readonly Line[] | undefined;
      readonly palette: ViewPalette;
      readonly beforeSections?: readonly ViewWorkspaceSection[] | undefined;
      readonly section: PrimaryScrollableViewSectionConfig;
      readonly afterSections?: readonly ViewWorkspaceSection[] | undefined;
    },
  ): {
    readonly section: ViewWorkspaceSection;
    readonly scrollOffset: number;
    readonly window: VisibleWindow;
  } {
    return resolveScrollableViewSection(width, height, {
      intro: options.intro,
      footerLines: options.footerLines,
      palette: options.palette,
      beforeSections: options.beforeSections,
      section: options.section,
      afterSections: options.afterSections,
    });
  }
  function resolveScrollableViewSection(
    width: number,
    height: number,
    options: {
      readonly intro?: string | undefined;
      readonly footerLines?: readonly Line[] | undefined;
      readonly palette: ViewPalette;
      readonly beforeSections?: readonly ViewWorkspaceSection[] | undefined;
      readonly section: ScrollableViewSectionConfig;
      readonly afterSections?: readonly ViewWorkspaceSection[] | undefined;
    },
  ): {
    readonly section: ViewWorkspaceSection;
    readonly scrollOffset: number;
    readonly window: VisibleWindow;
  } {
    const fixedLines = [...(options.section.fixedLines ?? [])];
    const budget = getViewScrollableSectionBudget(width, height, {
      intro: options.intro,
      footerLines: options.footerLines,
      palette: options.palette,
      beforeSections: options.beforeSections,
      currentSectionTitle: options.section.title,
      currentSectionFixedRows: fixedLines.length,
      afterSections: options.afterSections,
      minRows: options.section.minRows ?? 1,
    });
    // When a window-summary row will render (list longer than the budget can
    // show), it occupies one of the section's rows. Reserve that row up front so
    // the summary is accounted INSIDE the budget; otherwise the appended summary
    // pushes total output one line past the view's exact-height contract and the
    // tail line (typically the footer's keyboard-hints row) is silently dropped.
    const summaryReserved =
      presentation.reserveSummaryRow && options.section.appendWindowSummary && options.section.scrollableLines.length > budget ? 1 : 0;
    const windowBudget = Math.max(0, budget - summaryReserved);
    const window =
      options.section.selectedIndex === undefined
        ? getVisibleWindow(options.section.scrollableLines.length, options.section.scrollOffset, windowBudget)
        : getTrackedVisibleWindow(
            options.section.scrollableLines.length,
            options.section.selectedIndex,
            windowBudget,
            options.section.scrollOffset,
            options.section.guardRows ?? 1,
          );
    const lines = [...fixedLines, ...options.section.scrollableLines.slice(window.start, window.end)];
    if (options.section.appendWindowSummary && options.section.scrollableLines.length > window.count) {
      const summary = options.section.appendWindowSummary.formatter
        ? options.section.appendWindowSummary.formatter(window)
        : buildViewLine(width, [
            [
              `  showing ${window.start + 1}-${window.end} of ${window.total}`,
              options.section.appendWindowSummary.dimColor ?? options.palette.dim,
            ],
          ]);
      lines.push(summary);
    }
    return {
      section: {
        title: options.section.title,
        lines,
      },
      scrollOffset: window.start,
      window,
    };
  }
  function resolveStackedScrollableSections(
    width: number,
    height: number,
    options: {
      readonly intro?: string | undefined;
      readonly footerLines?: readonly Line[] | undefined;
      readonly palette: ViewPalette;
      readonly beforeSections?: readonly ViewWorkspaceSection[] | undefined;
      readonly sections: readonly StackedScrollableViewSectionConfig[];
      readonly afterSections?: readonly ViewWorkspaceSection[] | undefined;
    },
  ): ReadonlyArray<{
    readonly section: ViewWorkspaceSection;
    readonly scrollOffset: number;
    readonly window: VisibleWindow;
  }> {
    if (options.sections.length === 0) return [];
    const contentBudget = getViewWorkspaceContentBudget(width, height, options);
    const beforeRows = (options.beforeSections ?? []).reduce((sum, section) => sum + getViewWorkspaceSectionRows(section), 0);
    const afterRows = (options.afterSections ?? []).reduce((sum, section) => sum + getViewWorkspaceSectionRows(section), 0);
    const fixedChrome = options.sections.reduce((sum, section) => sum + (section.title ? 1 : 0) + (section.fixedLines?.length ?? 0), 0);
    const allocatable = Math.max(1, contentBudget - beforeRows - afterRows - fixedChrome);
    const mins = options.sections.map((section) => Math.max(1, section.minRows ?? 1));
    const weights = options.sections.map((section) => Math.max(1, section.weight ?? 1));
    const totalMin = mins.reduce((sum, value) => sum + value, 0);
    const budgets = [...mins];
    let remaining = Math.max(0, allocatable - totalMin);
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    for (let i = 0; i < budgets.length; i++) {
      if (remaining <= 0) break;
      const share = i === budgets.length - 1 ? remaining : Math.floor((remaining * weights[i]!) / totalWeight);
      budgets[i]! += share;
      remaining -= share;
    }
    let cursor = 0;
    while (remaining > 0 && budgets.length > 0) {
      budgets[cursor % budgets.length]! += 1;
      remaining--;
      cursor++;
    }
    return options.sections.map((section, index) => {
      const fixedLines = [...(section.fixedLines ?? [])];
      // Same reservation as resolveScrollableViewSection: a window-summary row
      // occupies one of this section's allocated rows, so shrink the visible
      // window rather than overflowing the stack's exact-height budget.
      const budget = budgets[index]!;
      const summaryReserved =
        presentation.reserveSummaryRow && section.appendWindowSummary && section.scrollableLines.length > budget ? 1 : 0;
      const windowBudget = Math.max(0, budget - summaryReserved);
      const window =
        section.selectedIndex === undefined
          ? getVisibleWindow(section.scrollableLines.length, section.scrollOffset, windowBudget)
          : getTrackedVisibleWindow(
              section.scrollableLines.length,
              section.selectedIndex,
              windowBudget,
              section.scrollOffset,
              section.guardRows ?? 1,
            );
      const lines = [...fixedLines, ...section.scrollableLines.slice(window.start, window.end)];
      if (section.appendWindowSummary && section.scrollableLines.length > window.count) {
        const summary = section.appendWindowSummary.formatter
          ? section.appendWindowSummary.formatter(window)
          : buildViewLine(width, [
              [
                `  showing ${window.start + 1}-${window.end} of ${window.total}`,
                section.appendWindowSummary.dimColor ?? options.palette.dim,
              ],
            ]);
        lines.push(summary);
      }
      return {
        section: {
          title: section.title,
          lines,
        },
        scrollOffset: window.start,
        window,
      };
    });
  }
  function buildKeyboardHints(
    width: number,
    hints: ReadonlyArray<{
      keys: string;
      label: string;
    }>,
    palette: ViewPalette,
  ): Line {
    const segments: Array<[string, string, string?]> = [];
    hints.forEach((hint, i) => {
      if (i > 0) segments.push(['   ', palette.dim]);
      else segments.push([' ', palette.dim]);
      segments.push([hint.keys, palette.info]);
      segments.push([' ', palette.dim]);
      segments.push([hint.label, palette.dim]);
    });
    return buildViewLine(width, segments);
  }
  function buildViewWorkspace(width: number, height: number, config: ViewWorkspaceConfig): Line[] {
    const lines: Line[] = [];
    lines.push(buildViewTitle(width, config.title, config.palette));
    if (config.intro) {
      lines.push(...buildBodyText(width, config.intro, config.palette, config.palette.dim));
    }
    const footerLines = [...(config.footerLines ?? [])];
    const contentBudget = getViewWorkspaceContentBudget(width, height, config);
    let consumed = 0;
    for (let sectionIndex = 0; sectionIndex < config.sections.length; sectionIndex++) {
      const section = config.sections[sectionIndex]!;
      if (consumed >= contentBudget) break;
      if (section.title) {
        if (consumed >= contentBudget) break;
        lines.push(buildSectionHeader(width, section.title, config.palette));
        consumed++;
      }
      for (const line of section.lines) {
        if (consumed >= contentBudget) break;
        lines.push(line);
        consumed++;
      }
    }
    const contentAndChromeTarget = Math.max(0, height - footerLines.length);
    while (lines.length < contentAndChromeTarget) lines.push(createEmptyLine(width));
    lines.push(...footerLines);
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
  return {
    getViewWorkspaceContentBudget,
    getViewWorkspaceSectionRows,
    getViewScrollableSectionBudget,
    resolvePrimaryScrollableSection,
    resolveScrollableViewSection,
    resolveStackedScrollableSections,
    buildKeyboardHints,
    buildViewWorkspace,
  };
}
