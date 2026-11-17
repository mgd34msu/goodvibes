import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { hasStoredTokenSync, client as platformClient } from '../lib/goodvibes';
import { formatError, serializeError } from '../lib/errors';
import { asRecord } from '../lib/object';
import { queryKeys } from '../lib/queries';

/**
 * `no-answer`: the request got no answer. Cancelling is safe to repeat: a
 * second cancel of a contract that already stopped is answered definitely
 * (`not-cancelled`), so Retry simply sends it again.
 */
type Phase = 'idle' | 'confirming' | 'pending' | 'acknowledged' | 'not-cancelled' | 'refused' | 'no-answer';

export const CONTRACT_CANCEL_NOTICE = {
  acknowledged: 'Cancellation acknowledged. Child processes may still be stopping. Files already changed may be incomplete.',
  'not-cancelled': 'No live contract was cancelled: it had already ended, or this is a retained record without a live runner.',
} as const;

// The daemon refuses a retained record it is not running with a definite 409:
// nothing was cancelled, which is an answer, not a lost response.
function isNotRunning(error: unknown): boolean {
  const value = serializeError(error);
  const transport = asRecord(value.transport);
  const body = asRecord(value.body ?? transport.body);
  return (value.status ?? transport.status) === 409 && body.code === 'CONTRACT_NOT_RUNNING';
}

/** An HTTP answer from the daemon (any status but a network failure, a timeout or a gateway error). */
function answeredByDaemon(error: unknown): boolean {
  const value = serializeError(error);
  const transport = asRecord(value.transport);
  const status = typeof value.status === 'number' ? value.status : typeof transport.status === 'number' ? transport.status : 0;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const RESPONSE_DEADLINE_MS = 30_000;

/** Cancels already in flight, per account revision and contract: reopening the pane does not send a second one. */
const inFlight = new Set<string>();

export function useContractCancellation(lifetime: ClientLifetime, id: string) {
  const client = useQueryClient();
  const flightKey = `${lifetime.revision}:${id}`;
  const [phase, setPhase] = useState<Phase>(() => inFlight.has(flightKey) ? 'pending' : 'idle');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const current = () => isClientLifetimeCurrent(lifetime) && hasStoredTokenSync();

  useEffect(() => {
    mounted.current = true;
    // A new account must not adopt this one's answer; leaving the pane lets a sent cancel finish.
    const unsubscribe = subscribeClientLifetime(() => abortRef.current?.abort());
    return () => { mounted.current = false; unsubscribe(); };
  }, [lifetime, id]);

  const show = (next: Phase, text?: string) => {
    if (!mounted.current || !current()) return;
    setPhase(next);
    setDetail(text);
  };

  async function send(): Promise<void> {
    if (!current() || inFlight.has(flightKey)) return;
    inFlight.add(flightKey);
    const abort = new AbortController();
    abortRef.current = abort;
    show('pending');
    const timer = setTimeout(() => abort.abort(), RESPONSE_DEADLINE_MS);
    try {
      const result = await platformClient.operator.contracts.cancel(id, abort.signal);
      show(result.cancelled ? 'acknowledged' : 'not-cancelled');
    } catch (error) {
      if (isNotRunning(error)) show('not-cancelled');
      else if (!abort.signal.aborted && answeredByDaemon(error)) show('refused', `The daemon refused the cancel: ${formatError(error)}`);
      else show('no-answer', `No answer from the daemon (${abort.signal.aborted ? `nothing within ${RESPONSE_DEADLINE_MS / 1000}s` : formatError(error)}). Retry sends the cancel again; a contract that already stopped is reported as such.`);
    } finally {
      clearTimeout(timer);
      inFlight.delete(flightKey);
      if (abortRef.current === abort) abortRef.current = undefined;
      if (current()) {
        void client.invalidateQueries({ queryKey: [...queryKeys.contracts, lifetime.revision] });
        void client.invalidateQueries({ queryKey: queryKeys.fleet });
      }
    }
  }

  const ask = useCallback(() => {
    setPhase((previous) => previous === 'pending' || previous === 'confirming' ? previous : 'confirming');
  }, []);
  const dismiss = useCallback(() => {
    setPhase((previous) => previous === 'confirming' ? 'idle' : previous);
  }, []);
  function confirm(): void {
    if (phase === 'confirming') void send();
  }
  function retry(): void {
    if (phase === 'no-answer') void send();
  }

  const notice = phase === 'acknowledged' || phase === 'not-cancelled' ? CONTRACT_CANCEL_NOTICE[phase]
    : phase === 'refused' || phase === 'no-answer' ? detail : undefined;
  return {
    phase, ask, dismiss, confirm, retry, notice,
    disabled: phase === 'pending' || phase === 'confirming' || !current(),
  };
}
