/**
 * solarized, dark and light (ethanschoonover.com/solarized).
 *
 * Authored from the official published palette. Every colour that carries text
 * reaches 4.5:1 on each surface it is drawn on (background, panel, element,
 * menu, selection, diff fills, and the border colour keycaps sit on): a
 * published value that does not carries the smallest lift toward white (dark)
 * or black (light) that does. The three text levels stay apart: faint at the
 * floor, muted at least 10 CIELAB L* above it, text at least 10 L* above muted.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const SOLARIZED_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#6eb1e1', light: '#1b6193' },
    secondary: { dark: '#a2a6da', light: '#535797' },
    accent: { dark: '#e790ba', light: '#a72b67' },
    error: { dark: '#ec908f', light: '#b02826' },
    warning: { dark: '#c8a740', light: '#745800' },
    success: { dark: '#a4b340', light: '#566200' },
    info: { dark: '#5db8b1', light: '#1b6862' },
    text: { dark: '#e8ecec', light: '#273134' },
    textMuted: { dark: '#bfc7c8', light: '#3b484c' },
    textFaint: { dark: '#9facaf', light: '#585f5f' },
    selectedListItemText: { dark: '#002b36', light: '#fdf6e3' },
    background: { dark: '#002b36', light: '#fdf6e3' },
    backgroundPanel: { dark: '#002b36', light: '#fdf6e3' },
    backgroundElement: { dark: '#073642', light: '#eee8d5' },
    backgroundMenu: { dark: '#073642', light: '#eee8d5' },
    backgroundSelected: { dark: '#0c4459', light: '#ced9d5' },
    border: { dark: '#586e75', light: '#93a1a1' },
    borderActive: { dark: '#839496', light: '#657b83' },
    borderSubtle: { dark: '#073642', light: '#eee8d5' },
    reasoning: { dark: '#a2a6da', light: '#535797' },
    diffAdded: { dark: '#9fae36', light: '#606e00' },
    diffRemoved: { dark: '#e87674', light: '#bd2b28' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#4b9fda', light: '#1e6ca4' },
    diffHighlightAdded: { dark: '#9fae36', light: '#606e00' },
    diffHighlightRemoved: { dark: '#da7d57', light: '#ad4013' },
    diffAddedBg: { dark: '#1d432a', light: '#ece9c3' },
    diffRemovedBg: { dark: '#302d34', light: '#f8dbca' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#1d432a', light: '#ece9c3' },
    diffRemovedLineNumberBg: { dark: '#302d34', light: '#f8dbca' },
    markdownText: 'text',
    markdownHeading: { dark: '#bc9417', light: '#846400' },
    markdownLink: { dark: '#4b9fda', light: '#1e6ca4' },
    markdownLinkText: { dark: '#39a89f', light: '#1e746d' },
    markdownCode: { dark: '#39a89f', light: '#1e746d' },
    markdownBlockQuote: { dark: '#8c9b9d', light: '#586b72' },
    markdownEmph: { dark: '#e174a9', light: '#ba3072' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#586e75', light: '#93a1a1' },
    markdownListItem: { dark: '#4b9fda', light: '#1e6ca4' },
    markdownListEnumeration: { dark: '#4b9fda', light: '#1e6ca4' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#8c9ba0', light: '#616a6a' },
    syntaxKeyword: { dark: '#8fa114', light: '#606e00' },
    syntaxFunction: { dark: '#4b9fda', light: '#1e6ca4' },
    syntaxVariable: { dark: '#93a1a1', light: '#566c73' },
    syntaxString: { dark: '#39a89f', light: '#1e746d' },
    syntaxNumber: { dark: '#e174a9', light: '#ba3072' },
    syntaxType: { dark: '#bc9417', light: '#846400' },
    syntaxOperator: { dark: '#8fa114', light: '#606e00' },
    syntaxPunctuation: { dark: '#8c9b9d', light: '#586b72' },
    syntaxProperty: { dark: '#4b9fda', light: '#1e6ca4' },
    syntaxBuiltin: { dark: '#db815c', light: '#b54314' },
  },
};
