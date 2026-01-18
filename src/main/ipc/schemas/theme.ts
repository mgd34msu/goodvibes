// ============================================================================
// THEME SCHEMAS - Zod validation for theme IPC operations
// ============================================================================
//
// This module provides Zod schemas for validating theme-related IPC inputs.
// Theme operations include getting, setting, and listing themes.
//
// ============================================================================

import { z } from 'zod';

// ============================================================================
// THEME ID SCHEMA
// ============================================================================

/**
 * List of valid theme IDs - must match THEME_IDS from theme-types.ts
 */
export const VALID_THEME_IDS = [
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
] as const;

/**
 * Schema for validating theme IDs
 */
export const themeIdSchema = z.enum(VALID_THEME_IDS, {
  errorMap: () => ({
    message: `Invalid theme ID. Must be one of: ${VALID_THEME_IDS.join(', ')}`,
  }),
});

// ============================================================================
// THEME VARIANT SCHEMA
// ============================================================================

/**
 * Schema for theme variant (dark or light mode)
 */
export const themeVariantSchema = z.enum(['dark', 'light'], {
  errorMap: () => ({ message: 'Theme variant must be "dark" or "light"' }),
});

// ============================================================================
// COLOR SCHEMAS
// ============================================================================

/**
 * Schema for hex color values (6 digits with #)
 */
export const hexColorSchema = z.string().regex(
  /^#[0-9a-fA-F]{6}$/,
  'Must be a valid hex color (e.g., #ff0000)'
);

/**
 * Schema for rgba color values
 */
export const rgbaColorSchema = z.string().regex(
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+))?\s*\)$/,
  'Must be a valid rgb/rgba color (e.g., rgba(255, 0, 0, 0.5))'
);

/**
 * Schema for any valid CSS color (hex or rgba)
 */
export const cssColorSchema = z.union([hexColorSchema, rgbaColorSchema]);

// ============================================================================
// THEME OPERATION SCHEMAS
// ============================================================================

/**
 * Schema for setting colorTheme
 */
export const setColorThemeInputSchema = z.object({
  key: z.literal('colorTheme'),
  value: themeIdSchema,
});

/**
 * Schema for setting theme (dark/light mode)
 */
export const setThemeModeInputSchema = z.object({
  key: z.literal('theme'),
  value: themeVariantSchema,
});

/**
 * Schema for getting the current theme
 */
export const getThemeInputSchema = z.literal('colorTheme');

/**
 * Schema for getting theme mode (dark/light)
 */
export const getThemeModeInputSchema = z.literal('theme');

// ============================================================================
// COMBINED THEME SETTING SCHEMA
// ============================================================================

/**
 * Union schema for all theme-related setting operations
 */
export const themeSettingSchema = z.union([
  setColorThemeInputSchema,
  setThemeModeInputSchema,
]);

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type ThemeId = z.infer<typeof themeIdSchema>;
export type ThemeVariant = z.infer<typeof themeVariantSchema>;
export type SetColorThemeInput = z.infer<typeof setColorThemeInputSchema>;
export type SetThemeModeInput = z.infer<typeof setThemeModeInputSchema>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Checks if a setting key is theme-related
 */
export function isThemeSettingKey(key: string): key is 'colorTheme' | 'theme' {
  return key === 'colorTheme' || key === 'theme';
}

/**
 * Validates a theme setting value based on the key
 * @returns An object with success status and either data or error message
 */
export function validateThemeSettingValue(
  key: string,
  value: unknown
): { success: true; data: unknown } | { success: false; error: string } {
  if (key === 'colorTheme') {
    const result = themeIdSchema.safeParse(value);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: result.error.issues.map(i => i.message).join('; '),
    };
  }

  if (key === 'theme') {
    const result = themeVariantSchema.safeParse(value);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: result.error.issues.map(i => i.message).join('; '),
    };
  }

  // Not a theme-related setting, skip validation
  return { success: true, data: value };
}
