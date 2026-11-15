import { useEffect, useRef } from 'react';

/**
 * How many message polls a 'syncing' turn waits for its reply before it is
 * settled. 'syncing' only ends when a new assistant message shows up, so a turn
 * that persisted none (cancelled before any output while the stream was down, an
 * empty completion) would otherwise poll forever.
 */
export const SYNC_POLL_LIMIT = 30;

/**
 * Settle a 'syncing' turn after SYNC_POLL_LIMIT message refreshes without a
 * reply. `polledAt` changes on every refresh of the message list; `settle` is
 * called once the limit is passed and only while still syncing.
 */
export function useSyncSettle(turnState: string, polledAt: number, settle: () => void): void {
  const polls = useRef(0);
  useEffect(() => {
    if (turnState !== 'syncing') {
      polls.current = 0;
      return;
    }
    polls.current += 1;
    if (polls.current > SYNC_POLL_LIMIT) {
      polls.current = 0;
      settle();
    }
    // settle is a caller callback; only a new poll or state change counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnState, polledAt]);
}
