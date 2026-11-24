/**
 * gruvbox, dark and light (github.com/morhetz/gruvbox).
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

export const GRUVBOX_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#a3bcb3', light: '#065b6b' },
    secondary: { dark: '#dfa8b7', light: '#813966' },
    accent: { dark: '#fea155', light: '#953103' },
    error: { dark: '#fd9d91', light: '#9d0006' },
    warning: { dark: '#fabd2f', light: '#724a0d' },
    success: { dark: '#babd2d', light: '#58550a' },
    info: { dark: '#94c383', light: '#315b41' },
    text: { dark: '#f6efdc', light: '#272423' },
    textMuted: { dark: '#d9d2c9', light: '#413a34' },
    textFaint: { dark: '#bdb6af', light: '#595247' },
    selectedListItemText: { dark: '#282828', light: '#fbf1c7' },
    background: { dark: '#282828', light: '#fbf1c7' },
    backgroundPanel: { dark: '#1d2021', light: '#f9f5d7' },
    backgroundElement: { dark: '#3c3836', light: '#ebdbb2' },
    backgroundMenu: { dark: '#3c3836', light: '#ebdbb2' },
    backgroundSelected: { dark: '#474946', light: '#c7c8a9' },
    border: { dark: '#504945', light: '#d5c4a1' },
    borderActive: { dark: '#7c6f64', light: '#a89984' },
    borderSubtle: { dark: '#3c3836', light: '#ebdbb2' },
    reasoning: { dark: '#dfa8b7', light: '#813966' },
    diffAdded: { dark: '#b8bb26', light: '#67630c' },
    diffRemoved: { dark: '#fc7e6f', light: '#9d0006' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#88a99c', light: '#076678' },
    diffHighlightAdded: { dark: '#b8bb26', light: '#666511' },
    diffHighlightRemoved: { dark: '#fc7e6f', light: '#b11f19' },
    diffAddedBg: { dark: '#484828', light: '#e9e0ad' },
    diffRemovedBg: { dark: '#562f2b', light: '#eecfac' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#3f4222', light: '#e7e3bb' },
    diffRemovedLineNumberBg: { dark: '#4e2925', light: '#ecd3ba' },
    markdownText: 'text',
    markdownHeading: { dark: '#fabd2f', light: '#86570f' },
    markdownLink: { dark: '#88a99c', light: '#076678' },
    markdownLinkText: { dark: '#8ec07c', light: '#396b4d' },
    markdownCode: { dark: '#b8bb26', light: '#67630c' },
    markdownBlockQuote: { dark: '#aba094', light: '#695e54' },
    markdownEmph: { dark: '#d68da1', light: '#8f3f71' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#665c54', light: '#bdae93' },
    markdownListItem: { dark: '#88a99c', light: '#076678' },
    markdownListEnumeration: { dark: '#88a99c', light: '#076678' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#aba094', light: '#695e54' },
    syntaxKeyword: { dark: '#fc7c6d', light: '#9d0006' },
    syntaxFunction: { dark: '#b8bb26', light: '#67630c' },
    syntaxVariable: { dark: '#88a99c', light: '#076678' },
    syntaxString: { dark: '#b8bb26', light: '#67630c' },
    syntaxNumber: { dark: '#d68da1', light: '#8f3f71' },
    syntaxType: { dark: '#fabd2f', light: '#86570f' },
    syntaxOperator: { dark: '#8ec07c', light: '#396b4d' },
    syntaxPunctuation: { dark: '#ebdbb2', light: '#3c3836' },
    syntaxProperty: { dark: '#88a99c', light: '#076678' },
    syntaxBuiltin: { dark: '#fe8019', light: '#ad3903' },
  },
};
