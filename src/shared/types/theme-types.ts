// ============================================================================
// THEME TYPES - Comprehensive type definitions for the theme system
// ============================================================================
//
// These types define the structure for themes based on the color system
// established in main.css. They support both dark and light variants with
// full color scales, glows, gradients, and semantic colors.
//
// ============================================================================

/**
 * Standard color scale with 11 shades from lightest (50) to darkest (950).
 * Based on Tailwind CSS color scale convention.
 */
export interface ColorScale {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
  950: string;
}

/**
 * Glow color variants for shadow and glow effects.
 * All values should be rgba colors with appropriate opacity levels.
 */
export interface GlowColors {
  /** Default glow - rgba with 0.5 opacity */
  default: string;
  /** Strong glow - rgba with 0.7 opacity */
  strong: string;
  /** Subtle glow - rgba with 0.25 opacity */
  subtle: string;
  /** Muted glow - rgba with 0.15 opacity */
  muted: string;
  /** Faint glow - rgba with 0.08 opacity */
  faint: string;
}

/**
 * Gradient stop colors for multi-stop gradients.
 */
export interface GradientStops {
  /** Starting color (typically 600 shade) */
  start: string;
  /** Middle color (typically 500 shade) */
  mid: string;
  /** Ending color (typically 400 shade) */
  end: string;
}

/**
 * Complete semantic color set including color scale, glow variants, and gradient stops.
 * Used for primary, accent, and semantic colors (success, warning, error, info).
 */
export interface SemanticColorSet extends ColorScale {
  /** Glow color variants for shadows and effects */
  glow: GlowColors;
  /** Gradient stop colors */
  gradient: GradientStops;
}

/**
 * Background colors for various UI states and surfaces.
 */
export interface BackgroundColors {
  /** Main app background (darkest in dark mode) */
  primary: string;
  /** Secondary containers */
  secondary: string;
  /** Cards, panels, tertiary surfaces */
  tertiary: string;
  /** Hover states */
  hover: string;
  /** Elevated surfaces like modals and dropdowns */
  elevated: string;
  /** Active/pressed elements */
  active: string;
}

/**
 * Text colors for different hierarchy levels.
 */
export interface TextColors {
  /** Main text - highest contrast */
  primary: string;
  /** Secondary text - medium emphasis */
  secondary: string;
  /** Muted/tertiary text - low emphasis */
  muted: string;
  /** Disabled text - lowest contrast */
  disabled: string;
}

/**
 * Border colors for different states.
 */
export interface BorderColors {
  /** Default border color */
  default: string;
  /** Lighter border variant */
  light: string;
  /** Hover state border */
  hover: string;
  /** Focus state border (typically primary-500) */
  focus: string;
}

/**
 * Terminal/xterm color palette including ANSI colors.
 */
export interface TerminalColors {
  /** Terminal background */
  background: string;
  /** Terminal foreground/text */
  foreground: string;
  /** Cursor color */
  cursor: string;
  /** Cursor accent/text color */
  cursorAccent: string;
  /** Selection background (typically semi-transparent) */
  selectionBackground: string;

  // Standard ANSI colors (0-7)
  /** ANSI black (color 0) */
  black: string;
  /** ANSI red (color 1) */
  red: string;
  /** ANSI green (color 2) */
  green: string;
  /** ANSI yellow (color 3) */
  yellow: string;
  /** ANSI blue (color 4) */
  blue: string;
  /** ANSI magenta (color 5) */
  magenta: string;
  /** ANSI cyan (color 6) */
  cyan: string;
  /** ANSI white (color 7) */
  white: string;

  // Bright ANSI colors (8-15)
  /** ANSI bright black (color 8) */
  brightBlack: string;
  /** ANSI bright red (color 9) */
  brightRed: string;
  /** ANSI bright green (color 10) */
  brightGreen: string;
  /** ANSI bright yellow (color 11) */
  brightYellow: string;
  /** ANSI bright blue (color 12) */
  brightBlue: string;
  /** ANSI bright magenta (color 13) */
  brightMagenta: string;
  /** ANSI bright cyan (color 14) */
  brightCyan: string;
  /** ANSI bright white (color 15) */
  brightWhite: string;
}

/**
 * Complete theme color palette.
 */
export interface ThemeColors {
  // Core color scales
  /** Primary brand color (indigo in default theme) */
  primary: SemanticColorSet;
  /** Accent/secondary brand color (violet in default theme) */
  accent: SemanticColorSet;
  /** Surface/neutral colors (slate in default theme) */
  surface: ColorScale;

  // Semantic colors
  /** Success state colors (emerald in default theme) */
  success: SemanticColorSet;
  /** Warning state colors (amber in default theme) */
  warning: SemanticColorSet;
  /** Error/danger state colors (rose in default theme) */
  error: SemanticColorSet;
  /** Info state colors (cyan in default theme) */
  info: SemanticColorSet;

  // Functional colors
  /** Background colors */
  bg: BackgroundColors;
  /** Text colors */
  text: TextColors;
  /** Border colors */
  border: BorderColors;

  // Terminal
  /** Terminal/xterm color palette */
  terminal: TerminalColors;
}

/**
 * Complete theme definition.
 */
export interface Theme {
  /** Unique theme identifier */
  id: ThemeId;
  /** Display name */
  name: string;
  /** Theme description */
  description: string;
  /** Theme author (optional) */
  author?: string;
  /** Theme variant - dark or light */
  variant: 'dark' | 'light';
  /** Complete color palette */
  colors: ThemeColors;
}

/**
 * Supported theme identifiers.
 */
export type ThemeId =
  | 'goodvibes-classic'
  | 'catppuccin-latte'
  | 'catppuccin-frappe'
  | 'catppuccin-macchiato'
  | 'catppuccin-mocha'
  | 'dracula'
  | 'one-dark'
  | 'nord'
  | 'solarized-dark'
  | 'solarized-light'
  | 'tokyo-night'
  | 'gruvbox-dark';

/**
 * Array of all supported theme IDs for iteration and validation.
 */
export const THEME_IDS: ThemeId[] = [
  'goodvibes-classic',
  'catppuccin-latte',
  'catppuccin-frappe',
  'catppuccin-macchiato',
  'catppuccin-mocha',
  'dracula',
  'one-dark',
  'nord',
  'solarized-dark',
  'solarized-light',
  'tokyo-night',
  'gruvbox-dark',
];

/**
 * Theme metadata for display in theme picker.
 */
export interface ThemeMetadata {
  id: ThemeId;
  name: string;
  description: string;
  variant: 'dark' | 'light';
  author?: string;
}

/**
 * Type guard to check if a string is a valid ThemeId.
 */
export function isThemeId(value: string): value is ThemeId {
  return THEME_IDS.includes(value as ThemeId);
}

/**
 * Default theme ID for the application.
 */
export const DEFAULT_THEME_ID: ThemeId = 'goodvibes-classic';
