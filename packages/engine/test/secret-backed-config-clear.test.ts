import { describe, expect, test } from 'bun:test';
import { persistSecretBackedConfigValue } from '../platform/src/platform/config/secret-backed-config.js';

describe('clearing a secret-backed config value', () => {
  const clearKey = 'surfaces.slack.botToken' as never;

  test('a failing config write leaves the stored secret in place', async () => {
    const deleted: string[] = [];
    await expect(
      persistSecretBackedConfigValue(
        { get: () => undefined, setDynamic: () => { throw new Error('config write refused'); } },
        { set: async () => {}, delete: async (key) => { deleted.push(key); } },
        clearKey,
        '',
        { scope: 'user' },
      ),
    ).rejects.toThrow('config write refused');
    expect(deleted).toEqual([]);
  });

  test('a failed delete after the reference was cleared is reported without echoing the store error', async () => {
    const written: unknown[] = [];
    const result = persistSecretBackedConfigValue(
      { get: () => undefined, setDynamic: (_key, value) => { written.push(value); } },
      { set: async () => {}, delete: async () => { throw new Error('vault said sk-secret-123'); } },
      clearKey,
      '',
      { scope: 'user' },
    );
    await expect(result).rejects.toThrow('could not be removed');
    await expect(result).rejects.not.toThrow('sk-secret-123');
    expect(written).toEqual(['']);
  });
});
