import { expect, test } from 'bun:test';
import { screenSettingsForIngestion } from '../platform/src/platform/config/settings-ingestion.ts';

test('a retired saved permissions mode is reported once and still runs as safe-owner', () => {
  const result = screenSettingsForIngestion({ permissions: { mode: 'prompt' } }, '/tmp/settings.json');
  const notice = result.notices.find((entry) => entry.key === 'permissions.mode');
  expect(notice?.reason).toContain('now runs as safe-owner');
  expect((result.config.permissions as { mode: string }).mode).toBe('safe-owner');
});

test('a current permissions mode produces no notice', () => {
  const result = screenSettingsForIngestion({ permissions: { mode: 'plan' } }, '/tmp/settings.json');
  expect(result.notices.filter((entry) => entry.key === 'permissions.mode')).toEqual([]);
});
