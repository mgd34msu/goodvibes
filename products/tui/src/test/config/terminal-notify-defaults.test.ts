import { expect, test } from 'bun:test';
import { TERMINAL_BELL_KEY, TERMINAL_NOTIFY_SIGNALS } from '../../core/terminal-notifier.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { buildTerminalNotifySyntheticEntries } from '../../input/settings-modal-data.ts';

test('the notifier and the settings modal agree on every terminal-notification key and default', () => {
  const rows = new Map(buildTerminalNotifySyntheticEntries({ get: configGetStub() }).map((row) => [String(row.setting.key), row.setting.default]));
  for (const spec of Object.values(TERMINAL_NOTIFY_SIGNALS)) {
    expect(rows.has(spec.configKey)).toBe(true);
    expect(rows.get(spec.configKey)).toBe(spec.defaultOn);
  }
  expect(rows.get(TERMINAL_BELL_KEY)).toBe(false);
});

test('the registered host setting for every terminal-notification signal carries the notifier default', () => {
  const root = makeProjectTempDir('terminal-notify-defaults');
  const config = new TuiConfigManager({ homeDir: root, workingDir: root, configDir: root, surfaceRoot: 'tui' });
  const registered = new Map(config.getHostSettingsSchema().map((row) => [String(row.key), row.default]));
  for (const spec of Object.values(TERMINAL_NOTIFY_SIGNALS)) {
    if (registered.has(spec.configKey)) expect(registered.get(spec.configKey)).toBe(spec.defaultOn);
  }
  expect(registered.get(TERMINAL_NOTIFY_SIGNALS['turn-end'].configKey)).toBe(TERMINAL_NOTIFY_SIGNALS['turn-end'].defaultOn);
});
