import { openThemePicker as open, type ThemePickerContext } from '@goodvibes-jev/engine/terminal-shell/theme-settings-actions';
export * from '@goodvibes-jev/engine/terminal-shell/theme-settings-actions';
export const openThemePicker = (context: ThemePickerContext) => open(context, { clearScreen: true, primaryVerbLabel: false });
