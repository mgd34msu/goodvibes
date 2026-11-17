import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { hasStoredTokenSync, client as platformClient } from '../lib/goodvibes';
import { formatError, serializeError } from '../lib/errors';
import { asRecord } from '../lib/object';
import { queryKeys } from '../lib/queries';

export type SessionAction = 'close' | 'reopen' | 'delete';
/**
 * `no-answer`: the request got no answer. Close, reopen and delete are safe to
 * repeat (a second one is answered definitely: already closed, already open,
 * or not found), so Retry sends the same action again.
 */
type Phase = 'idle' | 'confirming' | 'pending' | 'no-answer';

// Target-route absence, not a generic router/auth 404. The native transport's
// generic NOT_FOUND code can shadow the daemon body code. Current GET/close
// responses use the exact uncoded message; DELETE also carries its typed code.
function isTargetMissing(error: unknown): boolean {
  const value = serializeError(error);
  const transport = asRecord(value.transport);
  const body = asRecord(value.body ?? transport.body);
  return (value.status ?? transport.status) === 404
    && (body.code === 'SESSION_NOT_FOUND' || body.error === 'Unknown shared session' || body.message === 'Unknown shared session');
}

/** An HTTP answer from the daemon (any status but a network failure, a timeout or a gateway error). */
function answeredByDaemon(error: unknown): boolean {
  const value = serializeError(error);
  const transport = asRecord(value.transport);
  const status = typeof value.status === 'number' ? value.status : typeof transport.status === 'number' ? transport.status : 0;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const RESPONSE_DEADLINE_MS = 30_000;
const VERB: Record<SessionAction, string> = { close: 'close', reopen: 'reopen', delete: 'delete' };

/** Session actions already in flight, per account revision and session: reopening the pane does not send a second one. */
const inFlight = new Set<string>();

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
  const [phase, setPhase] = useState<Phase>(() => inFlight.has(flightKey) ? 'pending' : 'idle');
  const [action, setAction] = useState<SessionAction | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const current = () => isClientLifetimeCurrent(lifetime) && hasStoredTokenSync();

  useEffect(() => {
    mounted.current = true;
    // A new account must not adopt this one's answer; leaving the pane lets a sent action finish.
    const unsubscribe = subscribeClientLifetime(() => abortRef.current?.abort());
    return () => { mounted.current = false; unsubscribe(); };
  }, [lifetime, id]);

  const show = (next: Phase, text?: string) => {
    if (!mounted.current || !current()) return;
    setPhase(next);
    setNotice(text);
    if (next === 'idle') setAction(undefined);
  };

  async function run(chosen: SessionAction): Promise<void> {
    if (!current() || inFlight.has(flightKey)) return;
    inFlight.add(flightKey);
    const abort = new AbortController();
    abortRef.current = abort;
    setAction(chosen);
    show('pending');
    const timer = setTimeout(() => abort.abort(), RESPONSE_DEADLINE_MS);
    let gone = false;
    try {
      if (chosen === 'close' || chosen === 'reopen') {
        await platformClient.operator.sessions[chosen](id, abort.signal);
      } else {
        // An active session is closed first; a session that is already gone counts as deleted.
        try { await platformClient.operator.sessions.close(id, abort.signal); }
        catch (error) { if (!isTargetMissing(error)) throw error; }
        try { await platformClient.operator.sessions.delete(id, abort.signal); }
        catch (error) { if (!isTargetMissing(error)) throw error; }
        gone = true;
      }
      show('idle');
    } catch (error) {
      if (!abort.signal.aborted && answeredByDaemon(error)) show('idle', `The daemon refused to ${VERB[chosen]} this session: ${formatError(error)}`);
      else show('no-answer', `No answer from the daemon (${abort.signal.aborted ? `nothing within ${RESPONSE_DEADLINE_MS / 1000}s` : formatError(error)}). Retry sends it again; a repeat is answered with the session's current state.`);
    } finally {
      clearTimeout(timer);
      inFlight.delete(flightKey);
      if (abortRef.current === abort) abortRef.current = undefined;
      if (current()) void client.invalidateQueries({ queryKey: queryKeys.sessions });
    }
    if (gone && mounted.current && current()) onClose();
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
