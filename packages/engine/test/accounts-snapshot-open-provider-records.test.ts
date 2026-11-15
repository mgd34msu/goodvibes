import { describe, expect, test } from 'bun:test';
import { AccountsSnapshotResponseSchema } from '../contracts/src/zod-schemas/accounts.js';

const provider = {
  providerId: 'anthropic',
  active: true,
  modelCount: 3,
  configured: true,
  oauthReady: false,
  pendingLogin: false,
  availableRoutes: ['api-key'],
  preferredRoute: 'api-key',
  activeRoute: 'api-key',
  activeRouteReason: 'configured',
  authFreshness: 'healthy',
  notes: [],
  usageWindows: [],
  issues: [],
  recommendedActions: [],
  routeRecords: [],
};

describe('accounts.snapshot response schema', () => {
  test('a provider record carrying a field the schema does not name is accepted, as the catalog declares', () => {
    const result = AccountsSnapshotResponseSchema.safeParse({
      capturedAt: 1,
      providers: [{ ...provider, addedByANewerDaemon: 'x' }],
      configuredCount: 1,
      issueCount: 0,
    });
    expect(result.success).toBe(true);
  });

  test('a provider record missing a required field is still refused', () => {
    const { providerId: _omitted, ...incomplete } = provider;
    const result = AccountsSnapshotResponseSchema.safeParse({
      capturedAt: 1,
      providers: [incomplete],
      configuredCount: 1,
      issueCount: 0,
    });
    expect(result.success).toBe(false);
  });
});
