/**
 * one-dark, dark only (Atom One Dark, github.com/atom/atom one-dark-syntax).
 *
 * Authored from the official published palette. Every colour that carries text
 * reaches 4.5:1 on each surface it is drawn on (background, panel, element,
 * menu, selection, diff fills): a published value that does not carries the
 * smallest lift toward white that does. The three text levels stay apart:
 * faint at the floor, muted at least 10 CIELAB L* above it, text at least 10 L*
 * above muted.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const ONE_DARK_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: '#6fb6f0',
    secondary: '#d59be6',
    accent: '#d7a678',
    error: '#ea9aa0',
    warning: '#e5c07b',
    success: '#98c379',
    info: '#65bdc7',
    text: '#e7e9ec',
    textMuted: '#caccd0',
    textFaint: '#acb0b7',
    selectedListItemText: '#282c34',
    background: '#282c34',
    backgroundPanel: '#21252b',
    backgroundElement: '#2c313a',
    backgroundMenu: '#2c313a',
    backgroundSelected: '#344557',
    border: '#3e4451',
    borderActive: '#5c6370',
    borderSubtle: '#2c313a',
    reasoning: '#d59be6',
    diffAdded: '#9bc57d',
    diffRemoved: '#e8949a',
    diffContext: 'textMuted',
    diffHunkHeader: '#61afef',
    diffHighlightAdded: '#9bc57d',
    diffHighlightRemoved: '#db9d97',
    diffAddedBg: '#414d43',
    diffRemovedBg: '#503a42',
    diffContextBg: 'backgroundPanel',
    diffLineNumber: '#aeb2b8',
    diffAddedLineNumberBg: '#3b483c',
    diffRemovedLineNumberBg: '#4b353b',
    markdownText: 'text',
    markdownHeading: '#e37981',
    markdownLink: '#61afef',
    markdownLinkText: '#56b6c2',
    markdownCode: '#98c379',
    markdownBlockQuote: '#9398a1',
    markdownEmph: '#c77bde',
    markdownStrong: 'text',
    markdownHorizontalRule: '#5c6370',
    markdownListItem: '#e37981',
    markdownListEnumeration: '#d19a66',
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: '#9398a1',
    syntaxKeyword: '#c77bde',
    syntaxFunction: '#61afef',
    syntaxVariable: '#e37981',
    syntaxString: '#98c379',
    syntaxNumber: '#d19a66',
    syntaxType: '#e5c07b',
    syntaxOperator: '#56b6c2',
    syntaxPunctuation: '#abb2bf',
    syntaxProperty: '#e37981',
    syntaxBuiltin: '#e5c07b',
  },
};
