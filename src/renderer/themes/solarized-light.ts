// ============================================================================
// SOLARIZED LIGHT THEME
// ============================================================================
//
// Based on the official Solarized color palette by Ethan Schoonover
// https://ethanschoonover.com/solarized/
//
// Base tones (light mode - swapped from dark):
// Base3:  #fdf6e3 (background)
// Base2:  #eee8d5 (background highlights)
// Base1:  #93a1a1 (comments, secondary content)
// Base0:  #839496 (body text)
// Base00: #657b83 (body text, default status bar)
// Base01: #586e75 (optional emphasized content)
//
// Accent colors (same as dark):
// Yellow:  #b58900  Orange: #cb4b16  Red:     #dc322f
// Magenta: #d33682  Violet: #6c71c4  Blue:    #268bd2
// Cyan:    #2aa198  Green:  #859900
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

// Solarized Primary - Blue (#268bd2)
const primary: SemanticColorSet = {
  50: '#f0f7fc',
  100: '#d9ecf8',
  200: '#b3d9f1',
  300: '#73bce5',
  400: '#429ed8',
  500: '#268bd2',
  600: '#1e73b0',
  700: '#1a5e8f',
  800: '#164c74',
  900: '#123d5d',
  950: '#0b263a',
  glow: createGlow('#268bd2'),
  gradient: createGradient('#1e73b0', '#268bd2', '#429ed8'),
};

// Solarized Accent - Violet (#6c71c4)
const accent: SemanticColorSet = {
  50: '#f5f5fc',
  100: '#e8e9f6',
  200: '#d1d3ed',
  300: '#b0b3de',
  400: '#8f93cf',
  500: '#6c71c4',
  600: '#5a5ea8',
  700: '#4a4d8a',
  800: '#3c3f70',
  900: '#31335a',
  950: '#1e1f38',
  glow: createGlow('#6c71c4'),
  gradient: createGradient('#5a5ea8', '#6c71c4', '#8f93cf'),
};

// Solarized Surface - Base tones scale (inverted for light mode)
const surface: ColorScale = {
  50: '#002b36',
  100: '#073642',
  200: '#586e75',
  300: '#657b83',
  400: '#839496',
  500: '#93a1a1',
  600: '#eee8d5',
  700: '#f5efe0',
  800: '#fdf6e3',
  900: '#fefbf0',
  950: '#fffef8',
};

// Solarized Success - Green (#859900)
const success: SemanticColorSet = {
  50: '#f6f9e6',
  100: '#eaf2c8',
  200: '#d5e591',
  300: '#b8d24b',
  400: '#9abf1a',
  500: '#859900',
  600: '#6d7d00',
  700: '#586600',
  800: '#475200',
  900: '#394100',
  950: '#232800',
  glow: createGlow('#859900'),
  gradient: createGradient('#6d7d00', '#859900', '#9abf1a'),
};

// Solarized Warning - Yellow (#b58900)
const warning: SemanticColorSet = {
  50: '#fdf8e6',
  100: '#faefcc',
  200: '#f5df99',
  300: '#e8c54d',
  400: '#d9a91a',
  500: '#b58900',
  600: '#967100',
  700: '#7a5c00',
  800: '#614900',
  900: '#4d3a00',
  950: '#302400',
  glow: createGlow('#b58900'),
  gradient: createGradient('#967100', '#b58900', '#d9a91a'),
};

// Solarized Error - Red (#dc322f)
const error: SemanticColorSet = {
  50: '#fdf3f3',
  100: '#fae3e3',
  200: '#f5c5c4',
  300: '#ed9a98',
  400: '#e36563',
  500: '#dc322f',
  600: '#b82826',
  700: '#982120',
  800: '#7b1b1a',
  900: '#631615',
  950: '#3d0d0c',
  glow: createGlow('#dc322f'),
  gradient: createGradient('#b82826', '#dc322f', '#e36563'),
};

// Solarized Info - Cyan (#2aa198)
const info: SemanticColorSet = {
  50: '#effaf9',
  100: '#d5f3f1',
  200: '#abe7e3',
  300: '#70d4cd',
  400: '#40bdb4',
  500: '#2aa198',
  600: '#22857d',
  700: '#1c6c66',
  800: '#175752',
  900: '#134643',
  950: '#0b2b29',
  glow: createGlow('#2aa198'),
  gradient: createGradient('#22857d', '#2aa198', '#40bdb4'),
};

export const solarizedLight: Theme = {
  id: 'solarized-light',
  name: 'Solarized Light',
  description: 'Precision colors for machines and people with light background',
  author: 'Ethan Schoonover',
  variant: 'light',
  colors: {
    primary,
    accent,
    surface,
    success,
    warning,
    error,
    info,
    bg: {
      primary: '#fdf6e3',
      secondary: '#eee8d5',
      tertiary: '#e6dfc9',
      hover: '#ded7bd',
      elevated: '#fffbf0',
      active: '#d6cfb1',
    },
    text: {
      primary: '#586e75',
      secondary: '#657b83',
      muted: '#839496',
      disabled: '#93a1a1',
    },
    border: {
      default: '#eee8d5',
      light: '#f5efe0',
      hover: '#268bd2',
      focus: '#268bd2',
    },
    terminal: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      cursorAccent: '#fdf6e3',
      selectionBackground: 'rgba(38, 139, 210, 0.2)',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#859900',
      brightYellow: '#b58900',
      brightBlue: '#268bd2',
      brightMagenta: '#6c71c4',
      brightCyan: '#2aa198',
      brightWhite: '#fdf6e3',
    },
  },
};
