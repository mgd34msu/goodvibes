/**
 * gateway-daemon-forward.ts, the TUI's local gateway catalog answers its verbs
 * by asking the daemon.
 *
 * This product serves no verbs of its own, but the mail, calendar, review and
 * Settings Connections surfaces call `gatewayMethods.invoke(...)`. Without a
 * handler those calls fail with "no internal handler" even when the daemon is
 * configured and healthy. Every invokable built-in method gets a handler that
 * sends the same call to the daemon through the daemon verb caller, which
 * refuses honestly when no daemon is reachable and reports the daemon's own
 * error otherwise.
 *
 * Only `body` and `query` cross to the daemon. The daemon derives who is asking
 * from the authenticated connection, so the caller's `context` is not sent.
 */
import type { GatewayMethodCatalog, GatewayMethodHandler } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function forwardGatewayMethodsToDaemon(catalog: GatewayMethodCatalog, verbs: DaemonVerbCaller): void {
  for (const descriptor of catalog.list()) {
    if (descriptor.invokable === false || catalog.hasHandler(descriptor.id)) continue;
    const forward: GatewayMethodHandler = (invocation) => {
      const { body, query } = invocation;
      // A GET verb reads its parameters from the query and a POST verb from the
      // body; the daemon's generic route takes one input record for both.
      const input = body === undefined || isRecord(body)
        ? { ...(query ?? {}), ...(isRecord(body) ? body : {}) }
        : body;
      return verbs.invoke(descriptor.id, input);
    };
    catalog.register(descriptor, forward, { replace: true });
  }
}
