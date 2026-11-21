import { installBackgroundThemeProbe as install, type InstallThemeProbeOptions as PlatformOptions } from '@goodvibes/engine/terminal-shell/terminal-bg-probe';
import { refreshForTerminalPalette, setActiveThemeMode, setActiveThemeName } from './theme.ts';
import { resolveConfiguredThemeName, subscribeThemeSettings } from './theme-mode-config.ts';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
export * from '@goodvibes/engine/terminal-shell/terminal-bg-probe';
export type InstallThemeProbeOptions = Omit<PlatformOptions, 'applyThemeMode' | 'onTerminalPalette' | 'configManager'> & {
  readonly configManager: Pick<ConfigManager, 'get' | 'subscribe'>;
};
/**
 * The configured theme before the first paint, the terminal probe, and a
 * subscription that applies every later `display.theme` / `display.themeMode`
 * change live, whoever writes it.
 */
export function installBackgroundThemeProbe(options: InstallThemeProbeOptions) {
  setActiveThemeName(resolveConfiguredThemeName(options.configManager));
  subscribeThemeSettings(options.configManager, options.requestRepaint);
  return install({ ...options, applyThemeMode: setActiveThemeMode, onTerminalPalette: refreshForTerminalPalette });
}
