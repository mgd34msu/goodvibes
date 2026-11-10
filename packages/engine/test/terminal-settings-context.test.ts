import { expect, test } from 'bun:test';
import { CONFIG_SCHEMA, type ConfigSetting } from '../platform/src/platform/config/index.ts';
import { createSettingContext } from '../terminal-shell/src/renderer/settings-context.ts';

type Entry = { setting: ConfigSetting; currentValue: unknown };
const modal = { editingMode: false, editBuffer: '' };
function setting(key: string): ConfigSetting {
  const row = CONFIG_SCHEMA.find(candidate => candidate.key === key);
  if (!row) throw new Error('Expected canonical setting metadata');
  return row;
}
function context(detail: string[], editing?: string) {
  return createSettingContext<typeof modal, Entry>({
    isSecretKey: () => false, cursor: '|', formatValue: entry => String(entry.currentValue),
    label: entry => entry.setting.key, source: () => 'default', detail: () => detail,
    enumDescriptions: {}, routingKeys: [], describeUiRouting: value => value,
    ...(editing ? { customEditing: () => editing } : {}),
  });
}

test('shared scalar context owns the canonical description once and preserves product warning priority', () => {
  const entry = { setting: setting('display.collapseThreshold'), currentValue: 24 };
  const warning = 'Locked: This original setting is controlled by the host.';
  const lines = context([warning]).buildSettingContext(modal, entry);
  expect(entry.setting.description).toBe('Line count threshold for collapsing tool output');
  expect(lines.filter(line => line === entry.setting.description)).toHaveLength(1);
  expect(lines.indexOf(entry.setting.description)).toBeGreaterThan(lines.indexOf('Source: default'));
  expect(lines.indexOf(warning)).toBeGreaterThan(lines.indexOf('Source: default'));
  expect(lines.indexOf(entry.setting.description)).toBeGreaterThan(lines.indexOf(warning));
  expect(lines).toContain('Editing: Enter opens inline edit, then type the value and press Enter to save. Arrow keys only navigate.');
});

test('shared descriptions retain product custom details and replace generic editing with the supplied editor instructions', () => {
  const entry = { setting: setting('display.theme'), currentValue: 'goodvibes' };
  const detail = 'Current preview remains owned by the original settings dialog.';
  const editing = 'Editing: Enter opens the actual theme picker; Escape restores its prior preview.';
  const lines = context([detail], editing).buildSettingContext(modal, entry);
  expect(lines.filter(line => line === entry.setting.description)).toHaveLength(1);
  expect(lines).toContain(detail); expect(lines).toContain(editing);
  expect(lines.some(line => line.startsWith('Editing: Enter opens inline edit.'))).toBe(false);
});
