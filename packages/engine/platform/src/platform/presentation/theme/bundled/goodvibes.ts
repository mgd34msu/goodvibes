/**
 * goodvibes, the default theme (owner-approved palette, 2026-09).
 *
 * The background is transparent: GoodVibes paints on the terminal's own
 * background and uses the panel/element shades only for opaque surfaces.
 * Plain data, no module-scope calls.
 */

import type { ThemeJson } from '../types.js';

export const GOODVIBES_THEME: ThemeJson = {
  $schema: 'https://opencode.ai/theme.json',
  theme: {
    // Every colour that carries text reaches 4.5:1 on each surface it is drawn
    // on (the terminal's own background, panel, element and selection): the
    // smallest lift of the approved values that does.
    primary: { dark: '#5ee0e6', light: '#007079' },
    secondary: { dark: '#d18cf5', light: '#9832c2' },
    accent: { dark: '#a99af7', light: '#6450d0' },
    error: { dark: '#f37d84', light: '#bc2f38' },
    warning: { dark: '#f0b660', light: '#8c5b00' },
    success: { dark: '#7ddcae', light: '#1f7244' },
    info: { dark: '#7aa7f5', light: '#2d60c4' },

    text: { dark: '#e4e2ee', light: '#1c1b22' },
    // Three text levels a person can tell apart: faint sits at 4.5:1 on the
    // lightest (dark) or darkest (light) surface it is drawn on, muted at least
    // 10 CIELAB L* above it toward text, and text at least 10 L* above muted.
    textMuted: { dark: '#bcbac8', light: '#4d4c56' },
    textFaint: { dark: '#a19fac', light: '#66646f' },
    selectedListItemText: { dark: '#10111a', light: '#ffffff' },

    background: 'transparent',
    backgroundPanel: { dark: '#232438', light: '#ffffff' },
    backgroundElement: { dark: '#2d2e48', light: '#eeecf3' },
    backgroundMenu: 'backgroundElement',
    backgroundSelected: { dark: '#273b42', light: '#d4e6e9' },

    border: { dark: '#3a3b57', light: '#dcd9e4' },
    borderActive: { dark: '#575463', light: '#aeaabb' },
    borderSubtle: { dark: '#2a2833', light: '#e9e7ef' },

    brand: { dark: '#5ee0e6', light: '#0077aa' },
    brandEnd: { dark: '#d18cf5', light: '#7c3aed' },
    reasoning: { dark: '#c08af0', light: '#7a39e8' },

    diffAdded: { dark: '#6fdcb0', light: '#217948' },
    diffRemoved: { dark: '#f2767e', light: '#c6323b' },
    diffContext: 'textMuted',
    diffHunkHeader: 'info',
    diffHighlightAdded: { dark: '#a6f0cc', light: '#15693a' },
    diffHighlightRemoved: { dark: '#ff9aa0', light: '#a0222c' },
    diffAddedBg: { dark: '#1c3230', light: '#e3edea' },
    diffRemovedBg: { dark: '#3a2031', light: '#f8e8ec' },
    diffContextBg: 'backgroundPanel',
    diffLineNumber: { dark: '#a19fac', light: '#64626d' },
    diffAddedLineNumberBg: { dark: '#172a2a', light: '#d6e6e0' },
    diffRemovedLineNumberBg: { dark: '#2f1a28', light: '#f0dbe1' },

    markdownText: 'text',
    markdownHeading: 'accent',
    markdownLink: { dark: '#7aa7f5', light: '#2e62c8' },
    markdownLinkText: 'primary',
    markdownCode: 'syntaxString',
    markdownBlockQuote: 'textMuted',
    markdownEmph: { dark: '#f0cf7a', light: '#8a6200' },
    markdownStrong: 'text',
    markdownHorizontalRule: 'textMuted',
    markdownListItem: 'textMuted',
    markdownListEnumeration: 'textMuted',
    markdownImage: 'markdownLink',
    markdownImageText: 'markdownLinkText',
    markdownCodeBlock: 'text',

    syntaxComment: { dark: '#9997a8', light: '#6c6975' },
    syntaxKeyword: { dark: '#d18cf5', light: '#9a32c4' },
    syntaxFunction: { dark: '#5ee0e6', light: '#00767f' },
    syntaxVariable: 'text',
    syntaxString: { dark: '#9ee6a8', light: '#2c7938' },
    syntaxNumber: { dark: '#f5a97a', light: '#b04f12' },
    syntaxType: { dark: '#f0cf7a', light: '#8a6200' },
    syntaxOperator: { dark: '#8fb8f5', light: '#2e62c8' },
    syntaxPunctuation: 'text',

    lanes: ['primary', 'accent', 'secondary', 'info', 'success', 'warning'],
    thinkingOpacity: 0.6,
  },
};
