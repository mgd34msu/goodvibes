import { expect, test } from 'bun:test';
import { RETRYABLE_STATUS_CODES, type EngineErrorKind } from '@goodvibes/engine/errors';
import { DEFAULT_HTTP_RETRY_POLICY } from '@goodvibes/engine/transport-http/retry';

test('engine error kinds and retryable HTTP status codes stay in sync across errors and transport-http', () => {
  const kinds: readonly EngineErrorKind[] = [
    'auth', 'config', 'contract', 'network', 'not-found', 'protocol', 'rate-limit', 'service', 'internal', 'tool', 'validation', 'unknown',
  ];
  expect(kinds.length).toBe(12);
  expect([...DEFAULT_HTTP_RETRY_POLICY.retryOnStatuses].sort((a, b) => a - b)).toEqual([...RETRYABLE_STATUS_CODES].sort((a, b) => a - b));
});
