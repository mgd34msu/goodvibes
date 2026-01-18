// ============================================================================
// KEYBOARD SETTINGS SECTION
// ============================================================================

import { SettingsSection, ShortcutRow } from './components';

export function KeyboardSettings(): React.JSX.Element {
  return (
    <SettingsSection title="Keyboard Shortcuts">
      <div className="space-y-2">
        <ShortcutRow action="New Terminal" shortcut="Ctrl+N" />
        <ShortcutRow action="Close Tab" shortcut="Ctrl+W" />
        <ShortcutRow action="Next Tab" shortcut="Ctrl+Tab" />
        <ShortcutRow action="Previous Tab" shortcut="Ctrl+Shift+Tab" />
        <ShortcutRow action="Quick Switcher" shortcut="Ctrl+K" />
        <ShortcutRow action="Command Palette" shortcut="Ctrl+Shift+P" />
        <ShortcutRow action="Search Terminal" shortcut="Ctrl+F" />
        <ShortcutRow action="Zoom In" shortcut="Ctrl++" />
        <ShortcutRow action="Zoom Out" shortcut="Ctrl+-" />
        <ShortcutRow action="Reset Zoom" shortcut="Ctrl+0" />
      </div>
    </SettingsSection>
  );
}
