import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listHookPointContracts } from '@goodvibes-jev/engine/sdk/platform/hooks';

test('native Herdr coverage accounts for every registered hook contract', () => {
  const reference = readFileSync(resolve(import.meta.dir, '../../../../../docs/design/herdr-native-integration.md'), 'utf8');
  for (const contract of listHookPointContracts()) expect(reference).toContain(`\`${contract.pattern}\``);
});
