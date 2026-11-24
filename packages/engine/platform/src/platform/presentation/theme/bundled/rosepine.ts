/**
 * rosepine, dark = main, light = dawn (rosepinetheme.com/palette).
 *
 * Authored from the official published palette. Every colour that carries text
 * reaches 4.5:1 on each surface it is drawn on (background, panel, element,
 * menu, selection, diff fills): a published value that does not carries the
 * smallest lift toward white (dark) or black (light) that does. The three text
 * levels stay apart: faint at the floor, muted at least 10 CIELAB L* above it,
 * text at least 10 L* above muted.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const ROSEPINE_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#ebbcba', light: '#8a5351' },
    secondary: { dark: '#c4a7e7', light: '#6b5a7d' },
    accent: { dark: '#9ccfd8', light: '#3c686f' },
    error: { dark: '#ef8ca8', light: '#8e4e60' },
    warning: { dark: '#f6c177', light: '#84581d' },
    success: { dark: '#9ccfd8', light: '#3c686f' },
    info: { dark: '#c4a7e7', light: '#6b5a7d' },
    text: { dark: '#e2e0f5', light: '#333047' },
    textMuted: { dark: '#c6c4d4', light: '#4a475a' },
    textFaint: { dark: '#aba8b9', light: '#63606c' },
    selectedListItemText: { dark: '#191724', light: '#faf4ed' },
    background: { dark: '#191724', light: '#faf4ed' },
    backgroundPanel: { dark: '#1f1d2e', light: '#fffaf3' },
    backgroundElement: { dark: '#26233a', light: '#f2e9e1' },
    backgroundMenu: { dark: '#26233a', light: '#f2e9e1' },
    backgroundSelected: { dark: '#463b4e', light: '#eed9d1' },
    border: { dark: '#403d52', light: '#dfdad9' },
    borderActive: { dark: '#524f67', light: '#cecacd' },
    borderSubtle: { dark: '#21202e', light: '#f4ede8' },
    reasoning: { dark: '#c4a7e7', light: '#6b5a7d' },
    diffAdded: { dark: '#9ccfd8', light: '#406e76' },
    diffRemoved: { dark: '#ec7596', light: '#945164' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#c4a7e7', light: '#736287' },
    diffHighlightAdded: { dark: '#9ccfd8', light: '#286983' },
    diffHighlightRemoved: { dark: '#ec7596', light: '#945164' },
    diffAddedBg: { dark: '#363f4c', light: '#e3e7e2' },
    diffRemovedBg: { dark: '#472a3c', light: '#f0e0dd' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: { dark: '#b1aebe', light: '#6b6774' },
    diffAddedLineNumberBg: { dark: '#3b4453', light: '#e7ece7' },
    diffRemovedLineNumberBg: { dark: '#4c2f44', light: '#f5e5e2' },
    markdownText: 'text',
    markdownHeading: { dark: '#c4a7e7', light: '#736287' },
    markdownLink: { dark: '#9ccfd8', light: '#417079' },
    markdownLinkText: { dark: '#ebbcba', light: '#945a57' },
    markdownCode: { dark: '#f6c177', light: '#8f6020' },
    markdownBlockQuote: { dark: '#908caa', light: '#6a6781' },
    markdownEmph: { dark: '#f6c177', light: '#8f6020' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#6e6a86', light: '#9893a5' },
    markdownListItem: { dark: '#9ccfd8', light: '#417079' },
    markdownListEnumeration: { dark: '#9ccfd8', light: '#417079' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#8e8ba1', light: '#6c6875' },
    syntaxKeyword: { dark: '#6094a9', light: '#286983' },
    syntaxFunction: { dark: '#ebbcba', light: '#945a57' },
    syntaxVariable: { dark: '#e0def4', light: '#575279' },
    syntaxString: { dark: '#f6c177', light: '#8f6020' },
    syntaxNumber: { dark: '#f6c177', light: '#8f6020' },
    syntaxType: { dark: '#9ccfd8', light: '#417079' },
    syntaxOperator: { dark: '#908caa', light: '#6a6781' },
    syntaxPunctuation: { dark: '#908caa', light: '#6a6781' },
    syntaxProperty: { dark: '#9ccfd8', light: '#417079' },
    syntaxBuiltin: { dark: '#eb6f92', light: '#995468' },
  },
};
