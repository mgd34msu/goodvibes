/**
 * session-inputs.ts, the inbound half of the session wire, for this product.
 *
 * The platform's `createWireSessionDispatch` takes a `SessionInputsWireClient`: two
 * methods over `sessions.inputs.list` and `sessions.inputs.deliver`. It is
 * declared structurally there precisely so each product supplies its own,
 * because building it is the same connection-resolution concern the verb caller
 * already keeps product-side (see client/daemon-verbs.ts).
 *
 * This is that client, over the one gateway-method route this agent uses for
 * every verb. Nothing here is policy: the poller decides what to do with an
 * input, the daemon decides what an input IS, and this shapes two calls.
 */
import { createSessionInputChangeSubscriber } from '@goodvibes/engine/platform/platform/runtime/client';
import type { DaemonVerbCaller, SessionInputsWireClient } from '@goodvibes/engine/platform/platform/runtime/client';
import type { SharedSessionInputRecord } from '@goodvibes/engine/platform/platform/control-plane';
import type { Page } from '@goodvibes/engine/errors';
import { parseDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';

/** What `sessions.inputs.list` answers with, tolerating a bare array. */
/** One page of `sessions.inputs.list`: its inputs, and the cursor to ask again from when the daemon says more remain. */
function readInputsPage(payload: unknown): Page<SharedSessionInputRecord> {
  if (Array.isArray(payload)) return { items: payload as readonly SharedSessionInputRecord[], more: false };
  const record = payload as { inputs?: unknown; more?: unknown; next?: unknown } | null;
  const items = Array.isArray(record?.inputs) ? record.inputs as readonly SharedSessionInputRecord[] : [];
  return record?.more === true && typeof record.next === 'string' ? { items, more: true, next: record.next } : { items, more: false };
}

/** The connected host's address and token, the same the verb caller dials, or why there is none. */
export type SessionInputsConnection = () => { readonly baseUrl: string; readonly token: string } | { readonly reason: string };

/**
 * Build the inbound-inputs wire client.
 *
 * Neither method swallows a failure: the dispatch poller that owns this treats
 * a rejected list as "retry next tick" and a rejected deliver as "leave it
 * queued", and it can only do that if the failure actually reaches it.
 *
 * With `connection`, input changes are pushed from the host's session-update
 * stream, so a hosted session is read when one of its inputs moved rather than
 * every two seconds; without one (or when the stream ends) the poller keeps its
 * short interval.
 */
export function createAgentSessionInputsClient(verbs: DaemonVerbCaller, connection?: SessionInputsConnection): SessionInputsWireClient {
  return {
    // The connected host the verbs dial now: an answer owed to another host waits for that one.
    targetId() {
      const resolved = connection?.();
      return resolved && !('reason' in resolved) ? parseDaemonOrigin(resolved.baseUrl)?.baseUrl ?? resolved.baseUrl : null;
    },

    subscribeInputChanges(onChange, handlers) {
      const resolved = connection?.();
      if (!resolved || 'reason' in resolved) {
        queueMicrotask(() => handlers?.onEnd?.());
        return () => {};
      }
      const token = resolved.token;
      return createSessionInputChangeSubscriber({ baseUrl: resolved.baseUrl, getAuthToken: () => token })(onChange, handlers);
    },

    async listInputs(sessionId, options) {
      const payload = await verbs.invoke<unknown>('sessions.inputs.list', {
        sessionId,
        ...(options.state === undefined ? {} : { state: options.state }),
        ...(options.since === undefined ? {} : { since: options.since }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return readInputsPage(payload);
    },

    // One caller is granted an input; the rest are refused (409), which the
    // dispatcher reads as "another surface holds it". A renewal sends the
    // claim's token (its epoch), so a held input stays this surface's.
    async claimInput(sessionId, inputId, claimEpoch) {
      return await verbs.invoke<unknown>('sessions.inputs.deliver', { sessionId, inputId, claim: true, ...(claimEpoch === undefined ? {} : { claimEpoch }) });
    },

    async deliverInput(sessionId, inputId, options) {
      return await verbs.invoke<unknown>('sessions.inputs.deliver', {
        sessionId,
        inputId,
        ...(options?.consumed === undefined ? {} : { consumed: options.consumed }),
        // The agent answering this input, and (once its turn ends) what it
        // said. Both travel because the run happens HERE: without them the
        // daemon has no reply binding for a channel message it dispatched to
        // this process, and no answer to deliver back to that conversation.
        ...(options?.agentId === undefined ? {} : { agentId: options.agentId }),
        // The process running that agent, so a restarted Agent can end what a process that is gone was answering.
        ...(options?.surfaceInstance === undefined ? {} : { surfaceInstance: options.surfaceInstance }),
        ...(options?.answer === undefined ? {} : { answer: options.answer }),
        ...(options?.status === undefined ? {} : { status: options.status }),
        // This surface's claim token on the input; a superseded claimant's report is refused.
        ...(options?.claimEpoch === undefined ? {} : { claimEpoch: options.claimEpoch }),
      });
    },
  };
}
