// ============================================================================
// CATPPUCCIN LATTE THEME - The light variant
// ============================================================================
//
// Official Catppuccin color palette: https://github.com/catppuccin/catppuccin
// Latte is the light variant, ideal for well-lit environments.
//
// ============================================================================

import type { Theme, SemanticColorSet, ColorScale } from '@shared/types/theme-types';

// =============================================================================
// Catppuccin Latte Base Palette
// =============================================================================
const palette = {
  // Base colors (inverted for light theme)
  base: '#eff1f5',
  mantle: '#e6e9ef',
  crust: '#dce0e8',

  // Surface colors
  surface0: '#ccd0da',
  surface1: '#bcc0cc',
  surface2: '#acb0be',

  // Overlay colors
  overlay0: '#9ca0b0',
  overlay1: '#8c8fa1',
  overlay2: '#7c7f93',

  // Text colors
  text: '#4c4f69',
  subtext0: '#6c6f85',
  subtext1: '#5c5f77',

  // Accent colors
  rosewater: '#dc8a78',
  flamingo: '#dd7878',
  pink: '#ea76cb',
  mauve: '#8839ef',
  red: '#d20f39',
  maroon: '#e64553',
  peach: '#fe640b',
  yellow: '#df8e1d',
  green: '#40a02b',
  teal: '#179299',
  sky: '#04a5e5',
  sapphire: '#209fb5',
  blue: '#1e66f5',
  lavender: '#7287fd',
};

// =============================================================================
// Helper: Create glow colors from a base hex color
// =============================================================================
function createGlowColors(baseHex: string) {
  const r = parseInt(baseHex.slice(1, 3), 16);
  const g = parseInt(baseHex.slice(3, 5), 16);
  const b = parseInt(baseHex.slice(5, 7), 16);

  return {
    default: `rgba(${r}, ${g}, ${b}, 0.5)`,
    strong: `rgba(${r}, ${g}, ${b}, 0.7)`,
    subtle: `rgba(${r}, ${g}, ${b}, 0.25)`,
    muted: `rgba(${r}, ${g}, ${b}, 0.15)`,
    faint: `rgba(${r}, ${g}, ${b}, 0.08)`,
  };
}

// =============================================================================
// Color Scales
// =============================================================================

// Primary: Blue/Lavender scale (adjusted for light theme)
const primaryScale: SemanticColorSet = {
  50: '#eef2ff',
  100: '#e0e7ff',
  200: '#c7d2fe',
  300: '#a5b4fc',
  400: '#818cf8',
  500: palette.blue,
  600: '#1a5ae0',
  700: '#164ec5',
  800: '#1242aa',
  900: '#0e378f',
  950: '#0a2a6b',
  glow: createGlowColors(palette.blue),
  gradient: {
    start: '#164ec5',
    mid: palette.blue,
    end: palette.lavender,
  },
};

// Accent: Mauve/Pink scale (adjusted for light theme)
const accentScale: SemanticColorSet = {
  50: '#faf5ff',
  100: '#f3e8ff',
  200: '#e9d5ff',
  300: '#d8b4fe',
  400: '#c084fc',
  500: palette.mauve,
  600: '#7c31d9',
  700: '#6b28b8',
  800: '#5a2197',
  900: '#4a1c7a',
  950: '#38155d',
  glow: createGlowColors(palette.mauve),
  gradient: {
    start: '#6b28b8',
    mid: palette.mauve,
    end: palette.pink,
  },
};

// Surface: Catppuccin base to overlay scale (inverted for light)
const surfaceScale: ColorScale = {
  50: palette.crust,
  100: palette.mantle,
  200: palette.base,
  300: palette.surface0,
  400: palette.surface1,
  500: palette.surface2,
  600: palette.overlay0,
  700: palette.overlay1,
  800: palette.overlay2,
  900: palette.subtext1,
  950: palette.text,
};

// Success: Green/Teal scale (adjusted for light theme)
const successScale: SemanticColorSet = {
  50: '#ecfdf5',
  100: '#d1fae5',
  200: '#a7f3d0',
  300: '#6ee7b7',
  400: '#34d399',
  500: palette.green,
  600: '#388f25',
  700: '#307d20',
  800: '#286b1b',
  900: '#205916',
  950: '#184312',
  glow: createGlowColors(palette.green),
  gradient: {
    start: '#307d20',
    mid: palette.green,
    end: palette.teal,
  },
};

// Warning: Yellow/Peach scale (adjusted for light theme)
const warningScale: SemanticColorSet = {
  50: '#fffbeb',
  100: '#fef3c7',
  200: '#fde68a',
  300: '#fcd34d',
  400: '#fbbf24',
  500: palette.yellow,
  600: '#c77b18',
  700: '#a66914',
  800: '#855710',
  900: '#64450c',
  950: '#4d3509',
  glow: createGlowColors(palette.yellow),
  gradient: {
    start: '#a66914',
    mid: palette.peach,
    end: palette.yellow,
  },
};

// Error: Red/Maroon scale (adjusted for light theme)
const errorScale: SemanticColorSet = {
  50: '#fff1f2',
  100: '#ffe4e6',
  200: '#fecdd3',
  300: '#fda4af',
  400: '#fb7185',
  500: palette.red,
  600: '#be0d33',
  700: '#a00b2b',
  800: '#820923',
  900: '#64071b',
  950: '#4a0514',
  glow: createGlowColors(palette.red),
  gradient: {
    start: '#a00b2b',
    mid: palette.red,
    end: palette.maroon,
  },
};

// Info: Sapphire/Sky scale (adjusted for light theme)
const infoScale: SemanticColorSet = {
  50: '#ecfeff',
  100: '#cffafe',
  200: '#a5f3fc',
  300: '#67e8f9',
  400: '#22d3ee',
  500: palette.sapphire,
  600: '#1c8fa3',
  700: '#187f91',
  800: '#146f7f',
  900: '#105f6d',
  950: '#0c4a55',
  glow: createGlowColors(palette.sapphire),
  gradient: {
    start: '#187f91',
    mid: palette.sapphire,
    end: palette.sky,
  },
};

// =============================================================================
// Theme Export
// =============================================================================

export const catppuccinLatte: Theme = {
  id: 'catppuccin-latte',
  name: 'Catppuccin Latte',
  description: 'Soothing pastel theme - light variant',
  author: 'Catppuccin',
  variant: 'light',
  colors: {
    primary: primaryScale,
    accent: accentScale,
    surface: surfaceScale,
    success: successScale,
    warning: warningScale,
    error: errorScale,
    info: infoScale,

    bg: {
      primary: palette.base,
      secondary: palette.mantle,
      tertiary: palette.crust,
      hover: palette.surface0,
      elevated: '#ffffff',
      active: palette.surface1,
    },

    text: {
      primary: palette.text,
      secondary: palette.subtext1,
      muted: palette.subtext0,
      disabled: palette.overlay1,
    },

    border: {
      default: palette.surface1,
      light: palette.surface0,
      hover: palette.surface2,
      focus: palette.blue,
    },

    terminal: {
      background: palette.base,
      foreground: palette.text,
      cursor: palette.rosewater,
      cursorAccent: palette.base,
      selectionBackground: 'rgba(30, 102, 245, 0.2)',

      // Standard ANSI colors
      black: palette.subtext1,
      red: palette.red,
      green: palette.green,
      yellow: palette.yellow,
      blue: palette.blue,
      magenta: palette.pink,
      cyan: palette.teal,
      white: palette.surface1,

      // Bright ANSI colors
      brightBlack: palette.subtext0,
      brightRed: palette.maroon,
      brightGreen: '#4ab235',
      brightYellow: '#e99e2d',
      brightBlue: palette.lavender,
      brightMagenta: palette.mauve,
      brightCyan: palette.sky,
      brightWhite: palette.surface2,
    },
  },
};

export default catppuccinLatte;
