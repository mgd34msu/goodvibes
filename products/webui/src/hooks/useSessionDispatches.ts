import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { hasStoredTokenSync, client as platformClient } from '../lib/goodvibes';
import { formatError, isSessionClosedError, serializeError } from '../lib/errors';
import { asRecord } from '../lib/object';
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

/** 1-128 of [A-Za-z0-9._:-], from getRandomValues (randomUUID needs a secure origin, a LAN address is not one). */
function newMessageId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `web-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The daemon answered and refused (a 4xx other than a timeout or rate limit): sending again would get the same answer. */
function refusedByDaemon(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = typeof serialized.status === 'number' ? serialized.status : typeof transport.status === 'number' ? transport.status : 0;
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
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
  const [dispatches, setDispatches] = useState<LocalDispatch[]>([]);
  const sequence = useRef(0);
  const owner = useRef(false);
  const flights = useRef(new Set<AbortController>());
  const current = () => isClientLifetimeCurrent(lifetime) && hasStoredTokenSync();
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

  // Keep dispatch text/receipts local to this mounted identity, rather than
  // retaining them in QueryClient's cross-account mutation cache after navigation.
  // Every attempt carries the send's messageId, so a resend after a lost
  // response is answered with the receipt of the input already recorded.
  async function dispatch(id: number, body: string, mode: DispatchMode, messageId: string, abort: AbortController) {
    const settle = (change: Partial<LocalDispatch> | ((entry: LocalDispatch) => LocalDispatch)) => {
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
          if (validReceipt(data?.input, sessionId)) {
            settle((entry) => adopt(entry, data.input));
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
          if (refusedByDaemon(error)) {
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
    const messageId = newMessageId();
    setDispatches((previous) => [{ id, mode, text: body, messageId, state: 'sending' as const }, ...previous].slice(0, 20));
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
    start(id, entry.text, entry.mode, entry.messageId);
    return true;
  }

  const missingReceipt = watching && inputs.isSuccess && dispatches.some((entry) => entry.inputId
    && !terminal.has(entry.state) && !inputs.data.inputs.some((input) => input.id === entry.inputId));
  return { dispatches, send, retry, refreshFailed: watching && inputs.isError, missingReceipt };
}
