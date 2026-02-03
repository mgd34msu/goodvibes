// ============================================================================
// ONE DARK THEME - Atom One Dark color scheme
// ============================================================================
//
// Based on the Atom One Dark theme specification
// Background: #282c34, Foreground: #abb2bf
// Primary: Blue (#61afef), Accent: Magenta (#c678dd)
//
// ============================================================================

import type { Theme, SemanticColorSet, ColorScale } from '@shared/types/theme-types';

// Helper to create rgba glow colors from hex
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// One Dark official colors
const ONE_DARK = {
  background: '#282c34',
  gutter: '#21252b',
  foreground: '#abb2bf',
  comment: '#5c6370',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
};

// Primary color scale (Blue #61afef)
const primaryScale: ColorScale = {
  50: '#f0f7ff',
  100: '#e1efff',
  200: '#c3dfff',
  300: '#a5cfff',
  400: '#61afef', // Base blue
  500: '#4d9bdb',
  600: '#3987c7',
  700: '#2573b3',
  800: '#115f9f',
  900: '#004b8b',
  950: '#003777',
};

// Accent color scale (Magenta #c678dd)
const accentScale: ColorScale = {
  50: '#faf0ff',
  100: '#f5e1ff',
  200: '#ebc3ff',
  300: '#e1a5ff',
  400: '#c678dd', // Base magenta
  500: '#b264c9',
  600: '#9e50b5',
  700: '#8a3ca1',
  800: '#76288d',
  900: '#621479',
  950: '#4e0065',
};

// Surface color scale (based on background #282c34)
const surfaceScale: ColorScale = {
  50: '#f8f9fa',
  100: '#e1e4e8',
  200: '#c8ccd2',
  300: '#abb2bf', // Foreground
  400: '#8a919c',
  500: '#5c6370', // Comment
  600: '#4b5263',
  700: '#3a3f4b',
  800: '#282c34', // Background
  900: '#21252b', // Gutter
  950: '#181b20',
};

// Success color scale (Green #98c379)
const successScale: ColorScale = {
  50: '#f3faf0',
  100: '#e7f5e1',
  200: '#cfebc3',
  300: '#b7e1a5',
  400: '#98c379', // Base green
  500: '#7daa5f',
  600: '#629145',
  700: '#47782b',
  800: '#2c5f11',
  900: '#114600',
  950: '#002d00',
};

// Warning color scale (Yellow #e5c07b)
const warningScale: ColorScale = {
  50: '#fefaed',
  100: '#fdf5db',
  200: '#fbeab7',
  300: '#f9df93',
  400: '#e5c07b', // Base yellow
  500: '#cba65f',
  600: '#b18c43',
  700: '#977227',
  800: '#7d580b',
  900: '#633e00',
  950: '#492400',
};

// Error color scale (Red #e06c75)
const errorScale: ColorScale = {
  50: '#fef0f1',
  100: '#fde1e3',
  200: '#fbc3c7',
  300: '#f9a5ab',
  400: '#e06c75', // Base red
  500: '#c6525b',
  600: '#ac3841',
  700: '#921e27',
  800: '#78040d',
  900: '#5e0000',
  950: '#440000',
};

// Info color scale (Cyan #56b6c2)
const infoScale: ColorScale = {
  50: '#f0fafb',
  100: '#e1f5f7',
  200: '#c3ebef',
  300: '#a5e1e7',
  400: '#56b6c2', // Base cyan
  500: '#429ca8',
  600: '#2e828e',
  700: '#1a6874',
  800: '#064e5a',
  900: '#003440',
  950: '#001a26',
};

// Create semantic color set with glows and gradients
function createSemanticColorSet(scale: ColorScale, baseHex: string): SemanticColorSet {
  return {
    ...scale,
    glow: {
      default: hexToRgba(baseHex, 0.5),
      strong: hexToRgba(baseHex, 0.7),
      subtle: hexToRgba(baseHex, 0.25),
      muted: hexToRgba(baseHex, 0.15),
      faint: hexToRgba(baseHex, 0.08),
    },
    gradient: {
      start: scale[600],
      mid: scale[500],
      end: scale[400],
    },
  };
}

export const oneDarkTheme: Theme = {
  id: 'one-dark',
  name: 'One Dark',
  description: 'A dark theme inspired by Atom\'s iconic One Dark syntax theme',
  author: 'GitHub',
  variant: 'dark',
  colors: {
    primary: createSemanticColorSet(primaryScale, ONE_DARK.blue),
    accent: createSemanticColorSet(accentScale, ONE_DARK.magenta),
    surface: surfaceScale,
    success: createSemanticColorSet(successScale, ONE_DARK.green),
    warning: createSemanticColorSet(warningScale, ONE_DARK.yellow),
    error: createSemanticColorSet(errorScale, ONE_DARK.red),
    info: createSemanticColorSet(infoScale, ONE_DARK.cyan),

    bg: {
      primary: ONE_DARK.background,
      secondary: ONE_DARK.gutter,
      tertiary: '#3a3f4b',
      hover: '#3e4451',
      elevated: '#4b5263',
      active: '#5c6370',
    },

    text: {
      primary: ONE_DARK.foreground,
      secondary: '#8a919c',
      muted: ONE_DARK.comment,
      disabled: '#4b5263',
    },

    border: {
      default: '#3a3f4b',
      light: '#2c313a',
      hover: '#4b5263',
      focus: ONE_DARK.blue,
    },

    terminal: {
      background: ONE_DARK.background,
      foreground: ONE_DARK.foreground,
      cursor: ONE_DARK.foreground,
      cursorAccent: ONE_DARK.background,
      selectionBackground: 'rgba(59, 66, 82, 0.5)',

      // Standard ANSI colors
      black: '#1e2127',
      red: ONE_DARK.red,
      green: ONE_DARK.green,
      yellow: ONE_DARK.yellow,
      blue: ONE_DARK.blue,
      magenta: ONE_DARK.magenta,
      cyan: ONE_DARK.cyan,
      white: ONE_DARK.foreground,

      // Bright ANSI colors
      brightBlack: ONE_DARK.comment,
      brightRed: '#e88388',
      brightGreen: '#a9d08e',
      brightYellow: '#ebcc8b',
      brightBlue: '#7fc1f5',
      brightMagenta: '#d190e8',
      brightCyan: '#6bc5d0',
      brightWhite: '#ffffff',
    },
  },
};

export default oneDarkTheme;
