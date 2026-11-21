import { GoodVibesError, categoryForCode, structuredTransience } from '@goodvibes/engine/errors';

export function isAbortError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'name' in error
      && (error as { readonly name?: unknown }).name === 'AbortError',
  );
}

export function describeUnknownTransportError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean' || error === null || error === undefined) {
    return String(error);
  }
  if (typeof error !== 'object') return String(error);

  const record = error as Record<string, unknown>;
  const nested = record.error;
  const nestedMessage = nested instanceof Error
    ? nested.message
    : nested && typeof nested === 'object' && typeof (nested as { readonly message?: unknown }).message === 'string'
      ? (nested as { readonly message: string }).message
      : undefined;
  const target = record.target && typeof record.target === 'object'
    ? `[target:${(record.target as { readonly constructor?: { readonly name?: string } }).constructor?.name ?? 'object'}]`
    : undefined;
  const fields = [
    typeof record.name === 'string' ? `name=${record.name}` : undefined,
    typeof record.type === 'string' ? `type=${record.type}` : undefined,
    typeof record.message === 'string' ? `message=${record.message}` : undefined,
    typeof record.reason === 'string' ? `reason=${record.reason}` : undefined,
    typeof record.code === 'number' ? `code=${record.code}` : undefined,
    nestedMessage ? `error=${nestedMessage}` : undefined,
    target,
  ].filter(Boolean);
  return fields.length > 0 ? fields.join(' ') : Object.prototype.toString.call(error);
}

export function transportErrorFromUnknown(error: unknown, context: string): Error {
  if (error instanceof Error) return error;
  const code = typeof error === 'object'
    && error !== null
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : undefined;
  // The category and retryability come from the one connection-code table
  // (Node errno, Bun's fetch codes, undici's) and the one transience decision.
  // Anything they do not recognise (a programmer error wrapped as a non-Error
  // object, say) is not recoverable, so it does not start a retry loop.
  return new GoodVibesError(`${context}: ${describeUnknownTransportError(error)}`, {
    category: categoryForCode(code) ?? 'network',
    source: 'transport',
    recoverable: structuredTransience(error)?.failureClass === 'retryable',
  });
}

/**
 * A streamed body lost chunks in transit (a relay's bounded send buffer
 * overflowed for a slow reader). The body ends with this error instead of
 * carrying on with a hole in it, and nothing is written into the body to say
 * so: the reader sees the loss as a typed end and recovers (an event stream
 * reconnects from its last event id; any other stream reports it incomplete).
 */
export class StreamGapError extends GoodVibesError {
  readonly dropped: number;

  constructor(dropped: number) {
    super(`The stream lost ${dropped} chunk(s) in transit because this reader fell behind.`, {
      code: 'STREAM_GAP',
      category: 'protocol',
      source: 'transport',
      recoverable: true,
      hint: 'Reopen the stream from its last position, or re-read current state.',
    });
    // Named explicitly: a minifier may rename the class, and readers match on the name.
    this.name = 'StreamGapError';
    this.dropped = dropped;
  }
}

/** The dropped count a {@link StreamGapError} carries (read structurally, across realms), or undefined. */
export function readStreamGapDropped(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { readonly name?: unknown; readonly dropped?: unknown };
  return record.name === 'StreamGapError' && typeof record.dropped === 'number' ? record.dropped : undefined;
}
