import { describe, expect, test } from 'bun:test';
import { CHANNEL_REQUIRED_SCOPE, clientMaySeeScopedChannel } from '../platform/src/platform/control-plane/gateway-scope-enforcement.js';

describe('remote runtime events and read scopes', () => {
  const remoteEvents = [
    'remote-pair-requested', 'remote-pair-approved', 'remote-pair-rejected', 'remote-pair-verified',
    'remote-peer', 'remote-peer-heartbeat', 'remote-peer-disconnected',
    'remote-token-rotated', 'remote-token-revoked',
    'remote-work-queued', 'remote-work-claimed', 'remote-work-settled', 'remote-work-cancelled',
  ];

  test('a token without read:remote does not receive a remote event, one with it does', () => {
    for (const event of remoteEvents) {
      const scope = CHANNEL_REQUIRED_SCOPE[event];
      expect(scope).toBe('read:remote');
      expect(clientMaySeeScopedChannel({ kind: 'web', scopes: ['read:sessions'] }, scope!)).toBe(false);
      expect(clientMaySeeScopedChannel({ kind: 'web', scopes: ['read:remote'] }, scope!)).toBe(true);
    }
  });
});
