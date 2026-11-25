/**
 * settings-screen/, the one settings screen both terminal programs show
 * (screen.ts), its rows (rows.ts), its help (help.ts) and its keys (keys.ts).
 * A program opens it through `wirePlaces` (places/index.ts `openSettings`),
 * giving what it keeps itself (`SettingsScreenProgram`).
 */
export { SettingsScreen, type ScreenList, type SettingsScreenOptions, type SettingsScreenProgram } from './screen.js';
export { settingsKeyContext, SETTINGS_KEY_CONTEXT_ID, SETTINGS_KEYS } from './keys.js';
export { buildScreenGroups, buildSettingGroups, type ScreenEntry, type ScreenProgram } from './rows.js';
