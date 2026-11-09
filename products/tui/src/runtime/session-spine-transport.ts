/**
 * session-spine-transport.ts
 *
 * The TUI session-spine cutover: the thin typed-client
 * adapter that lets the TUI's bootstrap drive the platform's
 * `@goodvibes-jev/engine/platform/platform/runtime/session-spine` `SessionSpineClient`
 * via its injected `SpineTransport` seam.
 *
 * The TUI is platform-clean here: `SpineSessionsClient` is exactly the narrow wire
 * surface the old TUI-local `session-spine-client.ts` declared (structurally
 * satisfied by `HttpTransport.operator.sessions`), and `createTuiSpineTransport`
 * folds it into the platform's `SpineTransport` the SAME way the platform's own
 * consumability proof (`session-spine-daemon-integration.test.ts`) does:
 * resolve -> `'ok'`, throw -> `'offline'`. The TUI never emits `'rejected'`, it
 * has no durable-refusal vocabulary to fold (that distinction is the agent's
 * REST mirror's job, per the platform's divergence ruling #6/#7).
 */
import type {
  RegisterSharedSessionInput,
  SharedSessionRecord,
  SharedSessionRegisterResult,
} from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { SpineResult, SpineTransport } from '@goodvibes-jev/engine/platform/platform/runtime/session-spine';

/**
 * The minimal wire surface this adapter needs. Structurally satisfied by BOTH
 * the platform's in-process `OperatorClient['sessions']` (DirectTransport) and the
 * wire `HttpTransportOperatorClient['sessions']` (HttpTransport), bootstrap.ts
 * only ever constructs an Http-backed instance in practice, but this is
 * deliberately typed against the narrow shape rather than either concrete
 * transport type so it has no compile-time dependency on which transport
 * backs it.
 */
export interface SpineSessionsClient {
  register(input: RegisterSharedSessionInput): Promise<SharedSessionRegisterResult>;
  close(sessionId: string): Promise<SharedSessionRecord | null>;
}

/**
 * Adapt the TUI's typed `SpineSessionsClient` into the platform `SessionSpineClient`'s
 * injected `SpineTransport`. A rejecting wire call is treated as a transient
 * connectivity fault (`'offline'`) rather than a durable refusal, the same
 * binary reachability model the pre-extraction TUI-local client used.
 */
export function createTuiSpineTransport(sessionsClient: SpineSessionsClient): SpineTransport {
  return {
    register: async (input: RegisterSharedSessionInput): Promise<SpineResult> => {
      try {
        await sessionsClient.register(input);
        return { outcome: 'ok' };
      } catch (error) {
        return { outcome: 'offline', error: error instanceof Error ? error.message : String(error) };
      }
    },
    close: async (sessionId: string): Promise<SpineResult> => {
      try {
        await sessionsClient.close(sessionId);
        return { outcome: 'ok' };
      } catch (error) {
        return { outcome: 'offline', error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
