import { expect, test } from 'bun:test';
import { PAYMENTS_SYNTHETIC_CONFIG_KEYS } from '@goodvibes-jev/engine/platform/platform/config';
import { isDeclaredCardMaterialKey } from './card-material';

test('every synthetic payments key the engine declares is excluded structurally', () => {
  for (const key of PAYMENTS_SYNTHETIC_CONFIG_KEYS) expect(isDeclaredCardMaterialKey(key)).toBe(true);
});
