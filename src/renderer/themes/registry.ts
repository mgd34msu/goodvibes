// ============================================================================
// THEME REGISTRY
// ============================================================================
//
// Central registry mapping ThemeId to Theme objects. Provides utilities for
// retrieving themes by ID and getting all available themes.
//
// ============================================================================

import type { Theme, ThemeId, ThemeMetadata } from '../../shared/types/theme-types';

import { goodvibesClassic } from './goodvibes-classic';
import { catppuccinLatte } from './catppuccin-latte';
import { catppuccinFrappe } from './catppuccin-frappe';
import { catppuccinMacchiato } from './catppuccin-macchiato';
import { catppuccinMocha } from './catppuccin-mocha';
import { draculaTheme } from './dracula';
import { oneDarkTheme } from './one-dark';
import { nord } from './nord';
import { solarizedDark } from './solarized-dark';
import { solarizedLight } from './solarized-light';
import { tokyoNightTheme } from './tokyo-night';
import { gruvboxDark } from './gruvbox-dark';

/**
 * Registry of all available themes, keyed by ThemeId
 */
export const themeRegistry: Record<ThemeId, Theme> = {
  'goodvibes-classic': goodvibesClassic,
  'catppuccin-latte': catppuccinLatte,
  'catppuccin-frappe': catppuccinFrappe,
  'catppuccin-macchiato': catppuccinMacchiato,
  'catppuccin-mocha': catppuccinMocha,
  dracula: draculaTheme,
  'one-dark': oneDarkTheme,
  nord: nord,
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  'tokyo-night': tokyoNightTheme,
  'gruvbox-dark': gruvboxDark,
};

/**
 * Get a theme by its ID
 *
 * @param id - The theme ID to look up
 * @returns The theme object, or undefined if not found
 */
export function getThemeById(id: ThemeId): Theme | undefined {
  return themeRegistry[id];
}

/**
 * Get all available themes as an array
 *
 * @returns Array of all theme objects
 */
export function getAllThemes(): Theme[] {
  return Object.values(themeRegistry);
}

/**
 * Get metadata for all available themes
 *
 * @returns Array of theme metadata objects (id, name, description, variant, author)
 */
export function getThemeMetadata(): ThemeMetadata[] {
  return getAllThemes().map((theme) => ({
    id: theme.id,
    name: theme.name,
    description: theme.description,
    variant: theme.variant,
    author: theme.author,
  }));
}

/**
 * Get themes grouped by variant (dark/light)
 *
 * @returns Object with 'dark' and 'light' arrays of themes
 */
export function getThemesByVariant(): { dark: Theme[]; light: Theme[] } {
  const themes = getAllThemes();
  return {
    dark: themes.filter((t) => t.variant === 'dark'),
    light: themes.filter((t) => t.variant === 'light'),
  };
}

export default themeRegistry;
