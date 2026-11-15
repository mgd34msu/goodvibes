import { describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/platform/platform/config';
import { ENUM_VALUE_DESCRIPTIONS } from '../../renderer/settings-modal-context.ts';
import { SETTING_LABELS } from '../../renderer/settings-modal-helpers.ts';

const schemaByKey = new Map(CONFIG_SCHEMA.map((setting) => [setting.key as string, setting]));

describe('settings modal documentation follows the config schema', () => {
  test('every per-value description names a value the setting accepts', () => {
    for (const [key, descriptions] of Object.entries(ENUM_VALUE_DESCRIPTIONS)) {
      const setting = schemaByKey.get(key);
      if (!setting?.enumValues) continue;
      for (const value of Object.keys(descriptions)) {
        expect({ key, value, accepted: setting.enumValues.includes(value) }).toEqual({ key, value, accepted: true });
      }
    }
  });
  test('the host mode settings describe their default value', () => {
    for (const key of ['controlPlane.hostMode', 'httpListener.hostMode', 'web.hostMode']) {
      expect(Object.keys(ENUM_VALUE_DESCRIPTIONS[key] ?? {})).toContain('local');
    }
  });
  test('every custom label belongs to a real setting', () => {
    const unknown = Object.keys(SETTING_LABELS).filter((key) => !schemaByKey.has(key));
    expect(unknown).toEqual([]);
  });
});
