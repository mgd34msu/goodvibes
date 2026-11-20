import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { hasSignInSync, client as platformClient } from '../lib/goodvibes';
import { formatError, isDefiniteRefusal, serializeError } from '../lib/errors';
import { asRecord } from '../lib/object';
import { queryKeys } from '../lib/queries';

export type SessionAction = 'close' | 'reopen' | 'delete';
/**
 * `no-answer`: the request got no answer. Close, reopen and delete are safe to
 * repeat (a second one is answered definitely: already closed, already open,
 * or not found), so Retry sends the same action again.
 */
type Phase = 'idle' | 'confirming' | 'pending' | 'no-answer';

// Target-route absence, not a generic router/auth 404: every session route
// that cannot find the session answers with the code SESSION_NOT_FOUND. The
// body is read because the transport's generic NOT_FOUND code can shadow it.
function isTargetMissing(error: unknown): boolean {
  const value = serializeError(error);
  const transport = asRecord(value.transport);
  const body = asRecord(value.body ?? transport.body);
  return (value.status ?? transport.status) === 404 && body.code === 'SESSION_NOT_FOUND';
}

const RESPONSE_DEADLINE_MS = 30_000;
const VERB: Record<SessionAction, string> = { close: 'close', reopen: 'reopen', delete: 'delete' };

interface Outcome {
  readonly phase: 'idle' | 'no-answer';
  readonly notice?: string;
  /** The session no longer exists: the pane closes. */
  readonly gone: boolean;
}

interface Flight {
  readonly action: SessionAction;
  readonly outcome: Promise<Outcome>;
}

/**
 * Session actions already in flight, per account revision and session, each
 * with the answer it will settle to: reopening the pane does not send a second
 * one, and a pane opened while one is in flight shows its answer when it comes
 * (and closes when it was a delete that went through).
 */
const inFlight = new Map<string, Flight>();

/** The list is authoritative only when every record can be identified. A bad
 * response must never become an empty list and falsely prove deletion. */
export async function readSessionList(lifetime: ClientLifetime, signal: AbortSignal) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  const check = () => {
    if (signal.aborted || !isClientLifetimeCurrent(lifetime)) cancel();
    abort.signal.throwIfAborted();
  };
  try {
    check();
    const result = await platformClient.operator.sessions.list(abort.signal);
    check();
    const records: unknown = asRecord(result).sessions;
    if (!Array.isArray(records) || records.some((record: unknown) => {
      const id = asRecord(record).id;
      return typeof id !== 'string' || !id.trim();
    })) {
      throw new Error('The daemon returned an unreadable session list.');
    }
    return result;
  } finally { unsubscribe(); signal.removeEventListener('abort', cancel); }
}

export function useSessionLifecycle(id: string, onClose: () => void) {
  const client = useQueryClient();
  // A pane belongs to the account it opened under; WorkView remounts on identity change.
  const [lifetime] = useState(getClientLifetime);
  const flightKey = `${lifetime.revision}:${id}`;
  // Read at render, so a flight that settles before the effect below runs is still joined.
  const flightAtRender = inFlight.get(flightKey);
  const [phase, setPhase] = useState<Phase>(() => flightAtRender ? 'pending' : 'idle');
  const [action, setAction] = useState<SessionAction | undefined>(() => flightAtRender?.action);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const abortRef = useRef<AbortController | undefined>(undefined);
  // The latest onClose, synced in its own effect (never during render), for a delete's answer.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const current = () => isClientLifetimeCurrent(lifetime) && hasSignInSync();

  const show = (next: Phase, text?: string) => {
    if (!mounted.current || !current()) return;
    setPhase(next);
    setNotice(text);
    if (next === 'idle') setAction(undefined);
  };

  const settle = (outcome: Outcome) => {
    show(outcome.phase, outcome.notice);
    if (outcome.gone && mounted.current && current()) onCloseRef.current();
  };

  useEffect(() => {
    mounted.current = true;
    // A new account must not adopt this one's answer; leaving the pane lets a sent action finish.
    const unsubscribe = subscribeClientLifetime(() => abortRef.current?.abort());
    // A pane opened while an action on this session is in flight (sent from an
    // earlier pane) starts as pending and applies that action's answer when it comes.
    const flight = flightAtRender ?? inFlight.get(flightKey);
    if (flight) void flight.outcome.then(settle);
    return () => { mounted.current = false; unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the flight is keyed by lifetime.revision and id
  }, [lifetime, id]);

  async function request(chosen: SessionAction, abort: AbortController): Promise<Outcome> {
    const timer = setTimeout(() => abort.abort(), RESPONSE_DEADLINE_MS);
    try {
      if (chosen === 'close' || chosen === 'reopen') {
        await platformClient.operator.sessions[chosen](id, abort.signal);
        return { phase: 'idle', gone: false };
      }
      // An active session is closed first; a session that is already gone counts as deleted.
      try { await platformClient.operator.sessions.close(id, abort.signal); }
      catch (error) { if (!isTargetMissing(error)) throw error; }
      try { await platformClient.operator.sessions.delete(id, abort.signal); }
      catch (error) { if (!isTargetMissing(error)) throw error; }
      return { phase: 'idle', gone: true };
    } catch (error) {
      if (!abort.signal.aborted && isDefiniteRefusal(error)) {
        return { phase: 'idle', notice: `The daemon refused to ${VERB[chosen]} this session: ${formatError(error)}`, gone: false };
      }
      return { phase: 'no-answer', notice: `No answer from the daemon (${abort.signal.aborted ? `nothing within ${RESPONSE_DEADLINE_MS / 1000}s` : formatError(error)}). Retry sends it again; a repeat is answered with the session's current state.`, gone: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(chosen: SessionAction): Promise<void> {
    if (!current() || inFlight.has(flightKey)) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setAction(chosen);
    show('pending');
    const outcome = request(chosen, abort);
    inFlight.set(flightKey, { action: chosen, outcome });
    const settled = await outcome;
    inFlight.delete(flightKey);
    if (abortRef.current === abort) abortRef.current = undefined;
    if (current()) void client.invalidateQueries({ queryKey: queryKeys.sessions });
    settle(settled);
  }

  function ask(chosen: SessionAction): void {
    if (!current() || phase === 'pending' || phase === 'confirming') return;
    if (chosen === 'reopen') { void run(chosen); return; }
    setAction(chosen);
    setNotice(undefined);
    setPhase('confirming');
  }
  function dismiss(): void {
    if (phase === 'confirming') { setPhase('idle'); setAction(undefined); }
  }
  const confirm = () => { if (phase === 'confirming' && action) void run(action); };
  const retry = () => { if (phase === 'no-answer' && action) void run(action); };
  return { phase, action, notice, ask, dismiss, confirm, retry,
    disabled: phase === 'pending' || phase === 'confirming' || !current(),
  };
}
