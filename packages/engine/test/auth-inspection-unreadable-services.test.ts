import { describe, expect, test } from 'bun:test';
import { buildAuthInspectionSnapshot } from '../platform/src/platform/runtime/auth/inspection.ts';
import type { AuthInspectionDeps } from '../platform/src/platform/runtime/auth/inspection.ts';

const build = (reason: string | null) => buildAuthInspectionSnapshot({
  serviceRegistry: { get: () => null, getAll: () => ({}), unreadableReason: () => reason },
  subscriptionManager: { list: () => [], listPending: () => [], get: () => null, getPending: () => null },
  secretsManager: { list: async () => [] },
} as unknown as AuthInspectionDeps);

describe('auth inspection with an unusable services file', () => {
  test('names the reason instead of reading as no services', async () => {
    const snapshot = await build('/w/services.json is not valid JSON');
    expect(snapshot.servicesUnreadable).toBe('/w/services.json is not valid JSON');
  });

  test('a usable file adds nothing', async () => {
    expect((await build(null)).servicesUnreadable).toBeUndefined();
  });
});
