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

/**
 * Command handlers report most failures by printing and returning normally rather than
 * throwing, so a workspace that ran a command can only tell it failed from what it printed.
 * A line opening with one of these words, or a first line that says "failed", counts.
 */
// "usage:" ends in a colon, so it cannot sit inside a \b group: no word boundary follows a colon.
const FAILURE_LINE_START = /^(usage:|(error|failed|unknown|invalid|cannot|could not|refused|refusing|not found|missing)\b|no\b.*\bnamed\b)/i;
const FAILURE_FIRST_LINE = /\bfailed\b/i;

export function capturedOutputReportsFailure(lines: readonly string[]): boolean {
  const meaningful = lines.flatMap((text) => text.split('\n')).filter((line) => line.trim().length > 0);
  if (meaningful.length === 0) return false;
  if (FAILURE_FIRST_LINE.test(meaningful[0]!)) return true;
  return meaningful.some((line) => FAILURE_LINE_START.test(line));
}

/** The line that says why a command failed: the first failure-looking line, else the first line. */
export function firstFailureLine(lines: readonly string[]): string {
  const meaningful = lines.flatMap((text) => text.split('\n')).map((line) => line.trim()).filter((line) => line.length > 0);
  return meaningful.find((line) => FAILURE_LINE_START.test(line) || FAILURE_FIRST_LINE.test(line)) ?? meaningful[0] ?? 'the command reported a failure';
}
