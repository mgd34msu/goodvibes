import type { ConfigKey, ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { normalizeThemeName, setActiveThemeMode, setActiveThemeName } from './theme.js';
import type { ThemeMode, ThemeModeSetting } from './theme.js';
import { getTerminalPalette } from '../terminal-palette-store.js';
import { classifyBackgroundLuminance, parseColorSpec } from './terminal-bg-color.js';
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
 * Light or dark from the background colour the terminal reported at startup
 * (the startup probe reads it in every mode), or null when it never answered.
 */
function terminalBackgroundMode(): ThemeMode | null {
    const background = getTerminalPalette()?.background;
    const rgb = background === undefined ? null : parseColorSpec(background);
    return rgb === null ? null : classifyBackgroundLuminance(rgb);
}
/**
 * Apply a display.themeMode settings change now: forced dark/light flip the
 * active mode; auto classifies the background the terminal reported at
 * startup and applies that. Only when the terminal never answered does auto
 * wait for the next launch's probe; the returned message states which
 * happened. The caller passes its full-repaint hook. Called by the
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
    const detected = terminalBackgroundMode();
    if (detected !== null) {
        setActiveThemeMode(detected);
        requestFullRepaint?.();
        return { message: `Theme mode: auto (terminal is ${detected}, applied now)` };
    }
    return { message: 'Theme mode: auto (the terminal did not report its background; probes it on next startup)' };
}
/** Config key backing the color theme (bundled name or 'system'). */
export const THEME_NAME_CONFIG_KEY: ConfigKey = 'display.theme';
/**
 * Read the configured theme name, normalized: an unset or unknown value maps
 * to the default theme.
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
/** The message of the last theme change the subscription below applied, per key, until a writer takes it. */
const appliedThemeMessages = new Map<ConfigKey, string>();
/**
 * Keep the live theme in step with `display.theme` and `display.themeMode`,
 * whoever writes them (the settings screen, `/settings set`, a settings-sync
 * pull, a file edit): each change is applied through the functions above and
 * the product's full-repaint hook runs. Installed once where the product
 * applies its start-up theme; returns the unsubscribe.
 */
export function subscribeThemeSettings(
    configManager: Pick<ConfigManager, 'subscribe'>,
    requestFullRepaint: () => void,
): () => void {
    const offName = configManager.subscribe(THEME_NAME_CONFIG_KEY, (next) => {
        appliedThemeMessages.set(THEME_NAME_CONFIG_KEY, applyThemeNameSettingChange(next, requestFullRepaint).message);
    });
    const offMode = configManager.subscribe(THEME_MODE_CONFIG_KEY, (next) => {
        appliedThemeMessages.set(THEME_MODE_CONFIG_KEY, applyThemeModeSettingChange(next, requestFullRepaint).message);
    });
    return () => { offName(); offMode(); };
}
/**
 * What the theme subscription did for the last change of `key`, for a writer
 * that reports it; undefined when the key is not a theme key or nothing was
 * applied. Reading it clears it.
 */
export function takeAppliedThemeMessage(key: unknown): string | undefined {
    const themeKey = key === THEME_NAME_CONFIG_KEY ? THEME_NAME_CONFIG_KEY : key === THEME_MODE_CONFIG_KEY ? THEME_MODE_CONFIG_KEY : undefined;
    if (themeKey === undefined) return undefined;
    const message = appliedThemeMessages.get(themeKey);
    appliedThemeMessages.delete(themeKey);
    return message;
}
