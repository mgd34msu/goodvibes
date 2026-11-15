import { describe, expect, test } from 'bun:test';
import { CONFIG_KEYS } from '@goodvibes-jev/engine/platform/platform/config';
import { UI_SETTING_PRIORITY } from '../../input/settings-modal-data.ts';
import { SETTING_LABELS } from '../../renderer/settings-modal-helpers.ts';

describe('settings modal key names', () => {
  test('every ui priority key is a key in the config schema', () => {
    const unknown = Object.keys(UI_SETTING_PRIORITY).filter((key) => !CONFIG_KEYS.has(key));
    expect(unknown).toEqual([]);
  });

  test('every label key is a key in the config schema', () => {
    const unknown = Object.keys(SETTING_LABELS).filter((key) => !CONFIG_KEYS.has(key));
    expect(unknown).toEqual([]);
  });
});
