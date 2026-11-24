/**
 * catppuccin, dark = Mocha, light = Latte (github.com/catppuccin/palette).
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

export const CATPPUCCIN_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#8eb7fa', light: '#174fbd' },
    secondary: { dark: '#cba6f7', light: '#6e2ec2' },
    accent: { dark: '#f5c2e7', light: '#7e406e' },
    error: { dark: '#f59cb5', light: '#ac0c2f' },
    warning: { dark: '#f9e2af', light: '#784d10' },
    success: { dark: '#a6e3a1', light: '#28631b' },
    info: { dark: '#89dceb', light: '#025c80' },
    text: { dark: '#eaeefa', light: '#262835' },
    textMuted: { dark: '#cdd1e0', light: '#3c3e4a' },
    textFaint: { dark: '#b4b5c1', light: '#54565f' },
    selectedListItemText: { dark: '#1e1e2e', light: '#eff1f5' },
    background: { dark: '#1e1e2e', light: '#eff1f5' },
    backgroundPanel: { dark: '#181825', light: '#e6e9ef' },
    backgroundElement: { dark: '#313244', light: '#dce0e8' },
    backgroundMenu: { dark: '#313244', light: '#dce0e8' },
    backgroundSelected: { dark: '#3f4761', light: '#beccea' },
    border: { dark: '#45475a', light: '#ccd0da' },
    borderActive: { dark: '#6c7086', light: '#9ca0b0' },
    borderSubtle: { dark: '#313244', light: '#dce0e8' },
    reasoning: { dark: '#cba6f7', light: '#6e2ec2' },
    diffAdded: { dark: '#a6e3a1', light: '#2d701e' },
    diffRemoved: { dark: '#f38ba8', light: '#bb0d33' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#b4befe', light: '#4f5daf' },
    diffHighlightAdded: { dark: '#94e2d5', light: '#116f74' },
    diffHighlightRemoved: { dark: '#eba0ac', light: '#aa333d' },
    diffAddedBg: { dark: '#3c4947', light: '#d7e6d9' },
    diffRemovedBg: { dark: '#4d3649', light: '#ebd1db' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: 'textFaint',
    diffAddedLineNumberBg: { dark: '#374540', light: '#cfdfd4' },
    diffRemovedLineNumberBg: { dark: '#483142', light: '#e3cad6' },
    markdownText: 'text',
    markdownHeading: { dark: '#89b4fa', light: '#1a5ad8' },
    markdownLink: { dark: '#89b4fa', light: '#1a5ad8' },
    markdownLinkText: { dark: '#b4befe', light: '#4f5daf' },
    markdownCode: { dark: '#a6e3a1', light: '#2d701e' },
    markdownBlockQuote: { dark: '#a6adc8', light: '#5f6275' },
    markdownEmph: { dark: '#f9e2af', light: '#8a5812' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#6c7086', light: '#9ca0b0' },
    markdownListItem: { dark: '#94e2d5', light: '#116e73' },
    markdownListEnumeration: { dark: '#94e2d5', light: '#116e73' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#949ab3', light: '#5f6271' },
    syntaxKeyword: { dark: '#cba6f7', light: '#7e35de' },
    syntaxFunction: { dark: '#89b4fa', light: '#1a5ad8' },
    syntaxVariable: { dark: '#cdd6f4', light: '#4c4f69' },
    syntaxString: { dark: '#a6e3a1', light: '#2d701e' },
    syntaxNumber: { dark: '#fab387', light: '#aa4307' },
    syntaxType: { dark: '#f9e2af', light: '#8a5812' },
    syntaxOperator: { dark: '#89dceb', light: '#036a93' },
    syntaxPunctuation: { dark: '#949ab3', light: '#5f6271' },
    syntaxProperty: { dark: '#b4befe', light: '#4f5daf' },
    syntaxBuiltin: { dark: '#f38ba8', light: '#c50e36' },
  },
};
