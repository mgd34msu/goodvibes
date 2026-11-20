import { APIConnectionError, APIError, APIUserAbortError, TypeSafeError, type Fetch, type SystemOneRequest, type SystemOneResult, type Questions } from '@typesafe-ai/sdk';
import type { JudgmentConfig } from './config.ts';
import { JudgmentContextLimitError, JudgmentError } from './errors.ts';
import { recordingRequestIds } from './request-id.ts';
import { interruptible, transientStatus } from './retry.ts';

export function toJudgmentError(error: unknown): JudgmentError {
  // Thrown values can trap prototype inspection or known-error property reads.
  // A classifier failure is itself local, never evidence of a provider outage.
  try { return classifyJudgmentError(error); }
  catch { return new JudgmentError('internal', 'The decision client failed internally. The operation has stopped.'); }
}

function classifyJudgmentError(error: unknown): JudgmentError {
  if (error instanceof JudgmentError) return error.kind === 'internal'
    ? new JudgmentError('internal', 'The decision client failed internally. The operation has stopped.',
      error.lineage === undefined ? {} : { lineage: error.lineage }) : error;
  if (error instanceof APIUserAbortError) {
    return new JudgmentError('aborted', 'the judgment call was cancelled');
  }
  if (error instanceof APIError) {
    const { status, requestId } = error;
    const body = error.body;
    const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : undefined;
    if (status === 400 && detail && typeof detail === 'object' && 'error_type' in detail && detail.error_type === 'max_tokens_exceeded') {
      return new JudgmentContextLimitError(requestId === undefined ? {} : { requestId });
    }
    const kind = transientStatus(status) ? 'unavailable' : 'rejected';
    return new JudgmentError(kind, `System One answered HTTP ${status}`, {
      status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  if (error instanceof APIConnectionError) {
    return new JudgmentError('unavailable', 'System One could not be reached');
  }
  if (error instanceof TypeSafeError) {
    return new JudgmentError('invalid-request', 'System One rejected the client request configuration');
  }
  return new JudgmentError('internal', 'The decision client failed internally. The operation has stopped.');
}

/** Largest response body read from the decision endpoint; a decision answer is a few kilobytes. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) { super(`System One answered with more than ${maxBytes} bytes`); }
}

/**
 * The body as text, read up to `maxBytes`: a larger body is cancelled and is a
 * connection failure naming the cap, so an endpoint cannot make this process
 * hold an unbounded answer.
 */
async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A request body already serialized by the caller, sent as is. */
export class PreparedBody {
  constructor(readonly text: string) {}
}

/** One wire request, owned by the caller's cancellation/deadline signal. */
export async function requestWithoutDeadline(
  config: JudgmentConfig, method: 'GET' | 'POST', path: string, signal: AbortSignal,
  body?: unknown, extraHeaders?: Readonly<Record<string, string>>,
): Promise<unknown> {
  const base: Fetch = config.fetch ?? ((input, init) => fetch(input, init));
  if (signal.aborted) throw new APIUserAbortError();
  // Local request construction is not a network failure. Only the actual
  // fetch/body-read boundary below may produce a connection error.
  const url = `${config.endpoint.baseURL.replace(/\/$/, '')}${path}`;
  const init = {
    method, redirect: 'error' as const, signal,
    headers: { ...extraHeaders, ...(config.endpoint.authentication !== 'none' && config.endpoint.apiKey ? { Authorization: `Bearer ${config.endpoint.apiKey}` } : {}), Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: body instanceof PreparedBody ? body.text : JSON.stringify(body) }),
  };
  let response: Response;
  let text: string;
  try {
    signal.throwIfAborted();
    response = await interruptible(recordingRequestIds(base)(url, init), signal);
    text = await interruptible(readTextBounded(response, MAX_RESPONSE_BYTES), signal);
  } catch (error) {
    if (signal.aborted) throw new APIUserAbortError(undefined, { cause: error });
    throw new APIConnectionError(error instanceof ResponseTooLargeError ? error.message : 'System One transport failed', { cause: error });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!response.ok) throw APIError.fromResponse(response.status, parsed, response.headers);
  if (parsed === null || typeof parsed !== 'object') throw new JudgmentError('invalid-response', 'System One returned an invalid response body');
  return parsed;
}

export async function systemOneWithoutDeadline<Q extends Questions>(
  config: JudgmentConfig, request: SystemOneRequest<Q> | PreparedBody, signal: AbortSignal,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<SystemOneResult<Q>> {
  return await requestWithoutDeadline(config, 'POST', '/v1/systemone', signal, request, extraHeaders) as SystemOneResult<Q>;
}
