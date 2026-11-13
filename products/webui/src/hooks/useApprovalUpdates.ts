/**
 * useApprovalUpdates, the browser-side consumer of `control.approval_update`.
 *
 * Reference: the platform's own node-side consumer at
 * packages/engine/platform/src/platform/runtime/client/approval-updates.ts (never imported
 * here, it wraps the platform's node stream transport, which does not belong in the
 * browser bundle; this hook is the webui-native equivalent, built on the SAME
 * raw-stream escape hatch useSessionRealtime.ts uses).
 *
 * WIRE SHAPE (verified against approval-updates.ts): the wire event name is the
 * literal string `approval-update` (never the domain name, see
 * useHostedSessionRealtime.ts's header comment on the same "filter-tagged, not
 * domain-forwarded" distinction), narrowed with `?domains=gate`. Payload
 * is `{ approval: <full record>, createdAt }`.
 *
 * PUSH IS THE FAST PATH, NOT A NEW DEPENDENCY: this hook only INVALIDATES
 * `queryKeys.approvals`/`queryKeys.permissionRules` off the frame, it never
 * renders straight from the payload, matching useSessionRealtime's model. When
 * the stream cannot be opened or drops, `connected` goes false and the caller
 * (ApprovalsTasksView) falls back to its own periodic refetch, the poll is
 * never removed, only made unnecessary while push is live.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client as platformClient, DEFAULT_SSE_RECONNECT } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';
import { RELAY_OVERFLOW_EVENT, noteRelayOverflow, readDroppedCount } from '../lib/relay-stream-overflow';

/** The fixed wire-event name every approval transition rides. */
export const APPROVAL_UPDATE_WIRE_EVENT = 'approval-update';

/** `?domains=` narrowing for this stream, the tag `approval-update` carries in
 * the platform's EVENT_DOMAIN table (gateway-scope-enforcement.ts). */
const APPROVAL_UPDATE_EVENTS_PATH = '/api/control-plane/events?domains=gate';

export interface UseApprovalUpdatesResult {
  /** True once the stream reported ready, the caller can stop polling. */
  readonly connected: boolean;
  /** Human-readable note when the stream failed to open or dropped, the
   * caller's poll fallback is the recovery, this is just the honest status. */
  readonly error: string | null;
}

/** Fixed copy: `err.message` can be the raw 401 response body and is never shown. */
const STREAM_ERROR_MESSAGE = 'Live approval updates paused: falling back to periodic refresh.';

export function useApprovalUpdates(enabled: boolean): UseApprovalUpdatesResult {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return undefined;
    }
    let disposed = false;
    let close: (() => void) | null = null;

    const invalidateApprovals = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.permissionRules });
    };

    platformClient.streams
      .open(
        APPROVAL_UPDATE_EVENTS_PATH,
        {
          onReady: () => {
            if (disposed) return;
            setConnected(true);
            setError(null);
          },
          onEvent: (eventName: string, payload: unknown) => {
            if (disposed) return;
            if (eventName === RELAY_OVERFLOW_EVENT) {
              noteRelayOverflow(readDroppedCount(payload));
              invalidateApprovals();
              return;
            }
            if (eventName !== APPROVAL_UPDATE_WIRE_EVENT) return;
            invalidateApprovals();
          },
          onError: (_err: unknown) => {
            if (disposed) return;
            setConnected(false);
            setError(STREAM_ERROR_MESSAGE);
          },
          onTerminate: () => {
            if (disposed) return;
            setConnected(false);
            setError(STREAM_ERROR_MESSAGE);
          },
        },
        { reconnect: DEFAULT_SSE_RECONNECT },
      )
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        close = dispose;
      })
      .catch((_err: unknown) => {
        if (disposed) return;
        setConnected(false);
        setError(STREAM_ERROR_MESSAGE);
      });

    return () => {
      disposed = true;
      if (close) close();
    };
  }, [enabled, queryClient]);

  return { connected, error };
}
