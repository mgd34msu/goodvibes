/**
 * Read a child's piped stderr to the end, keeping only the last `maxChars`.
 * An unread pipe fills the OS buffer and blocks the child on its next stderr
 * write; the retained tail also explains a failed handshake or an exit.
 */
export function drainStderrTail(stream: unknown, maxChars = 2000): { tail(): string } {
  let tail = '';
  const readable = stream as ReadableStream<Uint8Array> | null | undefined;
  if (readable && typeof readable.getReader === 'function') {
    const decoder = new TextDecoder();
    const reader = readable.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          tail = (tail + decoder.decode(value, { stream: true })).slice(-maxChars);
        }
      } catch {
        // The child is gone; whatever was read stays as the tail.
      }
    })();
  }
  return { tail: () => tail.trim() };
}
