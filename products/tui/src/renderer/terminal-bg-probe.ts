import { installBackgroundThemeProbe as install, type InstallThemeProbeOptions as PlatformOptions } from '@goodvibes-jev/engine/terminal-shell/terminal-bg-probe';
import { refreshForTerminalPalette, setActiveThemeMode, setActiveThemeName } from './theme.ts';
import { resolveConfiguredThemeName } from './theme-mode-config.ts';
export * from '@goodvibes-jev/engine/terminal-shell/terminal-bg-probe';
export type InstallThemeProbeOptions = Omit<PlatformOptions, 'applyThemeMode' | 'onTerminalPalette'>;
export function installBackgroundThemeProbe(options: InstallThemeProbeOptions) {
  setActiveThemeName(resolveConfiguredThemeName(options.configManager));
  return install({ ...options, applyThemeMode: setActiveThemeMode, onTerminalPalette: refreshForTerminalPalette });
}
