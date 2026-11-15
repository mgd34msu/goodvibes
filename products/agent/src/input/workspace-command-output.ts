import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Capturing what a command prints. A command reports most outcomes by printing through
 * `context.print`, which is one shared function, so capture must not leave a stub behind or
 * swallow output that belongs to something else:
 *  - one dispatcher is installed per context while any capture is open and the original is put
 *    back when the last one ends, whatever order they end in;
 *  - a line is captured only when it is printed from inside the captured command's own async
 *    chain; a background notice printed meanwhile still reaches the transcript.
 */
const captureSink = new AsyncLocalStorage<string[]>();
const openCaptures = new WeakMap<object, { readonly original: (text: string) => void; readonly dispatcher: (text: string) => void; count: number }>();

export type CapturedCommand<T> =
  | { readonly ok: true; readonly value: T; readonly lines: readonly string[] }
  | { readonly ok: false; readonly error: unknown; readonly lines: readonly string[] };

/** Run `run` and return its outcome together with everything it printed through `context.print`. */
export function captureCommandPrint<T>(context: { print: (text: string) => void }, run: () => Promise<T>): Promise<CapturedCommand<T>> {
  let open = openCaptures.get(context);
  if (!open) {
    const original = context.print;
    const dispatcher = (text: string): void => {
      const sink = captureSink.getStore();
      if (sink) sink.push(text);
      else original(text);
    };
    open = { original, dispatcher, count: 0 };
    openCaptures.set(context, open);
    context.print = dispatcher;
  }
  const entry = open;
  entry.count += 1;
  const lines: string[] = [];
  return (async (): Promise<CapturedCommand<T>> => {
    try {
      return { ok: true, value: await captureSink.run(lines, run), lines };
    } catch (error) {
      return { ok: false, error, lines };
    } finally {
      entry.count -= 1;
      if (entry.count === 0) {
        if (context.print === entry.dispatcher) context.print = entry.original;
        openCaptures.delete(context);
      }
    }
  })();
}
