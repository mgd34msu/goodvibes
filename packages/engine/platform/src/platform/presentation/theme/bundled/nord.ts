/**
 * nord, dark only (nordtheme.com/docs/colors-and-palettes; nord0..nord15 from
 * github.com/nordtheme/nord src/nord.css). The two text/border shades brighter
 * than nord3 (#616e88, #7b88a1) come from nordtheme/vim colors/nord.vim.
 *
 * Authored from the official published palette. Every colour that carries text
 * reaches 4.5:1 on each surface it is drawn on (background, panel, element,
 * menu, selection, diff fills): a published value that does not carries the
 * smallest lift toward white that does. The three text levels stay apart:
 * faint at the floor, muted at least 10 CIELAB L* above it, text at least 10 L*
 * above muted. The selection fill is the panel tinted 16% toward primary (not
 * the element), so faint does not have to climb to near-white to clear it.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const NORD_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: '#88c0d0',
    secondary: '#a6bad1',
    accent: '#caafc5',
    error: '#dcaaaf',
    warning: '#ebcb8b',
    success: '#a4bf8d',
    info: '#a2b9d1',
    text: '#edeff4',
    textMuted: '#ced3dc',
    textFaint: '#b0b7c3',
    selectedListItemText: '#2e3440',
    background: '#2e3440',
    backgroundPanel: '#2e3440',
    backgroundElement: '#3b4252',
    backgroundMenu: '#3b4252',
    backgroundSelected: '#3c4a57',
    border: '#434c5e',
    borderActive: '#616e88',
    borderSubtle: '#3b4252',
    reasoning: '#caafc5',
    diffAdded: '#b3c9a0',
    diffRemoved: '#d9a0a6',
    diffContext: 'textMuted',
    diffHunkHeader: '#c3a5bd',
    diffHighlightAdded: '#b3c9a0',
    diffHighlightRemoved: '#dba391',
    diffAddedBg: '#485251',
    diffRemovedBg: '#4e3e49',
    diffContextBg: 'backgroundPanel',
    diffLineNumber: '#bcc2cc',
    diffAddedLineNumberBg: '#485251',
    diffRemovedLineNumberBg: '#4e3e49',
    markdownText: 'text',
    markdownHeading: '#88c0d0',
    markdownLink: '#88c0d0',
    markdownLinkText: '#8fbcbb',
    markdownCode: '#a3be8c',
    markdownBlockQuote: '#a7aebc',
    markdownEmph: '#ebcb8b',
    markdownStrong: 'text',
    markdownHorizontalRule: '#616e88',
    markdownListItem: '#88c0d0',
    markdownListEnumeration: '#c3a5bd',
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: '#a7aebc',
    syntaxKeyword: '#96b1cc',
    syntaxFunction: '#88c0d0',
    syntaxVariable: '#d8dee9',
    syntaxString: '#a3be8c',
    syntaxNumber: '#c3a5bd',
    syntaxType: '#8fbcbb',
    syntaxOperator: '#96b1cc',
    syntaxPunctuation: '#eceff4',
    syntaxProperty: '#8fbcbb',
    syntaxBuiltin: '#96b1cc',
  },
};
