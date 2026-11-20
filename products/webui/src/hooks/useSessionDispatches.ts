import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorMethodOutput } from '@goodvibes/engine/contracts';
import { isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { hasSignInSync, client as platformClient } from '../lib/goodvibes';
import { formatError, isDefiniteRefusal, isSessionClosedError, serializeError } from '../lib/errors';
import { asRecord } from '../lib/object';
import { heldInputsForThisPage } from '../lib/held-input';
import { queryKeys } from '../lib/queries';

type InputReceipt = OperatorMethodOutput<'sessions.inputs.list'>['inputs'][number];
export type DispatchMode = 'steer' | 'followUp';
export interface LocalDispatch {
  id: number;
  mode: DispatchMode;
  text: string;
  /** The replay key sent with every attempt of this send: the daemon records it once. */
  messageId: string;
  /** `unsent`: no attempt got an answer; `retry` sends it again under the same messageId. */
  state: InputReceipt['state'] | 'sending' | 'unsent';
  inputId?: string;
  updatedAt?: number;
  error?: string;
}
const terminal = new Set<LocalDispatch['state']>(['completed', 'failed', 'cancelled', 'rejected', 'unsent']);

/** Attempts per send before it is shown as unsent, each with its own deadline; the waits between them. */
const ATTEMPT_DEADLINE_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;

/**
 * Completed dispatches kept on screen. Only a completed one is cut: its text is in
 * the session's transcript. One still on its way, or one that never reached the
 * session (failed, rejected, cancelled, unsent), is never cut: this row is the
 * only place its text and its fate are shown.
 */
const SHOWN_COMPLETED = 20;
function keepShown(list: LocalDispatch[]): LocalDispatch[] {
  let completed = 0;
  return list.filter((entry) => entry.state !== 'completed' || ++completed <= SHOWN_COMPLETED);
}

const states = new Set<InputReceipt['state']>(['queued', 'delivered', 'spawned', 'completed', 'cancelled', 'failed', 'rejected']);

function validReceipt(value: unknown, sessionId: string): value is InputReceipt {
  const input = asRecord(value);
  return typeof input.id === 'string' && input.id.length > 0 && input.sessionId === sessionId
    && states.has(input.state as InputReceipt['state']) && typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
    && (input.error === undefined || typeof input.error === 'string');
}

function adopt(dispatch: LocalDispatch, input: InputReceipt): LocalDispatch {
  // An older in-flight list must not undo a newer POST receipt, or regress a
  // delivered/terminal input to queued when updates share a millisecond.
  // A spawn POST's receipt can be ahead of a list read taken before the
  // broker's claim of that exact input; that stale list still shows it queued.
  if ((dispatch.updatedAt ?? -Infinity) > input.updatedAt || terminal.has(dispatch.state)
    || (input.state === 'queued' && dispatch.state === 'delivered')) return dispatch;
  if (dispatch.inputId === input.id && dispatch.state === input.state
    && dispatch.updatedAt === input.updatedAt && dispatch.error === input.error) return dispatch;
  return { ...dispatch, inputId: input.id, state: input.state, updatedAt: input.updatedAt, error: input.error };
}

/** One local receipt per send; list/event refreshes match only the returned input ID. */
export function useSessionDispatches(lifetime: ClientLifetime, sessionId: string, streamPaused: boolean) {
  const client = useQueryClient();
  // What was sent and not yet answered lives in the held store above this pane
  // (one per daemon and account, kept for the tab): leaving the session and
  // coming back, or reloading, shows it again as unsent with Retry, under the
  // same messageId. It leaves the store once the daemon answered for it.
  const held = heldInputsForThisPage();
  const [dispatches, setDispatches] = useState<LocalDispatch[]>(() => held.list(sessionId).map((entry, index) => ({
    id: -(index + 1),
    mode: entry.flags.steer ? 'steer' as const : 'followUp' as const,
    text: entry.text,
    messageId: entry.clientMessageId,
    state: 'unsent' as const,
    error: entry.reason ?? 'Its answer was not seen before this view was left. Retry sends it again; the daemon records it at most once.',
  })));
  const sequence = useRef(0);
  const owner = useRef(false);
  const flights = useRef(new Set<AbortController>());
  const current = () => isClientLifetimeCurrent(lifetime) && hasSignInSync();
  const owned = () => owner.current && current();
  const key = queryKeys.sessionInputs(lifetime.revision, sessionId);

  useEffect(() => {
    owner.current = true;
    const aborts = flights.current;
    const release = () => {
      owner.current = false;
      client.removeQueries({ queryKey: queryKeys.sessionInputs(lifetime.revision, sessionId), exact: true });
    };
    // A new identity must not keep a request in flight. Leaving this composer is
    // different: a POST already sent may have reached the daemon, so it is left to
    // finish (bounded by its own deadline) and only refreshes the session lists.
    const retire = () => {
      for (const abort of aborts) abort.abort();
      aborts.clear();
      release();
    };
    const unsubscribe = subscribeClientLifetime(retire);
    return () => { unsubscribe(); release(); };
  }, [client, lifetime, sessionId]);

  const watching = dispatches.some((dispatch) => dispatch.inputId && !terminal.has(dispatch.state));
  const inputs = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      const unsubscribe = subscribeClientLifetime(cancel);
      const timer = setTimeout(cancel, 15_000);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (signal.aborted || !current()) cancel();
        abort.signal.throwIfAborted();
        const result = await platformClient.operator.sessions.inputs.list(sessionId, abort.signal);
        if (!current()) cancel();
        abort.signal.throwIfAborted();
        if (!Array.isArray(result?.inputs) || result.inputs.some((input) => !validReceipt(input, sessionId))) {
          throw new Error('The daemon returned unreadable input receipts.');
        }
        return result;
      } finally { clearTimeout(timer); unsubscribe(); signal.removeEventListener('abort', cancel); }
    },
    enabled: watching && current(),
    retry: false,
    gcTime: 0,
    // Session events invalidate this prefixed query; polling also covers lost events.
    refetchInterval: streamPaused ? 5_000 : 15_000,
  });

  useEffect(() => {
    if (!inputs.data || !isClientLifetimeCurrent(lifetime)) return;
    const receipts = new Map(inputs.data.inputs.map((input) => [input.id, input]));
    setDispatches((previous) => {
      const next = previous.map((dispatch) => {
        const input = dispatch.inputId ? receipts.get(dispatch.inputId) : undefined;
        return input ? adopt(dispatch, input) : dispatch;
      });
      return next.some((dispatch, index) => dispatch !== previous[index]) ? next : previous;
    });
  }, [inputs.data, dispatches, lifetime]);

  // Receipts stay local to this mounted identity, rather than in QueryClient's
  // cross-account mutation cache; unanswered text is in the held store, which is
  // scoped to this daemon and account and cleared on sign-out. Every attempt carries the send's messageId, so a resend after a lost
  // response is answered with the receipt of the input already recorded.
  async function dispatch(id: number, body: string, mode: DispatchMode, messageId: string, abort: AbortController) {
    const settle = (change: Partial<LocalDispatch> | ((entry: LocalDispatch) => LocalDispatch)) => {
      // The held entry follows the answer whether or not this pane is still mounted: a receipt
      // or a refusal ends it; no answer keeps it (unsent, retried under the same id).
      const state = typeof change === 'function' ? undefined : change.state;
      if (state === 'unsent') held.unknown(messageId, typeof change === 'function' ? 'no answer' : change.error ?? 'no answer');
      else held.accepted(messageId);
      if (!owned()) return;
      setDispatches((previous) => previous.map((entry) => entry.id !== id ? entry
        : typeof change === 'function' ? change(entry) : { ...entry, ...change }));
    };
    let lastError = '';
    try {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          await new Promise<void>((resolve) => {
            const wait = setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]);
            abort.signal.addEventListener('abort', () => { clearTimeout(wait); resolve(); }, { once: true });
          });
        }
        if (!owned()) abort.abort();
        if (abort.signal.aborted) return;
        const attemptAbort = new AbortController();
        const stop = () => attemptAbort.abort();
        abort.signal.addEventListener('abort', stop, { once: true });
        const deadline = setTimeout(stop, ATTEMPT_DEADLINE_MS);
        try {
          const data = await (mode === 'steer'
            ? platformClient.operator.sessions.steer(sessionId, { body, messageId }, attemptAbort.signal)
            : platformClient.operator.sessions.followUp(sessionId, { body, messageId }, attemptAbort.signal));
          if (abort.signal.aborted) return;
          if (!owned()) {
            if (current()) void client.invalidateQueries({ queryKey: queryKeys.sessions });
            return;
          }
          const receipt: unknown = data?.input;
          if (validReceipt(receipt, sessionId)) {
            settle((entry) => adopt(entry, receipt));
            void client.invalidateQueries({ queryKey: queryKeys.sessions });
            return;
          }
          lastError = 'the daemon answered without an input receipt';
        } catch (error) {
          if (abort.signal.aborted) return;
          if (!owned()) {
            if (current()) void client.invalidateQueries({ queryKey: queryKeys.sessions });
            return;
          }
          const serialized = serializeError(error);
          const input = asRecord(serialized.body ?? asRecord(serialized.transport).body).input;
          if (validReceipt(input, sessionId)) {
            settle((entry) => adopt(entry, input));
            void client.invalidateQueries({ queryKey: queryKeys.sessions });
            return;
          }
          if (isSessionClosedError(error)) {
            settle({ state: 'failed', error: 'This session is closed. Reopen it to continue.' });
            void client.invalidateQueries({ queryKey: queryKeys.sessions });
            return;
          }
          if (isDefiniteRefusal(error)) {
            settle({ state: 'failed', error: `Not sent: ${formatError(error)}` });
            return;
          }
          lastError = attemptAbort.signal.aborted ? `no answer within ${ATTEMPT_DEADLINE_MS / 1000}s` : formatError(error);
        } finally {
          clearTimeout(deadline);
          abort.signal.removeEventListener('abort', stop);
        }
      }
      settle({ state: 'unsent', error: `No answer from the daemon after ${RETRY_DELAYS_MS.length + 1} tries (${lastError}). Retry sends it again; the daemon records it at most once.` });
    } finally { flights.current.delete(abort); }
  }

  function start(id: number, body: string, mode: DispatchMode, messageId: string): void {
    const abort = new AbortController();
    flights.current.add(abort);
    void dispatch(id, body, mode, messageId, abort);
  }

  function send(body: string, mode: DispatchMode): boolean {
    if (!owned()) return false;
    const id = ++sequence.current;
    const messageId = held.hold({ sessionId, text: body, attachments: [], flags: mode === 'steer' ? { steer: true } : {} }).clientMessageId;
    setDispatches((previous) => keepShown([{ id, mode, text: body, messageId, state: 'sending' as const }, ...previous]));
    start(id, body, mode, messageId);
    return true;
  }

  /** Send an unsent dispatch again under its own messageId: delivered at most once whatever happened to the earlier attempts. */
  function retry(id: number): boolean {
    if (!owned()) return false;
    const entry = dispatches.find((candidate) => candidate.id === id);
    if (!entry || entry.state !== 'unsent') return false;
    setDispatches((previous) => previous.map((candidate) => candidate.id !== id ? candidate
      : { ...candidate, state: 'sending', error: undefined }));
    // Its held entry (kept while unsent) is sending again, under the same id.
    held.resending(entry.messageId);
    start(id, entry.text, entry.mode, entry.messageId);
    return true;
  }

  const missingReceipt = watching && inputs.isSuccess && dispatches.some((entry) => entry.inputId
    && !terminal.has(entry.state) && !inputs.data.inputs.some((input) => input.id === entry.inputId));
  return { dispatches, send, retry, refreshFailed: watching && inputs.isError, missingReceipt };
}
