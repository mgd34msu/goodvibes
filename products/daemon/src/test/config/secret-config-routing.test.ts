import { expect, test } from 'bun:test';
import { isDeclaredSecretBearingConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { SECRET_CONFIG_KEYS } from '../../config/secret-config.ts';

// `config set` routes a literal credential to the secret store only for these keys, so a name here that the
// platform does not declare as credential material would be routed on a guess.
test('every secret-store-routed key is declared secret-bearing by the platform, except the local payment fields', () => {
  const undeclared = [...SECRET_CONFIG_KEYS].filter((key) => !key.startsWith('payments.') && !isDeclaredSecretBearingConfigKey(key));
  expect(undeclared).toEqual([]);
});
