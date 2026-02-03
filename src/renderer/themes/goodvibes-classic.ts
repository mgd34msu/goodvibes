// ============================================================================
// GOODVIBES CLASSIC THEME
// ============================================================================
//
// The default dark theme for Clausitron. Features a bold, modern palette with
// indigo as the primary color and violet as the accent. This theme uses neutral
// slate tones for surfaces with subtle color tints for depth.
//
// ============================================================================

import type { Theme } from '../../shared/types/theme-types';

/**
 * Goodvibes Classic - The default dark theme
 *
 * Color Palette:
 * - Primary: Indigo (interactive elements, focus states)
 * - Accent: Violet (secondary emphasis, subagents, special states)
 * - Surface: Slate (neutral backgrounds and chrome)
 * - Semantic: Emerald (success), Amber (warning), Rose (error), Cyan (info)
 */
export const goodvibesClassic: Theme = {
  id: 'goodvibes-classic',
  name: 'Goodvibes Classic',
  description: 'The default dark theme with a bold, modern indigo and violet palette',
  author: 'Goodvibes',
  variant: 'dark',
  colors: {
    // ========================================
    // PRIMARY COLORS (Indigo)
    // Main interactive color - buttons, links, focus states
    // ========================================
    primary: {
      50: '#eef2ff',
      100: '#e0e7ff',
      200: '#c7d2fe',
      300: '#a5b4fc',
      400: '#818cf8',
      500: '#6366f1',
      600: '#4f46e5',
      700: '#4338ca',
      800: '#3730a3',
      900: '#312e81',
      950: '#1e1b4b',
      glow: {
        default: 'rgba(99, 102, 241, 0.5)',
        strong: 'rgba(99, 102, 241, 0.7)',
        subtle: 'rgba(99, 102, 241, 0.25)',
        muted: 'rgba(99, 102, 241, 0.15)',
        faint: 'rgba(99, 102, 241, 0.08)',
      },
      gradient: {
        start: '#4f46e5',
        mid: '#6366f1',
        end: '#818cf8',
      },
    },

    // ========================================
    // ACCENT COLORS (Violet)
    // Secondary emphasis - badges, subagents, special states
    // ========================================
    accent: {
      50: '#f5f3ff',
      100: '#ede9fe',
      200: '#ddd6fe',
      300: '#c4b5fd',
      400: '#a78bfa',
      500: '#8b5cf6',
      600: '#7c3aed',
      700: '#6d28d9',
      800: '#5b21b6',
      900: '#4c1d95',
      950: '#2e1065',
      glow: {
        default: 'rgba(139, 92, 246, 0.5)',
        strong: 'rgba(139, 92, 246, 0.7)',
        subtle: 'rgba(139, 92, 246, 0.25)',
        muted: 'rgba(139, 92, 246, 0.15)',
        faint: 'rgba(139, 92, 246, 0.08)',
      },
      gradient: {
        start: '#7c3aed',
        mid: '#8b5cf6',
        end: '#a78bfa',
      },
    },

    // ========================================
    // SURFACE COLORS (Neutral Slate)
    // UI chrome, backgrounds, cards
    // ========================================
    surface: {
      50: '#f8fafc',
      100: '#f1f5f9',
      200: '#e2e8f0',
      300: '#cbd5e1',
      400: '#94a3b8',
      500: '#64748b',
      600: '#475569',
      700: '#334155',
      800: '#1e293b',
      900: '#0f172a',
      950: '#020617',
    },

    // ========================================
    // SEMANTIC COLORS - Success (Emerald)
    // ========================================
    success: {
      50: '#ecfdf5',
      100: '#d1fae5',
      200: '#a7f3d0',
      300: '#6ee7b7',
      400: '#34d399',
      500: '#10b981',
      600: '#059669',
      700: '#047857',
      800: '#065f46',
      900: '#064e3b',
      950: '#022c22',
      glow: {
        default: 'rgba(16, 185, 129, 0.5)',
        strong: 'rgba(16, 185, 129, 0.7)',
        subtle: 'rgba(16, 185, 129, 0.25)',
        muted: 'rgba(16, 185, 129, 0.15)',
        faint: 'rgba(16, 185, 129, 0.08)',
      },
      gradient: {
        start: '#059669',
        mid: '#10b981',
        end: '#34d399',
      },
    },

    // ========================================
    // SEMANTIC COLORS - Warning (Amber)
    // ========================================
    warning: {
      50: '#fffbeb',
      100: '#fef3c7',
      200: '#fde68a',
      300: '#fcd34d',
      400: '#fbbf24',
      500: '#f59e0b',
      600: '#d97706',
      700: '#b45309',
      800: '#92400e',
      900: '#78350f',
      950: '#451a03',
      glow: {
        default: 'rgba(245, 158, 11, 0.5)',
        strong: 'rgba(245, 158, 11, 0.7)',
        subtle: 'rgba(245, 158, 11, 0.25)',
        muted: 'rgba(245, 158, 11, 0.15)',
        faint: 'rgba(245, 158, 11, 0.08)',
      },
      gradient: {
        start: '#d97706',
        mid: '#f59e0b',
        end: '#fbbf24',
      },
    },

    // ========================================
    // SEMANTIC COLORS - Error (Rose)
    // ========================================
    error: {
      50: '#fff1f2',
      100: '#ffe4e6',
      200: '#fecdd3',
      300: '#fda4af',
      400: '#fb7185',
      500: '#f43f5e',
      600: '#e11d48',
      700: '#be123c',
      800: '#9f1239',
      900: '#881337',
      950: '#4c0519',
      glow: {
        default: 'rgba(244, 63, 94, 0.5)',
        strong: 'rgba(244, 63, 94, 0.7)',
        subtle: 'rgba(244, 63, 94, 0.25)',
        muted: 'rgba(244, 63, 94, 0.15)',
        faint: 'rgba(244, 63, 94, 0.08)',
      },
      gradient: {
        start: '#e11d48',
        mid: '#f43f5e',
        end: '#fb7185',
      },
    },

    // ========================================
    // SEMANTIC COLORS - Info (Cyan)
    // ========================================
    info: {
      50: '#ecfeff',
      100: '#cffafe',
      200: '#a5f3fc',
      300: '#67e8f9',
      400: '#22d3ee',
      500: '#06b6d4',
      600: '#0891b2',
      700: '#0e7490',
      800: '#155e75',
      900: '#164e63',
      950: '#083344',
      glow: {
        default: 'rgba(6, 182, 212, 0.5)',
        strong: 'rgba(6, 182, 212, 0.7)',
        subtle: 'rgba(6, 182, 212, 0.25)',
        muted: 'rgba(6, 182, 212, 0.15)',
        faint: 'rgba(6, 182, 212, 0.08)',
      },
      gradient: {
        start: '#0891b2',
        mid: '#06b6d4',
        end: '#22d3ee',
      },
    },

    // ========================================
    // FUNCTIONAL COLORS - Background
    // ========================================
    bg: {
      primary: '#0a0a0f',
      secondary: '#111118',
      tertiary: '#18181f',
      hover: '#222230',
      elevated: '#1c1c24',
      active: '#2a2a38',
    },

    // ========================================
    // FUNCTIONAL COLORS - Text
    // ========================================
    text: {
      primary: '#f1f5f9',
      secondary: '#94a3b8',
      muted: '#64748b',
      disabled: '#4a4a58',
    },

    // ========================================
    // FUNCTIONAL COLORS - Border
    // ========================================
    border: {
      default: '#27272f',
      light: '#3a3a45',
      hover: '#4a4a58',
      focus: '#6366f1',
    },

    // ========================================
    // TERMINAL COLORS
    // Standard ANSI color palette for xterm
    // ========================================
    terminal: {
      background: '#020617', // Matches surface.950 for seamless integration
      foreground: '#f4f4f5',
      cursor: '#6366f1',
      cursorAccent: '#020617',
      selectionBackground: 'rgba(99, 102, 241, 0.3)',
      black: '#1e1e2e',
      red: '#f43f5e',
      green: '#10b981',
      yellow: '#f59e0b',
      blue: '#6366f1',
      magenta: '#8b5cf6',
      cyan: '#06b6d4',
      white: '#f1f5f9',
      brightBlack: '#64748b',
      brightRed: '#fb7185',
      brightGreen: '#34d399',
      brightYellow: '#fbbf24',
      brightBlue: '#818cf8',
      brightMagenta: '#a78bfa',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff',
    },
  },
};

export default goodvibesClassic;
