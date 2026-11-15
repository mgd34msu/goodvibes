import type { RuntimeEventBus } from './events/index.js';
import {
  emitTokenBlocked,
  emitTokenRotationExpired,
  emitTokenRotationWarning,
  emitTokenScopeViolation,
} from './emitters/security.js';
import type { SecurityEventEmitter } from '../security/token-audit.js';

/**
 * Puts the token auditor's findings on the runtime bus's `security` domain.
 *
 * The auditor reports a finding on every `auditAll()`, and read models call that
 * on every refresh, so each finding is sent once: a repeat of the same finding
 * for the same token is dropped. A rotated token has a new due date and a changed
 * scope set is a new finding, so both report again.
 */
export function createTokenAuditBusEmitter(bus: RuntimeEventBus): SecurityEventEmitter {
  const sent = new Set<string>();
  const once = (key: string): boolean => {
    if (sent.has(key)) return false;
    sent.add(key);
    return true;
  };
  return (event) => {
    const ctxFor = (tokenId: string) => ({ sessionId: 'system', traceId: `token-audit:${event.type}:${tokenId}`, source: 'token-auditor' }) as const;
    switch (event.type) {
      case 'TOKEN_SCOPE_VIOLATION':
        if (once(`${event.type}:${event.tokenId}:${[...event.excessScopes].sort().join(',')}`)) {
          emitTokenScopeViolation(bus, ctxFor(event.tokenId), { tokenId: event.tokenId, label: event.label, policyId: event.policyId, excessScopes: [...event.excessScopes] });
        }
        return;
      case 'TOKEN_ROTATION_WARNING':
        if (once(`${event.type}:${event.tokenId}:${event.dueAt}`)) {
          emitTokenRotationWarning(bus, ctxFor(event.tokenId), { tokenId: event.tokenId, label: event.label, msUntilDue: event.msUntilDue, dueAt: event.dueAt, ageMs: event.ageMs });
        }
        return;
      case 'TOKEN_ROTATION_EXPIRED':
        if (once(`${event.type}:${event.tokenId}:${event.dueAt}`)) {
          emitTokenRotationExpired(bus, ctxFor(event.tokenId), { tokenId: event.tokenId, label: event.label, ageMs: event.ageMs, cadenceMs: event.cadenceMs, dueAt: event.dueAt });
        }
        return;
      case 'TOKEN_BLOCKED':
        if (once(`${event.type}:${event.tokenId}:${event.reason}`)) {
          emitTokenBlocked(bus, ctxFor(event.tokenId), { tokenId: event.tokenId, label: event.label, reason: event.reason });
        }
        return;
      default:
        return;
    }
  };
}
