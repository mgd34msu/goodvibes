import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { hasStoredTokenSync, client as platformClient } from '../lib/goodvibes';
import { formatError, isDefiniteRefusal, serializeError } from '../lib/errors';
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

const RESPONSE_DEADLINE_MS = 30_000;

interface Outcome {
  readonly phase: Exclude<Phase, 'idle' | 'confirming' | 'pending'>;
  readonly detail?: string;
}

/**
 * Cancels already in flight, per account revision and contract, each with the
 * answer it will settle to: reopening the pane does not send a second one, and
 * a pane opened while one is in flight shows its answer when it comes.
 */
const inFlight = new Map<string, Promise<Outcome>>();

export function useContractCancellation(lifetime: ClientLifetime, id: string) {
  const client = useQueryClient();
  const flightKey = `${lifetime.revision}:${id}`;
  // Read at render, so a flight that settles before the effect below runs is still joined.
  const flightAtRender = inFlight.get(flightKey);
  const [phase, setPhase] = useState<Phase>(() => flightAtRender ? 'pending' : 'idle');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const current = () => isClientLifetimeCurrent(lifetime) && hasStoredTokenSync();

  const show = (next: Phase, text?: string) => {
    if (!mounted.current || !current()) return;
    setPhase(next);
    setDetail(text);
  };

  useEffect(() => {
    mounted.current = true;
    // A new account must not adopt this one's answer; leaving the pane lets a sent cancel finish.
    const unsubscribe = subscribeClientLifetime(() => abortRef.current?.abort());
    // A pane opened while this contract's cancel is in flight (sent from an
    // earlier pane) starts as pending and shows that cancel's answer when it comes.
    const flight = flightAtRender ?? inFlight.get(flightKey);
    if (flight) void flight.then((outcome) => show(outcome.phase, outcome.detail));
    return () => { mounted.current = false; unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the flight is keyed by lifetime.revision and id
  }, [lifetime, id]);

  async function request(abort: AbortController): Promise<Outcome> {
    const timer = setTimeout(() => abort.abort(), RESPONSE_DEADLINE_MS);
    try {
      const result = await platformClient.operator.contracts.cancel(id, abort.signal);
      return { phase: result.cancelled ? 'acknowledged' : 'not-cancelled' };
    } catch (error) {
      if (isNotRunning(error)) return { phase: 'not-cancelled' };
      if (!abort.signal.aborted && isDefiniteRefusal(error)) return { phase: 'refused', detail: `The daemon refused the cancel: ${formatError(error)}` };
      return { phase: 'no-answer', detail: `No answer from the daemon (${abort.signal.aborted ? `nothing within ${RESPONSE_DEADLINE_MS / 1000}s` : formatError(error)}). Retry sends the cancel again; a contract that already stopped is reported as such.` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(): Promise<void> {
    if (!current() || inFlight.has(flightKey)) return;
    const abort = new AbortController();
    abortRef.current = abort;
    show('pending');
    const flight = request(abort);
    inFlight.set(flightKey, flight);
    const outcome = await flight;
    inFlight.delete(flightKey);
    if (abortRef.current === abort) abortRef.current = undefined;
    if (current()) {
      void client.invalidateQueries({ queryKey: [...queryKeys.contracts, lifetime.revision] });
      void client.invalidateQueries({ queryKey: queryKeys.fleet });
    }
    show(outcome.phase, outcome.detail);
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
