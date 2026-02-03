// ============================================================================
// TOKYO NIGHT THEME - Tokyo Night color scheme
// ============================================================================
//
// Based on the Tokyo Night theme specification
// Background: #1a1b26, Foreground: #a9b1d6
// Primary: Blue (#7aa2f7), Accent: Magenta (#bb9af7)
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

// Tokyo Night official colors
const TOKYO_NIGHT = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  blue: '#7aa2f7',
  cyan: '#7dcfff',
  green: '#9ece6a',
  magenta: '#bb9af7',
  red: '#f7768e',
  yellow: '#e0af68',
  comment: '#565f89',
  terminalBlack: '#414868',
};

// Primary color scale (Blue #7aa2f7)
const primaryScale: ColorScale = {
  50: '#f0f5ff',
  100: '#e1ebff',
  200: '#c3d7ff',
  300: '#a5c3ff',
  400: '#7aa2f7', // Base blue
  500: '#6490e5',
  600: '#4e7ed3',
  700: '#386cc1',
  800: '#225aaf',
  900: '#0c489d',
  950: '#00368b',
};

// Accent color scale (Magenta #bb9af7)
const accentScale: ColorScale = {
  50: '#f8f0ff',
  100: '#f1e1ff',
  200: '#e3c3ff',
  300: '#d5a5ff',
  400: '#bb9af7', // Base magenta
  500: '#a586e3',
  600: '#8f72cf',
  700: '#795ebb',
  800: '#634aa7',
  900: '#4d3693',
  950: '#37227f',
};

// Surface color scale (based on background #1a1b26)
const surfaceScale: ColorScale = {
  50: '#f5f5f9',
  100: '#e0e1eb',
  200: '#c0c3d7',
  300: '#a9b1d6', // Foreground
  400: '#7a82a6',
  500: '#565f89', // Comment
  600: '#414868', // Terminal black
  700: '#2f344d',
  800: '#1a1b26', // Background
  900: '#13141d',
  950: '#0c0d14',
};

// Success color scale (Green #9ece6a)
const successScale: ColorScale = {
  50: '#f5fced',
  100: '#ebf9db',
  200: '#d7f3b7',
  300: '#c3ed93',
  400: '#9ece6a', // Base green
  500: '#83b450',
  600: '#689a36',
  700: '#4d801c',
  800: '#326602',
  900: '#174c00',
  950: '#003200',
};

// Warning color scale (Yellow #e0af68)
const warningScale: ColorScale = {
  50: '#fef8ed',
  100: '#fdf1db',
  200: '#fbe3b7',
  300: '#f9d593',
  400: '#e0af68', // Base yellow
  500: '#c6954e',
  600: '#ac7b34',
  700: '#92611a',
  800: '#784700',
  900: '#5e2d00',
  950: '#441300',
};

// Error color scale (Red #f7768e)
const errorScale: ColorScale = {
  50: '#fff0f2',
  100: '#ffe1e5',
  200: '#ffc3cb',
  300: '#ffa5b1',
  400: '#f7768e', // Base red
  500: '#dd5c74',
  600: '#c3425a',
  700: '#a92840',
  800: '#8f0e26',
  900: '#75000c',
  950: '#5b0000',
};

// Info color scale (Cyan #7dcfff)
const infoScale: ColorScale = {
  50: '#f0fbff',
  100: '#e1f7ff',
  200: '#c3efff',
  300: '#a5e7ff',
  400: '#7dcfff', // Base cyan
  500: '#63b7e7',
  600: '#499fcf',
  700: '#2f87b7',
  800: '#156f9f',
  900: '#005787',
  950: '#003f6f',
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

export const tokyoNightTheme: Theme = {
  id: 'tokyo-night',
  name: 'Tokyo Night',
  description: 'A clean, dark theme with vibrant colors inspired by the lights of Tokyo at night',
  author: 'enkia',
  variant: 'dark',
  colors: {
    primary: createSemanticColorSet(primaryScale, TOKYO_NIGHT.blue),
    accent: createSemanticColorSet(accentScale, TOKYO_NIGHT.magenta),
    surface: surfaceScale,
    success: createSemanticColorSet(successScale, TOKYO_NIGHT.green),
    warning: createSemanticColorSet(warningScale, TOKYO_NIGHT.yellow),
    error: createSemanticColorSet(errorScale, TOKYO_NIGHT.red),
    info: createSemanticColorSet(infoScale, TOKYO_NIGHT.cyan),

    bg: {
      primary: TOKYO_NIGHT.background,
      secondary: '#13141d',
      tertiary: '#1f202e',
      hover: '#292a3c',
      elevated: '#24253a',
      active: '#343549',
    },

    text: {
      primary: TOKYO_NIGHT.foreground,
      secondary: '#9aa5ce',
      muted: TOKYO_NIGHT.comment,
      disabled: TOKYO_NIGHT.terminalBlack,
    },

    border: {
      default: '#2f344d',
      light: '#232433',
      hover: TOKYO_NIGHT.terminalBlack,
      focus: TOKYO_NIGHT.blue,
    },

    terminal: {
      background: TOKYO_NIGHT.background,
      foreground: TOKYO_NIGHT.foreground,
      cursor: TOKYO_NIGHT.foreground,
      cursorAccent: TOKYO_NIGHT.background,
      selectionBackground: 'rgba(65, 72, 104, 0.5)',

      // Standard ANSI colors
      black: '#15161e',
      red: TOKYO_NIGHT.red,
      green: TOKYO_NIGHT.green,
      yellow: TOKYO_NIGHT.yellow,
      blue: TOKYO_NIGHT.blue,
      magenta: TOKYO_NIGHT.magenta,
      cyan: TOKYO_NIGHT.cyan,
      white: TOKYO_NIGHT.foreground,

      // Bright ANSI colors
      brightBlack: TOKYO_NIGHT.terminalBlack,
      brightRed: '#ff8fa3',
      brightGreen: '#b3e07b',
      brightYellow: '#ebc17a',
      brightBlue: '#8cb4ff',
      brightMagenta: '#ccabff',
      brightCyan: '#8fdbff',
      brightWhite: '#c0caf5',
    },
  },
};

export default tokyoNightTheme;
