import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitAuthFailed } from '../runtime/emitters/security.js';

/** Per client address, how many refusals are reported in one window before the rest are summarised. */
const REPORTS_PER_WINDOW = 20;
const WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 5_000;

export interface AuthFailureAudit {
  /** Reports a refused credential to the security domain; never carries the credential. */
  record(clientIp: string, source: string): void;
}

/**
 * A token-guessing client must be visible to the security domain without one
 * event per guess filling the bus: each address reports up to a fixed count per
 * window, then one `rate_limited` event, then nothing until the window ends.
 */
export function createAuthFailureAudit(bus: RuntimeEventBus | undefined, now: () => number = Date.now): AuthFailureAudit {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    record(clientIp, source) {
      if (!bus) return;
      const at = now();
      let entry = windows.get(clientIp);
      if (!entry || at - entry.start >= WINDOW_MS) {
        if (!entry && windows.size >= MAX_TRACKED_CLIENTS) {
          for (const [ip, tracked] of windows) if (at - tracked.start >= WINDOW_MS) windows.delete(ip);
          if (windows.size >= MAX_TRACKED_CLIENTS) windows.clear();
        }
        entry = { start: at, count: 0 };
        windows.set(clientIp, entry);
      }
      entry.count += 1;
      if (entry.count > REPORTS_PER_WINDOW + 1) return;
      emitAuthFailed(bus, { sessionId: 'system', traceId: `auth:${source}:${crypto.randomUUID()}`, source },
        { usernameAttempted: '', clientIp, reason: entry.count > REPORTS_PER_WINDOW ? 'rate_limited' : 'invalid_credentials' });
    },
  };
}
