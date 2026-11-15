/**
 * useCompactionReceipts, live compaction signal for ONE session's detail view.
 *
 * Subscribes to the `compaction` domain on the shared event stream's detail lane (see
 * lib/event-stream.ts; lib/compaction.ts explains why this is the only source of
 * post-compaction receipts and live token-usage numbers). The domain is daemon-wide, so
 * every frame is filtered to the given sessionId: a receipt for a DIFFERENT session must
 * never bleed into this view.
 *
 * Content-consuming, not invalidate-only: a compaction receipt has no queryable snapshot,
 * so the frame itself is the only copy of this data. Mount it only while a session's
 * detail pane is open; the detail lane closes when nothing on it is subscribed.
 */

import { useEffect, useState } from 'react';
import { parseCompactionCheck, parseCompactionReceipt, type CompactionCheck, type CompactionReceipt } from '../lib/compaction';
import { subscribeEvents, useEventStreamState } from '../lib/event-stream';

/** Cap retained receipts per session, an honest live log, not an unbounded leak. */
const MAX_RECEIPTS = 20;

export interface CompactionReceiptsState {
  receipts: CompactionReceipt[];
  latestCheck: CompactionCheck | null;
  connected: boolean;
  error: string | null;
}

export function useCompactionReceipts(sessionId: string, enabled: boolean): CompactionReceiptsState {
  const [receipts, setReceipts] = useState<CompactionReceipt[]>([]);
  const [latestCheck, setLatestCheck] = useState<CompactionCheck | null>(null);
  const stream = useEventStreamState('detail');
  // Reset the log when the session changes, during render (the React-blessed
  // "adjust state when a prop changes" pattern), before the effect below
  // re-subscribes, avoiding a one-frame flash of the PREVIOUS session's receipts.
  const [trackedSessionId, setTrackedSessionId] = useState(sessionId);
  if (trackedSessionId !== sessionId) {
    setTrackedSessionId(sessionId);
    setReceipts([]);
    setLatestCheck(null);
  }

  const active = enabled && Boolean(sessionId);
  useEffect(() => {
    if (!active) return undefined;
    return subscribeEvents({
      domains: ['compaction'],
      events: ['compaction'],
      onEvent: (_name, payload) => {
        const receipt = parseCompactionReceipt(payload);
        if (receipt) {
          if (receipt.sessionId === sessionId) setReceipts((current) => [...current, receipt].slice(-MAX_RECEIPTS));
          return;
        }
        const check = parseCompactionCheck(payload);
        if (check?.sessionId === sessionId) setLatestCheck(check);
      },
    });
  }, [active, sessionId]);

  const down = stream.status === 'paused' || stream.status === 'ended';
  return {
    receipts,
    latestCheck,
    connected: active && stream.status === 'live',
    error: active && down ? stream.message : null,
  };
}
