// ============================================================================
// CATPPUCCIN FRAPPE THEME - A medium dark variant
// ============================================================================
//
// Official Catppuccin color palette: https://github.com/catppuccin/catppuccin
// Frappe is the medium dark variant, balanced for most environments.
//
// ============================================================================

import type { Theme, SemanticColorSet, ColorScale } from '@shared/types/theme-types';

// =============================================================================
// Catppuccin Frappe Base Palette
// =============================================================================
const palette = {
  // Base colors
  base: '#303446',
  mantle: '#292c3c',
  crust: '#232634',

  // Surface colors
  surface0: '#414559',
  surface1: '#51576d',
  surface2: '#626880',

  // Overlay colors
  overlay0: '#737994',
  overlay1: '#838ba7',
  overlay2: '#949cbb',

  // Text colors
  text: '#c6d0f5',
  subtext0: '#a5adce',
  subtext1: '#b5bfe2',

  // Accent colors
  rosewater: '#f2d5cf',
  flamingo: '#eebebe',
  pink: '#f4b8e4',
  mauve: '#ca9ee6',
  red: '#e78284',
  maroon: '#ea999c',
  peach: '#ef9f76',
  yellow: '#e5c890',
  green: '#a6d189',
  teal: '#81c8be',
  sky: '#99d1db',
  sapphire: '#85c1dc',
  blue: '#8caaee',
  lavender: '#babbf1',
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

// Primary: Blue/Lavender scale
const primaryScale: SemanticColorSet = {
  50: '#f0f4ff',
  100: '#dbe4ff',
  200: '#bac8ff',
  300: '#91a7ff',
  400: '#748ffc',
  500: palette.blue,
  600: '#7e9de2',
  700: '#7090d5',
  800: '#6283c8',
  900: '#506db0',
  950: '#3e5589',
  glow: createGlowColors(palette.blue),
  gradient: {
    start: '#7090d5',
    mid: palette.blue,
    end: palette.lavender,
  },
};

// Accent: Mauve/Pink scale
const accentScale: SemanticColorSet = {
  50: '#fdf4ff',
  100: '#fae8ff',
  200: '#f5d0fe',
  300: '#e9b3f5',
  400: palette.pink,
  500: palette.mauve,
  600: '#b890db',
  700: '#a682cf',
  800: '#9474c3',
  900: '#7d62ab',
  950: '#614c85',
  glow: createGlowColors(palette.mauve),
  gradient: {
    start: '#a682cf',
    mid: palette.mauve,
    end: palette.pink,
  },
};

// Surface: Catppuccin base to overlay scale
const surfaceScale: ColorScale = {
  50: palette.text,
  100: palette.subtext1,
  200: palette.subtext0,
  300: palette.overlay2,
  400: palette.overlay1,
  500: palette.overlay0,
  600: palette.surface2,
  700: palette.surface1,
  800: palette.surface0,
  900: palette.base,
  950: palette.crust,
};

// Success: Green/Teal scale
const successScale: SemanticColorSet = {
  50: '#ecfdf5',
  100: '#d1fae5',
  200: '#a7f3d0',
  300: palette.teal,
  400: palette.green,
  500: '#92c37e',
  600: '#80b56f',
  700: '#6ea760',
  800: '#5c9951',
  900: '#4c8544',
  950: '#3a6635',
  glow: createGlowColors(palette.green),
  gradient: {
    start: '#6ea760',
    mid: palette.green,
    end: palette.teal,
  },
};

// Warning: Yellow/Peach scale
const warningScale: SemanticColorSet = {
  50: '#fffbeb',
  100: '#fef3c7',
  200: '#fde68a',
  300: palette.yellow,
  400: palette.peach,
  500: '#e2946c',
  600: '#d5865f',
  700: '#c87852',
  800: '#bb6a45',
  900: '#a05a3a',
  950: '#7a452d',
  glow: createGlowColors(palette.yellow),
  gradient: {
    start: '#c87852',
    mid: palette.peach,
    end: palette.yellow,
  },
};

// Error: Red/Maroon scale
const errorScale: SemanticColorSet = {
  50: '#fff1f2',
  100: '#ffe4e6',
  200: '#fecdd3',
  300: palette.maroon,
  400: palette.red,
  500: '#da7879',
  600: '#cd6c6d',
  700: '#c06061',
  800: '#b35455',
  900: '#984747',
  950: '#773838',
  glow: createGlowColors(palette.red),
  gradient: {
    start: '#c06061',
    mid: palette.red,
    end: palette.maroon,
  },
};

// Info: Sapphire/Sky scale
const infoScale: SemanticColorSet = {
  50: '#ecfeff',
  100: '#cffafe',
  200: '#a5f3fc',
  300: palette.sky,
  400: palette.sapphire,
  500: '#77b3cf',
  600: '#69a5c2',
  700: '#5b97b5',
  800: '#4d89a8',
  900: '#41738f',
  950: '#32596e',
  glow: createGlowColors(palette.sapphire),
  gradient: {
    start: '#5b97b5',
    mid: palette.sapphire,
    end: palette.sky,
  },
};

// =============================================================================
// Theme Export
// =============================================================================

export const catppuccinFrappe: Theme = {
  id: 'catppuccin-frappe',
  name: 'Catppuccin Frappe',
  description: 'Soothing pastel theme - medium dark variant',
  author: 'Catppuccin',
  variant: 'dark',
  colors: {
    primary: primaryScale,
    accent: accentScale,
    surface: surfaceScale,
    success: successScale,
    warning: warningScale,
    error: errorScale,
    info: infoScale,

    bg: {
      primary: palette.crust,
      secondary: palette.mantle,
      tertiary: palette.base,
      hover: palette.surface0,
      elevated: palette.surface1,
      active: palette.surface2,
    },

    text: {
      primary: palette.text,
      secondary: palette.subtext1,
      muted: palette.subtext0,
      disabled: palette.overlay0,
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
      selectionBackground: 'rgba(140, 170, 238, 0.3)',

      // Standard ANSI colors
      black: palette.surface1,
      red: palette.red,
      green: palette.green,
      yellow: palette.yellow,
      blue: palette.blue,
      magenta: palette.pink,
      cyan: palette.teal,
      white: palette.subtext1,

      // Bright ANSI colors
      brightBlack: palette.surface2,
      brightRed: palette.maroon,
      brightGreen: '#b6e199',
      brightYellow: '#efd4a1',
      brightBlue: palette.lavender,
      brightMagenta: palette.mauve,
      brightCyan: palette.sky,
      brightWhite: palette.text,
    },
  },
};

export default catppuccinFrappe;
