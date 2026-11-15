import { describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/platform/platform/config';
import { ENUM_VALUE_DESCRIPTIONS } from '../../renderer/settings-modal-context.ts';

describe('settings enum descriptions cover the config registry', () => {
  test('every registry value of a described enum setting has a description', () => {
    const missing: string[] = [];
    for (const [key, descriptions] of Object.entries(ENUM_VALUE_DESCRIPTIONS)) {
      const setting = CONFIG_SCHEMA.find((entry) => entry.key === key);
      for (const value of setting?.enumValues ?? []) if (!descriptions[value]) missing.push(`${key}=${value}`);
    }
    expect(missing).toEqual([]);
  });
});
