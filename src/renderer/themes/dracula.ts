// ============================================================================
// DRACULA THEME - Official Dracula color scheme
// ============================================================================
//
// Based on the official Dracula specification: https://draculatheme.com/
// Background: #282a36, Foreground: #f8f8f2
// Primary: Purple (#bd93f9), Accent: Pink (#ff79c6)
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

// Dracula official colors
const DRACULA = {
  background: '#282a36',
  currentLine: '#44475a',
  selection: '#44475a',
  foreground: '#f8f8f2',
  comment: '#6272a4',
  cyan: '#8be9fd',
  green: '#50fa7b',
  orange: '#ffb86c',
  pink: '#ff79c6',
  purple: '#bd93f9',
  red: '#ff5555',
  yellow: '#f1fa8c',
};

// Primary color scale (Purple #bd93f9)
const primaryScale: ColorScale = {
  50: '#f5f0fe',
  100: '#ebe1fd',
  200: '#d7c3fb',
  300: '#c3a5f9',
  400: '#bd93f9', // Base purple
  500: '#a87df7',
  600: '#9367e0',
  700: '#7e51c9',
  800: '#693bb2',
  900: '#54259b',
  950: '#3f0f84',
};

// Accent color scale (Pink #ff79c6)
const accentScale: ColorScale = {
  50: '#fff0f7',
  100: '#ffe1ef',
  200: '#ffc3df',
  300: '#ffa5cf',
  400: '#ff79c6', // Base pink
  500: '#f55db0',
  600: '#db419a',
  700: '#c12584',
  800: '#a7096e',
  900: '#8d0058',
  950: '#730042',
};

// Surface color scale (based on background #282a36)
const surfaceScale: ColorScale = {
  50: '#f8f8f2', // Foreground as lightest
  100: '#d8d8d2',
  200: '#b8b8b2',
  300: '#989892',
  400: '#6272a4', // Comment color
  500: '#44475a', // Current line / selection
  600: '#383a4a',
  700: '#2c2e3a',
  800: '#282a36', // Background
  900: '#1e1f29',
  950: '#14151c',
};

// Success color scale (Green #50fa7b)
const successScale: ColorScale = {
  50: '#edfff3',
  100: '#dbffe7',
  200: '#b7ffcf',
  300: '#93ffb7',
  400: '#50fa7b', // Base green
  500: '#40d868',
  600: '#30b655',
  700: '#209442',
  800: '#10722f',
  900: '#00501c',
  950: '#002e09',
};

// Warning color scale (Orange #ffb86c)
const warningScale: ColorScale = {
  50: '#fff8ed',
  100: '#fff1db',
  200: '#ffe3b7',
  300: '#ffd593',
  400: '#ffb86c', // Base orange
  500: '#e09a4e',
  600: '#c17c30',
  700: '#a25e12',
  800: '#834000',
  900: '#642200',
  950: '#450400',
};

// Error color scale (Red #ff5555)
const errorScale: ColorScale = {
  50: '#fff0f0',
  100: '#ffe1e1',
  200: '#ffc3c3',
  300: '#ffa5a5',
  400: '#ff5555', // Base red
  500: '#e03c3c',
  600: '#c12323',
  700: '#a20a0a',
  800: '#830000',
  900: '#640000',
  950: '#450000',
};

// Info color scale (Cyan #8be9fd)
const infoScale: ColorScale = {
  50: '#f0fdff',
  100: '#e1fbff',
  200: '#c3f7ff',
  300: '#a5f3ff',
  400: '#8be9fd', // Base cyan
  500: '#6dd0e4',
  600: '#4fb7cb',
  700: '#319eb2',
  800: '#138599',
  900: '#006c80',
  950: '#005367',
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

export const draculaTheme: Theme = {
  id: 'dracula',
  name: 'Dracula',
  description: 'A dark theme with vibrant colors inspired by classic vampire aesthetics',
  author: 'Zeno Rocha',
  variant: 'dark',
  colors: {
    primary: createSemanticColorSet(primaryScale, DRACULA.purple),
    accent: createSemanticColorSet(accentScale, DRACULA.pink),
    surface: surfaceScale,
    success: createSemanticColorSet(successScale, DRACULA.green),
    warning: createSemanticColorSet(warningScale, DRACULA.orange),
    error: createSemanticColorSet(errorScale, DRACULA.red),
    info: createSemanticColorSet(infoScale, DRACULA.cyan),

    bg: {
      primary: DRACULA.background,
      secondary: '#1e1f29',
      tertiary: DRACULA.currentLine,
      hover: '#383a4a',
      elevated: '#44475a',
      active: '#525466',
    },

    text: {
      primary: DRACULA.foreground,
      secondary: '#d8d8d2',
      muted: DRACULA.comment,
      disabled: '#525466',
    },

    border: {
      default: '#44475a',
      light: '#383a4a',
      hover: '#525466',
      focus: DRACULA.purple,
    },

    terminal: {
      background: DRACULA.background,
      foreground: DRACULA.foreground,
      cursor: DRACULA.foreground,
      cursorAccent: DRACULA.background,
      selectionBackground: 'rgba(68, 71, 90, 0.5)',

      // Standard ANSI colors
      black: '#21222c',
      red: DRACULA.red,
      green: DRACULA.green,
      yellow: DRACULA.yellow,
      blue: DRACULA.purple,
      magenta: DRACULA.pink,
      cyan: DRACULA.cyan,
      white: DRACULA.foreground,

      // Bright ANSI colors
      brightBlack: DRACULA.comment,
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
};

export default draculaTheme;
