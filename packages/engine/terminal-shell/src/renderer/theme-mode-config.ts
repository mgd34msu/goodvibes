import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { normalizeThemeName, setActiveThemeMode, setActiveThemeName } from './theme.js';
import type { ThemeModeSetting } from './theme.js';
export const THEME_MODE_CONFIG_KEY: ConfigKey = 'display.themeMode';
export function coerceThemeModeSetting(raw: unknown): ThemeModeSetting {
    return raw === 'auto' || raw === 'dark' || raw === 'light' ? raw : 'auto';
}
export function resolveConfiguredThemeMode(configManager: Pick<ConfigManager, 'get'>): ThemeModeSetting {
    try {
        return coerceThemeModeSetting(configManager.get(THEME_MODE_CONFIG_KEY));
    }
    catch {
        return 'auto';
    }
}
/**
 * Apply a display.themeMode settings change with the honest timing contract:
 * forced dark/light flip the active mode NOW (caller passes its full-repaint
 * hook); auto is only evaluated by the startup probe, so it takes effect on the
 * next launch, the returned message states which happened. Called by the
 * settings-modal onSettingApplied hook (ui-openers).
 */
export function applyThemeModeSettingChange(value: unknown, requestFullRepaint?: (() => void) | undefined): {
    message: string;
} {
    const next = coerceThemeModeSetting(value);
    if (next === 'dark' || next === 'light') {
        setActiveThemeMode(next);
        requestFullRepaint?.();
        return { message: `Theme mode: ${next} (applied now)` };
    }
    return { message: 'Theme mode: auto (probes terminal on next startup)' };
}
/** Config key backing the color theme (bundled name, 'system', or legacy 'vaporwave'). */
export const THEME_NAME_CONFIG_KEY: ConfigKey = 'display.theme';
/**
 * Read the configured theme name, normalized: 'vaporwave' maps to
 * 'goodvibes-neon' and an unset or unknown value maps to the default theme.
 */
export function resolveConfiguredThemeName(configManager: Pick<ConfigManager, 'get'>): string {
    try {
        return normalizeThemeName(configManager.get(THEME_NAME_CONFIG_KEY));
    }
    catch {
        return normalizeThemeName(undefined);
    }
}
/**
 * Apply a display.theme settings change: the theme switches now (every
 * registered palette rebuilds) and the caller's full-repaint hook runs. Called
 * by the settings-modal onSettingApplied hook (ui-openers) and the Agent
 * workspace settings surface.
 */
export function applyThemeNameSettingChange(value: unknown, requestFullRepaint?: (() => void) | undefined): {
    message: string;
} {
    const applied = setActiveThemeName(value);
    requestFullRepaint?.();
    return { message: `Theme: ${applied} (applied now)` };
}
