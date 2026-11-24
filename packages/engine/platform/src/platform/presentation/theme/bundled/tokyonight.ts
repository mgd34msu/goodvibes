/**
 * tokyonight, dark = Night, light = Day (github.com/folke/tokyonight.nvim).
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

export const TOKYONIGHT_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#8aadf8', light: '#1e5197' },
    secondary: { dark: '#be9ef7', light: '#6739a4' },
    accent: { dark: '#ff9e64', light: '#7f4200' },
    error: { dark: '#f88fa2', light: '#9f1b42' },
    warning: { dark: '#e0af68', light: '#664f2d' },
    success: { dark: '#9ece6a', light: '#43592b' },
    info: { dark: '#7dcfff', light: '#005977' },
    text: { dark: '#e1e6fa', light: '#152448' },
    textMuted: { dark: '#c4c9e3', light: '#313a59' },
    textFaint: { dark: '#a9adc3', light: '#4d5265' },
    selectedListItemText: { dark: '#1a1b26', light: '#e1e2e7' },
    background: { dark: '#1a1b26', light: '#e1e2e7' },
    backgroundPanel: { dark: '#16161e', light: '#e1e2e7' },
    backgroundElement: { dark: '#292e42', light: '#d0d5e3' },
    backgroundMenu: { dark: '#292e42', light: '#d0d5e3' },
    backgroundSelected: { dark: '#36415f', light: '#b6c7e4' },
    border: { dark: '#3b4261', light: '#a8aecb' },
    borderActive: { dark: '#545c7e', light: '#68709a' },
    borderSubtle: { dark: '#292e42', light: '#c4c8da' },
    reasoning: { dark: '#be9ef7', light: '#6739a4' },
    diffAdded: { dark: '#9ece6a', light: '#49612f' },
    diffRemoved: { dark: '#f7778f', light: '#a91d46' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#7aa2f7', light: '#225baa' },
    diffHighlightAdded: { dark: '#73daca', light: '#31635c' },
    diffHighlightRemoved: { dark: '#e78585', light: '#9c3535' },
    diffAddedBg: { dark: '#374235', light: '#ced3cf' },
    diffRemovedBg: { dark: '#4b2f3d', light: '#e4c8d5' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#343e2f', light: '#ced3cf' },
    diffRemovedLineNumberBg: { dark: '#482b37', light: '#e4c8d5' },
    markdownText: 'text',
    markdownHeading: { dark: '#7aa2f7', light: '#225baa' },
    markdownLink: { dark: '#7aa2f7', light: '#225baa' },
    markdownLinkText: { dark: '#7dcfff', light: '#006385' },
    markdownCode: { dark: '#9ece6a', light: '#4b6330' },
    markdownBlockQuote: { dark: '#a9b1d6', light: '#4d5a8b' },
    markdownEmph: { dark: '#e0af68', light: '#715732' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#565f89', light: '#8990b3' },
    markdownListItem: { dark: '#ff9e64', light: '#8f4b00' },
    markdownListEnumeration: { dark: '#ff9e64', light: '#8f4b00' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#8f95b1', light: '#565b76' },
    syntaxKeyword: { dark: '#a688dc', light: '#7243b4' },
    syntaxFunction: { dark: '#7aa2f7', light: '#225baa' },
    syntaxVariable: { dark: '#c0caf5', light: '#3358b0' },
    syntaxString: { dark: '#9ece6a', light: '#4b6330' },
    syntaxNumber: { dark: '#ff9e64', light: '#8f4b00' },
    syntaxType: { dark: '#2ac3de', light: '#136573' },
    syntaxOperator: { dark: '#89ddff', light: '#00657c' },
    syntaxPunctuation: { dark: '#89ddff', light: '#00657c' },
    syntaxProperty: { dark: '#73daca', light: '#32655e' },
    syntaxBuiltin: { dark: '#f7768e', light: '#b01e49' },
  },
};
