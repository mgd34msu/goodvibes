// ============================================================================
// NORD THEME
// ============================================================================
//
// Based on the official Nord color palette: https://www.nordtheme.com/
//
// Polar Night (dark backgrounds): #2e3440, #3b4252, #434c5e, #4c566a
// Snow Storm (light text): #d8dee9, #e5e9f0, #eceff4
// Frost (blues): #8fbcbb, #88c0d0, #81a1c1, #5e81ac
// Aurora (accents): Red #bf616a, Orange #d08770, Yellow #ebcb8b,
//                   Green #a3be8c, Purple #b48ead
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

// Nord Primary - Frost Blue (#81a1c1)
const primary: SemanticColorSet = {
  50: '#f0f4f8',
  100: '#dae4ed',
  200: '#b8cde0',
  300: '#94b4d1',
  400: '#81a1c1',
  500: '#6d8faf',
  600: '#5e81ac',
  700: '#4e6e91',
  800: '#405a76',
  900: '#344860',
  950: '#232f3e',
  glow: createGlow('#81a1c1'),
  gradient: createGradient('#5e81ac', '#6d8faf', '#81a1c1'),
};

// Nord Accent - Aurora Purple (#b48ead)
const accent: SemanticColorSet = {
  50: '#faf5f9',
  100: '#f2e6f0',
  200: '#e4cce0',
  300: '#d4aece',
  400: '#b48ead',
  500: '#a07a9a',
  600: '#8c6987',
  700: '#755873',
  800: '#5f485e',
  900: '#4c3a4c',
  950: '#2e2330',
  glow: createGlow('#b48ead'),
  gradient: createGradient('#8c6987', '#a07a9a', '#b48ead'),
};

// Nord Surface - Polar Night scale
const surface: ColorScale = {
  50: '#eceff4',
  100: '#e5e9f0',
  200: '#d8dee9',
  300: '#a5b1c2',
  400: '#7b8a9e',
  500: '#4c566a',
  600: '#434c5e',
  700: '#3b4252',
  800: '#2e3440',
  900: '#272c36',
  950: '#1e222a',
};

// Nord Success - Aurora Green (#a3be8c)
const success: SemanticColorSet = {
  50: '#f5f9f2',
  100: '#e8f0e3',
  200: '#d1e2c7',
  300: '#b8d2a8',
  400: '#a3be8c',
  500: '#8ba873',
  600: '#74905d',
  700: '#5f764c',
  800: '#4c5f3e',
  900: '#3d4c32',
  950: '#262f20',
  glow: createGlow('#a3be8c'),
  gradient: createGradient('#74905d', '#8ba873', '#a3be8c'),
};

// Nord Warning - Aurora Yellow (#ebcb8b)
const warning: SemanticColorSet = {
  50: '#fdf9f0',
  100: '#faf0db',
  200: '#f5e2b8',
  300: '#f0d494',
  400: '#ebcb8b',
  500: '#d4b574',
  600: '#b89a5c',
  700: '#97804c',
  800: '#78663e',
  900: '#5f5132',
  950: '#3a3220',
  glow: createGlow('#ebcb8b'),
  gradient: createGradient('#b89a5c', '#d4b574', '#ebcb8b'),
};

// Nord Error - Aurora Red (#bf616a)
const error: SemanticColorSet = {
  50: '#fdf4f5',
  100: '#fae5e7',
  200: '#f4c8cc',
  300: '#eca8ae',
  400: '#bf616a',
  500: '#a8525a',
  600: '#8f454c',
  700: '#763a40',
  800: '#5e2f34',
  900: '#4a262a',
  950: '#2e181a',
  glow: createGlow('#bf616a'),
  gradient: createGradient('#8f454c', '#a8525a', '#bf616a'),
};

// Nord Info - Frost Cyan (#88c0d0)
const info: SemanticColorSet = {
  50: '#f0f8fa',
  100: '#dceff4',
  200: '#b9dfe9',
  300: '#96cfde',
  400: '#88c0d0',
  500: '#72a9b9',
  600: '#5d919f',
  700: '#4d7784',
  800: '#3f6069',
  900: '#334d54',
  950: '#203033',
  glow: createGlow('#88c0d0'),
  gradient: createGradient('#5d919f', '#72a9b9', '#88c0d0'),
};

export const nord: Theme = {
  id: 'nord',
  name: 'Nord',
  description: 'An arctic, north-bluish color palette with clean aesthetics',
  author: 'Arctic Ice Studio',
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
      primary: '#2e3440',
      secondary: '#3b4252',
      tertiary: '#434c5e',
      hover: '#4c566a',
      elevated: '#434c5e',
      active: '#4c566a',
    },
    text: {
      primary: '#eceff4',
      secondary: '#d8dee9',
      muted: '#a5b1c2',
      disabled: '#7b8a9e',
    },
    border: {
      default: '#4c566a',
      light: '#434c5e',
      hover: '#5e81ac',
      focus: '#81a1c1',
    },
    terminal: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: 'rgba(136, 192, 208, 0.3)',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
};
