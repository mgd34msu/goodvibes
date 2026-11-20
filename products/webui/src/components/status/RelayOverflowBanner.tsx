/**
 * RelayOverflowBanner, the resync owner for live events dropped for this browser.
 *
 * When the daemon drops frames for a slow reader, or the relay tunnel's send buffer
 * overflows, the stream reports a typed gap carrying the dropped count (never a silent
 * one). The stream consumers record it into the relay-overflow store. The missed events were only ever
 * invalidation triggers, so refetching every query is the complete recovery: this component
 * runs it by itself, once per burst (notices inside the coalescing window share one pass),
 * and shows a passive one-line note while it runs. Nothing is asked of the operator.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useRelayOverflow } from '../../hooks/useRelayOverflow';
import { acknowledgeRelayOverflow } from '../../lib/relay-stream-overflow';
import '../../styles/components/status.css';

/** Overflow notices that arrive this close together are one burst and get one refetch pass. */
const RESYNC_COALESCE_MS = 250;

export function RelayOverflowBanner() {
  const queryClient = useQueryClient();
  const { totalDropped } = useRelayOverflow();
  const outstanding = totalDropped > 0;
  const [refreshing, setRefreshing] = useState(false);
  // Component lifetime and passes in flight are tracked apart from the scheduling effect: the
  // acknowledge below flips `outstanding`, which re-runs that effect while its refetch is still
  // running, so the effect's own cleanup cannot say whether the note may be taken down.
  const alive = useRef(true);
  const passesInFlight = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!outstanding) return;
    const timer = setTimeout(() => {
      // Cleared before the refetch, so a drop during the refetch schedules its own pass.
      acknowledgeRelayOverflow();
      passesInFlight.current += 1;
      setRefreshing(true);
      void queryClient.invalidateQueries().finally(() => {
        passesInFlight.current -= 1;
        if (alive.current && passesInFlight.current === 0) setRefreshing(false);
      });
    }, RESYNC_COALESCE_MS);
    return () => { clearTimeout(timer); };
  }, [outstanding, queryClient]);

  if (!outstanding && !refreshing) return null;

  return (
    <div className="banner relay-overflow-banner" role="status" aria-live="polite">
      <RefreshCw size={16} aria-hidden="true" />
      <span>Live updates dropped events; refreshing this view.</span>
    </div>
  );
}
