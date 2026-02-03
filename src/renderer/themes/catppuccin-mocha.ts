// ============================================================================
// CATPPUCCIN MOCHA THEME - The darkest Catppuccin variant
// ============================================================================
//
// Official Catppuccin color palette: https://github.com/catppuccin/catppuccin
// Mocha is the darkest variant, ideal for low-light environments.
//
// ============================================================================

import type { Theme, SemanticColorSet, ColorScale } from '@shared/types/theme-types';

// =============================================================================
// Catppuccin Mocha Base Palette
// =============================================================================
const palette = {
  // Base colors
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',

  // Surface colors
  surface0: '#313244',
  surface1: '#45475a',
  surface2: '#585b70',

  // Overlay colors
  overlay0: '#6c7086',
  overlay1: '#7f849c',
  overlay2: '#9399b2',

  // Text colors
  text: '#cdd6f4',
  subtext0: '#a6adc8',
  subtext1: '#bac2de',

  // Accent colors
  rosewater: '#f5e0dc',
  flamingo: '#f2cdcd',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  maroon: '#eba0ac',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  sky: '#89dceb',
  sapphire: '#74c7ec',
  blue: '#89b4fa',
  lavender: '#b4befe',
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
  600: '#7aa2f7',
  700: '#6b8de6',
  800: '#5c7ad4',
  900: '#4a63b3',
  950: '#3a4d8a',
  glow: createGlowColors(palette.blue),
  gradient: {
    start: '#6b8de6',
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
  600: '#b794f4',
  700: '#a378dc',
  800: '#8b5fc4',
  900: '#7349a4',
  950: '#5a3780',
  glow: createGlowColors(palette.mauve),
  gradient: {
    start: '#a378dc',
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
  500: '#8bd5a1',
  600: '#6ec98e',
  700: '#5bb87a',
  800: '#4ca367',
  900: '#3d8a56',
  950: '#2d6b42',
  glow: createGlowColors(palette.green),
  gradient: {
    start: '#5bb87a',
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
  500: '#f5a97f',
  600: '#e89b6f',
  700: '#d68a5f',
  800: '#c47a50',
  900: '#a66642',
  950: '#7d4e32',
  glow: createGlowColors(palette.yellow),
  gradient: {
    start: '#d68a5f',
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
  500: '#e87d96',
  600: '#d66b84',
  700: '#c45a72',
  800: '#b04a61',
  900: '#9a3d51',
  950: '#7a2f40',
  glow: createGlowColors(palette.red),
  gradient: {
    start: '#c45a72',
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
  500: '#6cb8d9',
  600: '#5aa6c7',
  700: '#4a94b5',
  800: '#3c82a3',
  900: '#316b87',
  950: '#245266',
  glow: createGlowColors(palette.sapphire),
  gradient: {
    start: '#4a94b5',
    mid: palette.sapphire,
    end: palette.sky,
  },
};

// =============================================================================
// Theme Export
// =============================================================================

export const catppuccinMocha: Theme = {
  id: 'catppuccin-mocha',
  name: 'Catppuccin Mocha',
  description: 'Soothing pastel theme - the darkest variant',
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
      selectionBackground: 'rgba(137, 180, 250, 0.3)',

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
      brightGreen: '#b5eda1',
      brightYellow: '#fbefc0',
      brightBlue: palette.lavender,
      brightMagenta: palette.mauve,
      brightCyan: palette.sky,
      brightWhite: palette.text,
    },
  },
};

export default catppuccinMocha;
