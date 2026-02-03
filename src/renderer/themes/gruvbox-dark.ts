// ============================================================================
// GRUVBOX DARK THEME
// ============================================================================
//
// Based on the Gruvbox color palette by morhetz
// https://github.com/morhetz/gruvbox
//
// Dark mode backgrounds:
// Dark0:  #282828 (hard)
// Dark1:  #3c3836
// Dark2:  #504945
// Dark3:  #665c54
// Dark4:  #7c6f64
//
// Light mode foregrounds:
// Light0: #fbf1c7
// Light1: #ebdbb2
// Light2: #d5c4a1
// Light3: #bdae93
// Light4: #a89984
//
// Accent colors:
// Red:    #fb4934  Green:  #b8bb26  Yellow: #fabd2f
// Blue:   #83a598  Purple: #d3869b  Aqua:   #8ec07c
// Orange: #fe8019
//
// ============================================================================

import type { Theme, SemanticColorSet, ColorScale } from '@shared/types/theme-types';

/**
 * Helper to create glow colors from a base hex color
 */
function createGlow(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return {
    default: `rgba(${r}, ${g}, ${b}, 0.5)`,
    strong: `rgba(${r}, ${g}, ${b}, 0.7)`,
    subtle: `rgba(${r}, ${g}, ${b}, 0.25)`,
    muted: `rgba(${r}, ${g}, ${b}, 0.15)`,
    faint: `rgba(${r}, ${g}, ${b}, 0.08)`,
  };
}

/**
 * Helper to create gradient stops from color scale
 */
function createGradient(c600: string, c500: string, c400: string) {
  return {
    start: c600,
    mid: c500,
    end: c400,
  };
}

// Gruvbox Primary - Blue (#83a598)
const primary: SemanticColorSet = {
  50: '#f4f8f7',
  100: '#e2edeb',
  200: '#c5dbd7',
  300: '#a3c5bf',
  400: '#83a598',
  500: '#6d8f83',
  600: '#5a776c',
  700: '#4a6259',
  800: '#3c4f48',
  900: '#31403b',
  950: '#1e2824',
  glow: createGlow('#83a598'),
  gradient: createGradient('#5a776c', '#6d8f83', '#83a598'),
};

// Gruvbox Accent - Purple (#d3869b)
const accent: SemanticColorSet = {
  50: '#fcf6f8',
  100: '#f8e9ee',
  200: '#f1d2de',
  300: '#e6b2c6',
  400: '#d3869b',
  500: '#be6d85',
  600: '#a35870',
  700: '#87485c',
  800: '#6d3b4b',
  900: '#58313e',
  950: '#361d26',
  glow: createGlow('#d3869b'),
  gradient: createGradient('#a35870', '#be6d85', '#d3869b'),
};

// Gruvbox Surface - Dark scale
const surface: ColorScale = {
  50: '#fbf1c7',
  100: '#ebdbb2',
  200: '#d5c4a1',
  300: '#bdae93',
  400: '#a89984',
  500: '#7c6f64',
  600: '#665c54',
  700: '#504945',
  800: '#3c3836',
  900: '#282828',
  950: '#1d2021',
};

// Gruvbox Success - Green (#b8bb26)
const success: SemanticColorSet = {
  50: '#f9fae6',
  100: '#f2f4c8',
  200: '#e4e891',
  300: '#d3db53',
  400: '#b8bb26',
  500: '#9da31f',
  600: '#828719',
  700: '#6a6e15',
  800: '#555812',
  900: '#44470f',
  950: '#2a2c09',
  glow: createGlow('#b8bb26'),
  gradient: createGradient('#828719', '#9da31f', '#b8bb26'),
};

// Gruvbox Warning - Yellow (#fabd2f)
const warning: SemanticColorSet = {
  50: '#fffbe6',
  100: '#fef5c3',
  200: '#fdeb8a',
  300: '#fcdc48',
  400: '#fabd2f',
  500: '#e0a41f',
  600: '#bb8716',
  700: '#986c13',
  800: '#7a5611',
  900: '#63450e',
  950: '#3d2a08',
  glow: createGlow('#fabd2f'),
  gradient: createGradient('#bb8716', '#e0a41f', '#fabd2f'),
};

// Gruvbox Error - Red (#fb4934)
const error: SemanticColorSet = {
  50: '#fff3f1',
  100: '#fee2de',
  200: '#fdc5bd',
  300: '#fb9d90',
  400: '#fb4934',
  500: '#de3a28',
  600: '#ba2f20',
  700: '#98271a',
  800: '#7a2016',
  900: '#631a12',
  950: '#3d0f0b',
  glow: createGlow('#fb4934'),
  gradient: createGradient('#ba2f20', '#de3a28', '#fb4934'),
};

// Gruvbox Info - Aqua (#8ec07c)
const info: SemanticColorSet = {
  50: '#f4faf3',
  100: '#e4f4e1',
  200: '#c9e8c4',
  300: '#a4d79a',
  400: '#8ec07c',
  500: '#73a662',
  600: '#5d8a4e',
  700: '#4c7040',
  800: '#3e5a35',
  900: '#33492c',
  950: '#1f2d1a',
  glow: createGlow('#8ec07c'),
  gradient: createGradient('#5d8a4e', '#73a662', '#8ec07c'),
};

export const gruvboxDark: Theme = {
  id: 'gruvbox-dark',
  name: 'Gruvbox Dark',
  description: 'Retro groove color scheme with warm, earthy tones',
  author: 'morhetz',
  variant: 'dark',
  colors: {
    primary,
    accent,
    surface,
    success,
    warning,
    error,
    info,
    bg: {
      primary: '#282828',
      secondary: '#3c3836',
      tertiary: '#504945',
      hover: '#665c54',
      elevated: '#3c3836',
      active: '#665c54',
    },
    text: {
      primary: '#ebdbb2',
      secondary: '#d5c4a1',
      muted: '#a89984',
      disabled: '#7c6f64',
    },
    border: {
      default: '#504945',
      light: '#3c3836',
      hover: '#83a598',
      focus: '#83a598',
    },
    terminal: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: 'rgba(131, 165, 152, 0.3)',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
  },
};
