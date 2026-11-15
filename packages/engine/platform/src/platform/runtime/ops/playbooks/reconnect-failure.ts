/**
 * Playbook: Reconnect Failure
 *
 * Diagnoses and resolves persistent transport/connection failures.
 * Covers MCP server disconnects, WebSocket drops, and HTTP transport errors.
 */
import type { Playbook, DiagnosticCheckResult } from '../types.js';
import { safeCheck } from '../safe-check.js';

/** Reconnect failure resolution playbook. */
export const reconnectFailurePlaybook: Playbook = {
  id: 'reconnect-failure',
  name: 'Reconnect Failure',
  description:
    'Diagnoses persistent transport or connection failures. ' +
    'Covers MCP server disconnects, WebSocket drops, and HTTP transport errors.',
  symptoms: [
    'Transport span shows repeated CONNECT → DISCONNECT cycles',
    'MCP server reports connection refused or timeout',
    'RuntimeEventBus emitting transport.error at high frequency',
    'Tool calls failing with "connection not available" errors',
    'Health check reports transport as DEGRADED or CRITICAL',
  ],
  checks: [
    {
      id: 'transport.endpoint-reachable',
      label: 'Endpoint reachable',
      description: 'Checks whether the transport endpoint responds to a health ping.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          evaluated: false,
          summary:
            'Endpoint reachability requires a live network context. ' +
            'Check connectivity manually.',
          severity: 'info',
          context: { hint: 'Run: curl -sf <endpoint>/health' },
        })),
    },
    {
      id: 'transport.retry-budget',
      label: 'Retry budget remaining',
      description: 'Checks whether the transport retry budget has been exhausted.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          evaluated: false,
          summary: 'Retry budget state requires live transport context.',
          severity: 'info',
          context: { hint: 'Inspect TransportManager.retryState()' },
        })),
    },
    {
      id: 'transport.auth-valid',
      label: 'Authentication credentials valid',
      description: 'Checks whether transport credentials (API keys, tokens) are valid and not expired.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          evaluated: false,
          summary: 'Credential validation requires live auth context.',
          severity: 'info',
          context: { hint: 'Check token expiry in AuthManager.status()' },
        })),
    },
  ],
  steps: [
    {
      step: 1,
      title: 'Verify endpoint reachability',
      action:
        'Ping the transport endpoint outside the runtime to confirm basic network connectivity. ' +
        'Check DNS resolution and TLS certificate validity.',
      kind: 'observe',
      expectedOutcome: 'HTTP 200 or endpoint-specific health response.',
      automatable: false,
    },
    {
      step: 2,
      title: 'Check authentication credentials',
      action:
        'Verify API keys / bearer tokens are set, not expired, and have the required scopes. ' +
        'Rotate credentials if expired.',
      kind: 'observe',
      expectedOutcome: 'Credentials valid and not expiring within 5 minutes.',
      automatable: false,
    },
    {
      step: 3,
      title: 'Inspect transport error telemetry',
      action:
        'Review the local ledger or console exporter for transport.* spans with ERROR status. ' +
        'Note the error message and last successful connection timestamp.',
      kind: 'observe',
      expectedOutcome: 'Cause identified (auth, network, server-side error).',
      automatable: false,
    },
    {
      step: 4,
      title: 'Force reconnect',
      action:
        'Emit a transport.reconnect event to trigger an immediate reconnection attempt, ' +
        'bypassing the backoff timer.',
      kind: 'command',
      expectedOutcome: 'Connection re-established; transport spans show CONNECT success.',
      automatable: false,
    },
    {
      step: 5,
      title: 'Switch to fallback transport',
      action:
        'If the primary transport remains unreachable after forced reconnect, ' +
        'configure a fallback transport endpoint in TransportManager.',
      kind: 'config',
      expectedOutcome: 'Runtime connected via fallback; primary transport monitored in background.',
      automatable: false,
    },
  ],
  escalationCriteria: [
    'All configured transports (primary + fallback) are unreachable',
    'Reconnect attempts failing for > 10 minutes',
    'Authentication service itself is reporting downtime',
    'Network-level errors (TCP refused, DNS failure) on all endpoints',
  ],
  tags: ['transport', 'mcp', 'websocket', 'network', 'reconnect'],
};
