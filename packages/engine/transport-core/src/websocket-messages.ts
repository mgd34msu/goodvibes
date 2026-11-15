import { GoodVibesError } from '@goodvibes-jev/engine/errors';

/** Logical messages are split into small frames; frame size is not a work limit. */
export const WEBSOCKET_CHUNK_CHARS = 64 * 1024;
/** Largest logical message either side will carry; the receiver refuses to buffer more than this. */
export const WEBSOCKET_MAX_MESSAGE_CHARS = 64 * 1024 * 1024;
export function* encodeWebSocketMessage(text: string): Generator<string> {
  if (text.length > WEBSOCKET_MAX_MESSAGE_CHARS) {
    throw new GoodVibesError(`WebSocket message of ${text.length} characters exceeds the ${WEBSOCKET_MAX_MESSAGE_CHARS} character limit`, {
      category: 'bad_request', source: 'transport', code: 'WEBSOCKET_MESSAGE_TOO_LARGE', recoverable: false,
      state: 'not sent', next: ['Send the content in smaller parts, or attach it as a file'],
    });
  }
  if (text.length <= WEBSOCKET_CHUNK_CHARS) { yield text; return; }
  const id = crypto.randomUUID();
  for (let offset = 0, index = 0; offset < text.length; offset += WEBSOCKET_CHUNK_CHARS, index++) {
    yield JSON.stringify({ type: 'chunk', id, index, final: offset + WEBSOCKET_CHUNK_CHARS >= text.length, data: text.slice(offset, offset + WEBSOCKET_CHUNK_CHARS) });
  }
}

/** One ordered connection owns one partial message. Never share across reconnects. */
export class WebSocketMessageAssembler {
  private id: string | undefined;
  private parts: string[] = [];
  private chars = 0;
  reset(): void { this.id = undefined; this.parts = []; this.chars = 0; }
  accept(frame: unknown): unknown | undefined {
    if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'chunk') return frame;
    const chunk = frame as Record<string, unknown>;
    if (typeof chunk.id !== 'string' || !Number.isSafeInteger(chunk.index) || typeof chunk.data !== 'string' || typeof chunk.final !== 'boolean'
      || chunk.data.length > WEBSOCKET_CHUNK_CHARS || chunk.index !== this.parts.length || (this.id !== undefined && chunk.id !== this.id)) {
      this.reset(); throw new Error('Invalid or out-of-order WebSocket chunk');
    }
    if (this.chars + chunk.data.length > WEBSOCKET_MAX_MESSAGE_CHARS) {
      this.reset();
      throw new GoodVibesError(`WebSocket message exceeds the ${WEBSOCKET_MAX_MESSAGE_CHARS} character limit`, {
        category: 'protocol', source: 'transport', code: 'WEBSOCKET_MESSAGE_TOO_LARGE', recoverable: false,
        state: 'the partial message was discarded', next: ['Send the content in smaller parts, or attach it as a file'],
      });
    }
    this.id = chunk.id;
    this.chars += chunk.data.length;
    this.parts.push(chunk.data);
    if (!chunk.final) return undefined;
    const text = this.parts.join('');
    this.reset();
    return JSON.parse(text) as unknown;
  }
}

/** Pause native writes at a high-water mark; producers await delivery or cancellation. */
export async function sendWebSocketMessage(
  socket: { send(data: string): unknown; readonly bufferedAmount?: number; getBufferedAmount?(): number; readonly readyState?: number },
  text: string, signal?: AbortSignal,
): Promise<void> {
  for (const frame of encodeWebSocketMessage(text)) {
    signal?.throwIfAborted();
    assertOpen(socket);
    while ((socket.getBufferedAmount?.() ?? socket.bufferedAmount ?? 0) > 4 * 1024 * 1024) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('WebSocket send cancelled')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 10);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
      assertOpen(socket);
    }
    // Bun returns 0 when it dropped the message; undefined or a positive/-1 count means it was accepted.
    if (socket.send(frame) === 0) throw new Error('WebSocket dropped an outgoing message');
  }
}

const WEBSOCKET_OPEN = 1;
function assertOpen(socket: { readonly readyState?: number }): void {
  if (socket.readyState !== undefined && socket.readyState !== WEBSOCKET_OPEN) throw new Error('WebSocket closed before the message was sent');
}
