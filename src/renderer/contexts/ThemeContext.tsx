// ============================================================================
// THEME CONTEXT - React context for dynamic theming
// ============================================================================
//
// Provides theme state and management throughout the application.
// Integrates with settingsStore for persistence and themeInjector for CSS.
//
// ============================================================================

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';

import type { Theme, ThemeId, ThemeMetadata } from '../../shared/types/theme-types';
import { DEFAULT_THEME_ID } from '../../shared/types/theme-types';
import { useSettingsStore } from '../stores/settingsStore';
import { applyTheme } from '../utils/themeInjector';
import { createLogger } from '../../shared/logger';

const logger = createLogger('ThemeContext');

// Import all themes
import { goodvibesClassic } from '../themes/goodvibes-classic';
import { catppuccinLatte } from '../themes/catppuccin-latte';
import { catppuccinFrappe } from '../themes/catppuccin-frappe';
import { catppuccinMacchiato } from '../themes/catppuccin-macchiato';
import { catppuccinMocha } from '../themes/catppuccin-mocha';
import { draculaTheme } from '../themes/dracula';
import { oneDarkTheme } from '../themes/one-dark';
import { nord } from '../themes/nord';
import { solarizedDark } from '../themes/solarized-dark';
import { solarizedLight } from '../themes/solarized-light';
import { tokyoNightTheme } from '../themes/tokyo-night';
import { gruvboxDark } from '../themes/gruvbox-dark';

// ============================================================================
// THEME REGISTRY
// ============================================================================

/**
 * Map of all available themes indexed by their ID.
 */
const THEMES: Record<ThemeId, Theme> = {
  'goodvibes-classic': goodvibesClassic,
  'catppuccin-latte': catppuccinLatte,
  'catppuccin-frappe': catppuccinFrappe,
  'catppuccin-macchiato': catppuccinMacchiato,
  'catppuccin-mocha': catppuccinMocha,
  'dracula': draculaTheme,
  'one-dark': oneDarkTheme,
  'nord': nord,
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  'tokyo-night': tokyoNightTheme,
  'gruvbox-dark': gruvboxDark,
};

/**
 * Retrieves a theme by ID, falling back to the default theme if not found.
 */
function getThemeById(id: ThemeId): Theme {
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID];
}

/**
 * Extracts metadata from all available themes for UI display.
 */
function getAvailableThemesMetadata(): ThemeMetadata[] {
  return Object.values(THEMES).map((theme) => ({
    id: theme.id,
    name: theme.name,
    description: theme.description,
    variant: theme.variant,
    author: theme.author,
  }));
}

// ============================================================================
// CONTEXT DEFINITION
// ============================================================================

/**
 * Theme context value interface.
 */
interface ThemeContextValue {
  /** The current theme object with full color palette */
  theme: Theme;
  /** The current theme identifier */
  themeId: ThemeId;
  /** Function to change the current theme */
  setTheme: (id: ThemeId) => void;
  /** List of all available themes for UI selection */
  availableThemes: ThemeMetadata[];
}

/**
 * React context for theme management.
 * Provides access to current theme and theme switching functionality.
 */
const ThemeContext = createContext<ThemeContextValue | null>(null);

// ============================================================================
// PROVIDER COMPONENT
// ============================================================================

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * ThemeProvider component that manages theme state and CSS injection.
 *
 * Responsibilities:
 * - Reads initial theme from settingsStore
 * - Applies theme CSS on mount and when theme changes
 * - Persists theme changes to settings
 * - Provides theme context to children
 *
 * @example
 * ```tsx
 * // In main.tsx or App.tsx
 * <ThemeProvider>
 *   <App />
 * </ThemeProvider>
 * ```
 */
export function ThemeProvider({ children }: ThemeProviderProps): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const isLoaded = useSettingsStore((s) => s.isLoaded);

  // Initialize with default theme, will sync with settings once loaded
  const [currentThemeId, setCurrentThemeId] = useState<ThemeId>(() => {
    // Check if we're in a browser environment
    if (typeof window === 'undefined') {
      return DEFAULT_THEME_ID;
    }
    // Use settings value if available, otherwise default
    return settings.colorTheme ?? DEFAULT_THEME_ID;
  });

  // Sync theme with settings once settings are loaded
  useEffect(() => {
    if (isLoaded && settings.colorTheme && settings.colorTheme !== currentThemeId) {
      setCurrentThemeId(settings.colorTheme);
    }
  }, [isLoaded, settings.colorTheme, currentThemeId]);

  // Get the current theme object
  const theme = useMemo(() => getThemeById(currentThemeId), [currentThemeId]);

  // Apply theme CSS whenever theme changes
  useEffect(() => {
    // Only apply in browser environment
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    applyTheme(theme);
  }, [theme]);

  // Apply theme immediately on mount to prevent flash
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    // Apply the initial theme synchronously
    const initialTheme = getThemeById(settings.colorTheme ?? DEFAULT_THEME_ID);
    applyTheme(initialTheme);
  }, []);

  // Memoized list of available themes
  const availableThemes = useMemo(() => getAvailableThemesMetadata(), []);

  /**
   * Changes the current theme and persists to settings.
   */
  const setTheme = useCallback(
    (id: ThemeId) => {
      // Update local state immediately for responsiveness
      setCurrentThemeId(id);

      // Persist to settings store (async, but we don't need to wait)
      updateSetting('colorTheme', id).catch((error) => {
        // Log error but don't revert - the theme is already applied visually
        logger.error('Failed to persist theme setting:', error);
      });
    },
    [updateSetting]
  );

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themeId: currentThemeId,
      setTheme,
      availableThemes,
    }),
    [theme, currentThemeId, setTheme, availableThemes]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Hook to access the full theme context.
 *
 * @returns The complete theme context value
 * @throws Error if used outside of ThemeProvider
 *
 * @example
 * ```tsx
 * function ThemeSelector() {
 *   const { theme, setTheme, availableThemes } = useTheme();
 *
 *   return (
 *     <select
 *       value={theme.id}
 *       onChange={(e) => setTheme(e.target.value as ThemeId)}
 *     >
 *       {availableThemes.map((t) => (
 *         <option key={t.id} value={t.id}>
 *           {t.name}
 *         </option>
 *       ))}
 *     </select>
 *   );
 * }
 * ```
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  if (context === null) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
}

/**
 * Hook to access only the current theme ID.
 * Useful when you only need the theme identifier without the full context.
 *
 * @returns The current theme ID
 * @throws Error if used outside of ThemeProvider
 *
 * @example
 * ```tsx
 * function ThemeBadge() {
 *   const themeId = useThemeId();
 *   return <span>Current: {themeId}</span>;
 * }
 * ```
 */
export function useThemeId(): ThemeId {
  const context = useContext(ThemeContext);

  if (context === null) {
    throw new Error('useThemeId must be used within a ThemeProvider');
  }

  return context.themeId;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { ThemeContext, THEMES, getThemeById, getAvailableThemesMetadata };
export type { ThemeContextValue, ThemeProviderProps };
