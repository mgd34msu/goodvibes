/**
 * dracula, dark = Dracula, light = Alucard (draculatheme.com/spec).
 *
 * Authored from the official published palette. Every colour that carries text
 * reaches 4.5:1 on each surface it is drawn on (background, panel, element,
 * menu, selection, diff fills): a published value that does not carries the
 * smallest lift toward white (dark) or black (light) that does. The three text
 * levels stay apart: faint at the floor, muted at least 10 CIELAB L* above it,
 * text at least 10 L* above muted. The dark selection fill is the panel tinted
 * 16% toward primary (not the element), so faint does not have to climb to
 * near-white to clear it; the light one is the element tinted the same way.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const DRACULA_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    primary: { dark: '#caa8fa', light: '#5e46bd' },
    secondary: { dark: '#ff94d1', light: '#a3144d' },
    accent: { dark: '#8be9fd', light: '#036089' },
    error: { dark: '#ff9b9b', light: '#a63022' },
    warning: { dark: '#ffb86c', light: '#914512' },
    success: { dark: '#50fa7b', light: '#136909' },
    info: { dark: '#8be9fd', light: '#036089' },
    text: { dark: '#f8f8f2', light: '#1f1f1f' },
    textMuted: { dark: '#ccd2e2', light: '#464231' },
    textFaint: { dark: '#adb6d0', light: '#5d5a4f' },
    selectedListItemText: { dark: '#282a36', light: '#fffbeb' },
    background: { dark: '#282a36', light: '#fffbeb' },
    backgroundPanel: { dark: '#21222c', light: '#fffbeb' },
    backgroundElement: { dark: '#44475a', light: '#ece9df' },
    backgroundMenu: { dark: '#343746', light: '#efeddc' },
    backgroundSelected: { dark: '#3a344d', light: '#d6d0db' },
    border: { dark: '#44475a', light: '#cfcfde' },
    borderActive: { dark: '#6272a4', light: '#6c664b' },
    borderSubtle: { dark: '#343746', light: '#dedccf' },
    reasoning: { dark: '#caa8fa', light: '#5e46bd' },
    diffAdded: { dark: '#50fa7b', light: '#14710a' },
    diffRemoved: { dark: '#ff9b9b', light: '#bb3527' },
    diffContext: 'textMuted',
    diffHunkHeader: { dark: '#caa8fa', light: '#644ac9' },
    diffHighlightAdded: { dark: '#69ff94', light: '#15760a' },
    diffHighlightRemoved: { dark: '#ff8282', light: '#b23f33' },
    diffAddedBg: { dark: '#315845', light: '#dee8cc' },
    diffRemovedBg: { dark: '#57333d', light: '#f8e0d0' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: { dark: '#b0b9d2', light: '#696659' },
    diffAddedLineNumberBg: { dark: '#2b523d', light: '#dee8cc' },
    diffRemovedLineNumberBg: { dark: '#522d35', light: '#f8e0d0' },
    markdownText: 'text',
    markdownHeading: { dark: '#caa8fa', light: '#644ac9' },
    markdownLink: { dark: '#8be9fd', light: '#036a96' },
    markdownLinkText: { dark: '#ff94d1', light: '#a3144d' },
    markdownCode: { dark: '#50fa7b', light: '#14710a' },
    markdownBlockQuote: { dark: '#f1fa8c', light: '#7c6714' },
    markdownEmph: { dark: '#f1fa8c', light: '#7c6714' },
    markdownStrong: 'text',
    markdownHorizontalRule: { dark: '#6272a4', light: '#6c664b' },
    markdownListItem: { dark: '#8be9fd', light: '#036a96' },
    markdownListEnumeration: { dark: '#8be9fd', light: '#036a96' },
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',
    syntaxComment: { dark: '#adb6d0', light: '#6c664b' },
    syntaxKeyword: { dark: '#ff94d1', light: '#a3144d' },
    syntaxFunction: { dark: '#50fa7b', light: '#14710a' },
    syntaxVariable: { dark: '#f8f8f2', light: '#1f1f1f' },
    syntaxString: { dark: '#f1fa8c', light: '#7c6714' },
    syntaxNumber: { dark: '#caa8fa', light: '#644ac9' },
    syntaxType: { dark: '#8be9fd', light: '#036a96' },
    syntaxOperator: { dark: '#ff94d1', light: '#a3144d' },
    syntaxPunctuation: { dark: '#f8f8f2', light: '#1f1f1f' },
    syntaxProperty: { dark: '#ffb86c', light: '#a34d14' },
    syntaxBuiltin: { dark: '#caa8fa', light: '#644ac9' },
  },
};
