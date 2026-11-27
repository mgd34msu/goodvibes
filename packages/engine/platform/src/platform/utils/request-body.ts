export const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_000_000;

/**
 * The most of a refused body that is still read off the wire to keep the
 * connection reusable. A sender past this is cancelled: draining without a
 * bound would let a refused request cost as much bandwidth and connection time
 * as an accepted one.
 */
export const MAX_REFUSED_BODY_DRAIN_BYTES = 8_000_000;

/**
 * Reads and discards the remainder of a request body reader.
 *
 * Bun (and Node) keep-alive connection reuse depends on the previous
 * request's body having been fully read off the wire, `stream.cancel()`
 * signals "stop delivering chunks to me" but does not, in practice, drain the
 * underlying connection buffer, which leaves the NEXT request on a reused
 * connection stalled for several seconds waiting for the runtime to notice
 * the connection is actually free (observed directly against a bare
 * `Bun.serve()` with no platform code involved). Actively reading-and-discarding
 * the rest of the body is the correct fix: it costs a little time
 * proportional to the bytes the caller already sent, but leaves the
 * connection immediately reusable. Best-effort, a drain failure must not
 * mask the caller's own response/error.
 */
async function drainReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    let drained = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      drained += value?.byteLength ?? 0;
      if (drained > MAX_REFUSED_BODY_DRAIN_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    // Best-effort.
  }
}

async function drainBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  try {
    await drainReader(reader);
  } finally {
    reader.releaseLock();
  }
}

function payloadTooLargeResponse(maxBytes: number): Response {
  // Honest refusal: state the actual limit rather than a bare "too large",
  // a caller (browser composer, webhook sender, etc.) needs the number to
  // decide whether to retry with a different transport (e.g. the artifact
  // multipart/raw-body upload path) or shrink the payload.
  return Response.json({ error: `Payload exceeds the ${maxBytes}-byte limit.` }, { status: 413 });
}

export async function readTextBodyWithinLimit(
  req: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<string | Response> {
  const contentLength = Number.parseInt(req.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await drainBody(req.body);
    return payloadTooLargeResponse(maxBytes);
  }

  if (!req.body) return '';
  // A declared length within the limit bounds what is read: the body is taken whole. A reader is used only for a body
  // of no declared length (its size known only as it arrives): bun keeps a request whose body was read through a
  // reader alive for good when that body is not off the wire (a request the daemon makes in process), so every such
  // call would be kept.
  if (req.headers.has('content-length') && Number.isFinite(contentLength) && contentLength <= maxBytes) {
    const text = await req.text();
    return Buffer.byteLength(text) > maxBytes ? payloadTooLargeResponse(maxBytes) : text;
  }
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Keep reading (and discarding) the rest of this oversized body
        // rather than cancelling, see drainReader's doc comment.
        await drainReader(reader);
        return payloadTooLargeResponse(maxBytes);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

export async function readJsonBodyWithinLimit(
  req: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<unknown | Response> {
  const raw = await readTextBodyWithinLimit(req, maxBytes);
  if (raw instanceof Response) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
