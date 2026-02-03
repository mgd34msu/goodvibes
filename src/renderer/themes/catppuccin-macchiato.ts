// ============================================================================
// CATPPUCCIN MACCHIATO THEME - A warm dark variant
// ============================================================================
//
// Official Catppuccin color palette: https://github.com/catppuccin/catppuccin
// Macchiato is slightly lighter than Mocha, with a warmer feel.
//
// ============================================================================

import type { Theme, SemanticColorSet, ColorScale } from '@shared/types/theme-types';

// =============================================================================
// Catppuccin Macchiato Base Palette
// =============================================================================
const palette = {
  // Base colors
  base: '#24273a',
  mantle: '#1e2030',
  crust: '#181926',

  // Surface colors
  surface0: '#363a4f',
  surface1: '#494d64',
  surface2: '#5b6078',

  // Overlay colors
  overlay0: '#6e738d',
  overlay1: '#8087a2',
  overlay2: '#939ab7',

  // Text colors
  text: '#cad3f5',
  subtext0: '#a5adcb',
  subtext1: '#b8c0e0',

  // Accent colors
  rosewater: '#f4dbd6',
  flamingo: '#f0c6c6',
  pink: '#f5bde6',
  mauve: '#c6a0f6',
  red: '#ed8796',
  maroon: '#ee99a0',
  peach: '#f5a97f',
  yellow: '#eed49f',
  green: '#a6da95',
  teal: '#8bd5ca',
  sky: '#91d7e3',
  sapphire: '#7dc4e4',
  blue: '#8aadf4',
  lavender: '#b7bdf8',
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
  600: '#7ba0e8',
  700: '#6c91d9',
  800: '#5d82ca',
  900: '#4a6ba8',
  950: '#3a5382',
  glow: createGlowColors(palette.blue),
  gradient: {
    start: '#6c91d9',
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
  600: '#b492e8',
  700: '#a284d9',
  800: '#9076ca',
  900: '#7a63a8',
  950: '#5f4d82',
  glow: createGlowColors(palette.mauve),
  gradient: {
    start: '#a284d9',
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
  500: '#8fc98a',
  600: '#7bba75',
  700: '#68ab61',
  800: '#579c4f',
  900: '#478740',
  950: '#366832',
  glow: createGlowColors(palette.green),
  gradient: {
    start: '#68ab61',
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
  500: '#e8a074',
  600: '#d99066',
  700: '#ca8058',
  800: '#bb704a',
  900: '#9e5f3e',
  950: '#784830',
  glow: createGlowColors(palette.yellow),
  gradient: {
    start: '#ca8058',
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
  500: '#e07d8b',
  600: '#d16e7c',
  700: '#c25f6d',
  800: '#b3505e',
  900: '#974350',
  950: '#763540',
  glow: createGlowColors(palette.red),
  gradient: {
    start: '#c25f6d',
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
  500: '#6fb5d5',
  600: '#61a6c6',
  700: '#5397b7',
  800: '#4588a8',
  900: '#397290',
  950: '#2c586e',
  glow: createGlowColors(palette.sapphire),
  gradient: {
    start: '#5397b7',
    mid: palette.sapphire,
    end: palette.sky,
  },
};

// =============================================================================
// Theme Export
// =============================================================================

export const catppuccinMacchiato: Theme = {
  id: 'catppuccin-macchiato',
  name: 'Catppuccin Macchiato',
  description: 'Soothing pastel theme - warm dark variant',
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
      selectionBackground: 'rgba(138, 173, 244, 0.3)',

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
      brightGreen: '#b6eaa5',
      brightYellow: '#f5e0b0',
      brightBlue: palette.lavender,
      brightMagenta: palette.mauve,
      brightCyan: palette.sky,
      brightWhite: palette.text,
    },
  },
};

export default catppuccinMacchiato;
