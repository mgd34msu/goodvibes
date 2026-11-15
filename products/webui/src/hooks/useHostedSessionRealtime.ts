/**
 * Live turn/tool output and lifecycle updates for an attached hosted session.
 *
 * Turn and tool output come from the shared event stream's detail lane (`turn`,
 * `tools`); lifecycle updates (`hosted-session-update`) already ride the app lane,
 * whose app-wide subscriber keeps the hosted list fresh, so this hook only forwards
 * the attached session's own lifecycle frames. Row changes retarget callbacks through
 * a ref without re-subscribing.
 */
import { useEffect, useRef } from 'react';
import { subscribeEvents, useEventStreamState } from '../lib/event-stream';
import { HOSTED_SESSION_UPDATE_WIRE_EVENT } from '../lib/hosted-sessions';
import { firstString, readPath } from '../lib/object';
import { readHostedStreamFrame, type HostedStreamFrame } from '../lib/hosted-session-stream';

export interface UseHostedSessionRealtimeOptions {
  readonly enabled: boolean;
  /** The currently-attached hosted session, or null/undefined when only the list
   * is showing, turn/tools frames are forwarded only when they match this id. */
  readonly attachedSessionId?: string | null;
  readonly onStreamFrame?: (frame: HostedStreamFrame) => void;
  /** Called when a hosted-session-update frame's session id matches
   * `attachedSessionId`, the raw frame payload (`{event, session, ...}`). */
  readonly onLifecycleUpdate?: (payload: unknown) => void;
  /** The output stream is live again or dropped frames: re-read the transcript. */
  readonly onReconcile?: () => void;
}

export interface UseHostedSessionRealtimeResult {
  readonly connected: boolean;
  readonly error: string | null;
}

export function useHostedSessionRealtime(options: UseHostedSessionRealtimeOptions): UseHostedSessionRealtimeResult {
  const { enabled } = options;
  const stream = useEventStreamState('detail');

  // Read through a ref inside the long-lived callbacks so attaching or detaching a
  // session never re-subscribes. Synced in its own effect, never during render.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const output = subscribeEvents({
      domains: ['turn', 'tools'],
      events: ['turn', 'tools'],
      onEvent: (_name, payload) => {
        const { attachedSessionId, onStreamFrame } = optionsRef.current;
        if (!attachedSessionId) return;
        const frame = readHostedStreamFrame(payload);
        if (frame?.sessionId === attachedSessionId) onStreamFrame?.(frame);
      },
      onReady: () => optionsRef.current.onReconcile?.(),
      onGap: () => optionsRef.current.onReconcile?.(),
    });
    const lifecycle = subscribeEvents({
      domains: ['session'],
      events: [HOSTED_SESSION_UPDATE_WIRE_EVENT],
      onEvent: (_name, payload) => {
        const { attachedSessionId, onLifecycleUpdate } = optionsRef.current;
        const sessionId = firstString(readPath(payload, ['session']), ['id']);
        if (attachedSessionId && sessionId === attachedSessionId) onLifecycleUpdate?.(payload);
      },
    });
    return () => {
      output();
      lifecycle();
    };
  }, [enabled]);

  const down = stream.status === 'paused' || stream.status === 'ended';
  return {
    connected: enabled && stream.status === 'live',
    error: enabled && down ? stream.message : null,
  };
}
