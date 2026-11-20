import { drainOwned } from '@goodvibes/judgment/decisions';
import { type JudgmentReadingOptions } from './judgment-authority.js';

export interface RegexAdmissionOptions extends JudgmentReadingOptions {
  readonly operation: string;
  readonly maxPatternChars?: number | undefined;
  readonly maxInputChars?: number | undefined;
  /** Optional execution deadline per operation. Omitted or 0 waits for cancellation. */
  readonly timeoutMs?: number | undefined;
}
export interface RegexMatch {
  readonly captures: readonly (string | undefined)[];
  readonly index: number;
  readonly lastIndex: number;
  readonly groups?: Readonly<Record<string, string | undefined>> | undefined;
  readonly indices?: readonly (readonly [number, number] | undefined)[] | undefined;
}
/** An observation plus an isolated executor, never a native executable RegExp. */
export interface AdmittedRegex extends AsyncDisposable {
  assertCurrent(): void;
  test(input: string, maxInputChars?: number): Promise<boolean>;
  matchingLines(input: string, maxInputChars?: number): Promise<readonly number[]>;
  exec(input: string, lastIndex?: number, maxInputChars?: number): Promise<RegexMatch | null>;
  replace(input: string, replacement: string, maxInputChars?: number): Promise<string>;
  positions(input: string, maxInputChars?: number): Promise<readonly { start: number; end: number }[]>;
}

const ALLOWED_FLAGS = /^[dgimsuvy]*$/;
export class RegexAdmissionError extends Error {
  constructor(operation: string, reason: string) { super(`${operation} regex held: ${reason}`); this.name = 'RegexAdmissionError'; }
}
function limit(value: number | undefined, fallback: number, ceiling: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > ceiling) throw new Error('Invalid regex mechanical limit');
  return result;
}
function syntax(source: string, flags: string, options: RegexAdmissionOptions): void {
  const maximum = limit(options.maxPatternChars, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (source.length > maximum) throw new Error(`${options.operation} regex exceeds ${maximum} characters`);
  if (!ALLOWED_FLAGS.test(flags) || new Set(flags).size !== flags.length) throw new Error(`${options.operation} regex flags are invalid`);
  // Compilation checks grammar only. No operator expression runs on this thread.
  void new RegExp(source, flags);
}

/**
 * Deprecated synchronous compatibility only. Production callers use admitRegex.
 * These legacy vetoes preserve the historical API; they are NOT a safety proof.
 */
export function compileLegacyRegex(source: string, flags: string, options: RegexAdmissionOptions): RegExp {
  const maximum = options.maxPatternChars ?? 512;
  if (source.length > maximum) throw new Error(`${options.operation} regex exceeds ${maximum} characters`);
  if (!ALLOWED_FLAGS.test(flags) || new Set(flags).size !== flags.length) throw new Error(`${options.operation} regex flags are invalid`);
  const checks: readonly [RegExp, string][] = [
    [/(^|[^\\])\\[1-9]/, 'backreferences are not allowed in operator-supplied regular expressions'],
    [/\((?:[^()\\]|\\.)*[+*{][^)]*\)\s*[+*{]/, 'nested quantified groups are not allowed'],
    [/\.\*(?:[^|)]{0,64})\.\*/, 'multiple wildcard repeats in one expression are not allowed'],
  ];
  for (const [pattern, reason] of checks) if (pattern.test(source)) throw new Error(`${options.operation} regex rejected: ${reason}`);
  return new RegExp(source, flags);
}

// One small self-contained program works in Web Workers (including Bun) and
// node:worker_threads. No source interpolation, executable input or asset URL.
const PROGRAM = String.raw`
const advance = (input, index, unicode) => unicode && index + 1 < input.length && input.charCodeAt(index) >= 0xd800 && input.charCodeAt(index) <= 0xdbff && input.charCodeAt(index + 1) >= 0xdc00 && input.charCodeAt(index + 1) <= 0xdfff ? index + 2 : index + 1;
function execute(message) {
  const { source, flags, input, operation, replacement, lastIndex } = message;
  const regex = new RegExp(source, flags);
  regex.lastIndex = lastIndex || 0;
  if (operation === 'test') return regex.test(input);
  if (operation === 'matchingLines') {
    const lines = input.split('\n'), matches = [];
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) matches.push(i);
    }
    return matches;
  }
  if (operation === 'exec') {
    const match = regex.exec(input);
    if (!match) return null;
    return { captures: Array.from(match), index: match.index, lastIndex: regex.lastIndex, groups: match.groups, indices: match.indices };
  }
  if (operation === 'positions') {
    const positions = [];
    let match;
    while ((match = regex.exec(input)) !== null) {
      positions.push({ start: match.index, end: match.index + match[0].length });
      if (!regex.global && !regex.sticky) break;
      if (!match[0].length) regex.lastIndex = advance(input, regex.lastIndex, regex.unicode || regex.unicodeSets);
    }
    return positions;
  }
  if (operation !== 'replace') throw Error('unknown operation');
  return input.replace(regex, replacement);
}
function receive(message, send) {
  try { const result = execute(message); send({ id: message.id, result }); }
  catch { send({ id: message.id, error: true }); }
}
`;
interface WorkerPort {
  post(value: unknown): void;
  stop(): void;
  /** Lets the process exit while this worker is idle; a no-op where the host has no such call. */
  detach(): void;
}
interface NodeWorkerPort {
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  on(event: 'message', listener: (value: unknown) => void): this;
  on(event: 'error' | 'messageerror' | 'exit', listener: () => void): this;
}
interface NodeWorkerModule {
  readonly Worker: new (source: string, options: {
    readonly eval: true;
  }) => NodeWorkerPort;
}
async function createWorker(receive: (value: unknown) => void, failed: () => void): Promise<WorkerPort> {
  if (typeof Worker !== 'undefined') {
    const url = URL.createObjectURL(new Blob([PROGRAM, '\nonmessage = event => receive(event.data, value => postMessage(value));'], { type: 'text/javascript' }));
    try {
      const worker = new Worker(url);
      worker.onmessage = event => receive(event.data);
      worker.onerror = failed;
      worker.onmessageerror = failed;
      let stopped = false;
      return { post: value => worker.postMessage(value), stop: () => { if (stopped) return; stopped = true; URL.revokeObjectURL(url); worker.terminate(); },
        detach: () => { (worker as unknown as { unref?: () => void }).unref?.(); } };
    } catch (error) { URL.revokeObjectURL(url); throw error; }
  }
  if (typeof window !== 'undefined' || 'WorkerGlobalScope' in globalThis) throw new Error('Isolated regex workers are unavailable in this browser');
  // Same browser-guarded indirect import convention as transport-core/otel.ts.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const { Worker: NodeWorker } = await (new Function('m', 'return import(m)')('node:worker_threads') as Promise<NodeWorkerModule>);
  const worker = new NodeWorker(PROGRAM + '\nconst { parentPort } = require("node:worker_threads"); parentPort.on("message", message => receive(message, value => parentPort.postMessage(value)));', {
    eval: true,
  });
  worker.on('message', receive); worker.on('error', failed); worker.on('messageerror', failed); worker.on('exit', failed);
  let stopped = false;
  return { post: value => worker.postMessage(value), stop: () => { if (stopped) return; stopped = true; void worker.terminate(); },
    detach: () => { (worker as unknown as { unref?: () => void }).unref?.(); } };
}

/** A long-lived isolated tester for many patterns, owned by one long-lived holder (a tool registry, the permission rules). */
export interface SharedRegexTester extends AsyncDisposable {
  test(source: string, input: string, signal?: AbortSignal, flags?: string): Promise<boolean>;
}

/**
 * One isolated worker that tests any number of patterns, started on first use
 * and kept for the holder's life. A pattern that runs past `timeoutMs` or a
 * worker failure stops the worker and refuses every test in flight; the next
 * test starts a fresh one. Each distinct source and flag set is
 * compiled once on this thread (grammar, flags and `maxPatternChars` only)
 * before it is sent. A cancelled
 * test is refused alone; the worker keeps serving the other tests. The idle
 * worker never keeps the process alive: only a test in flight does, through
 * its deadline timer.
 */
export function createSharedRegexTester(options: {
  readonly operation: string; readonly timeoutMs?: number | undefined; readonly maxPatternChars?: number | undefined;
}): SharedRegexTester {
  const operation = options.operation;
  const timeoutMs = limit(options.timeoutMs, 0, Number.MAX_SAFE_INTEGER);
  const maxPatternChars = options.maxPatternChars;
  const checked = new Set<string>();
  let disposed = false, sequence = 0;
  let worker: Promise<WorkerPort> | undefined;
  const pending = new Map<number, { resolve(value: boolean): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> | undefined }>();
  const reset = (reason: string) => {
    const current = worker;
    worker = undefined;
    void current?.then(port => port.stop(), () => {});
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new RegexAdmissionError(operation, reason)); }
    pending.clear();
  };
  const receive = (value: unknown) => {
    const response = value as { id?: number; result?: unknown; error?: boolean } | null;
    const item = response && typeof response.id === 'number' ? pending.get(response.id) : undefined;
    if (!item) return;
    pending.delete(response!.id!); clearTimeout(item.timer);
    if (response!.error) item.reject(new RegexAdmissionError(operation, 'the pattern could not run'));
    else item.resolve(response!.result === true);
  };
  const port = () => worker ??= createWorker(receive, () => reset('isolated worker stopped')).then(started => { started.detach(); return started; });
  return Object.freeze({
    async test(source: string, input: string, signal?: AbortSignal, flags = ''): Promise<boolean> {
      if (disposed) throw new RegexAdmissionError(operation, 'executor is closed');
      signal?.throwIfAborted();
      const key = `${flags}/${source}`;
      if (!checked.has(key)) { syntax(source, flags, { operation, maxPatternChars }); checked.add(key); }
      let started: WorkerPort;
      try { started = await port(); } catch { worker = undefined; throw new RegexAdmissionError(operation, 'isolated worker startup is unavailable'); }
      signal?.throwIfAborted();
      const id = ++sequence;
      return new Promise<boolean>((resolve, reject) => {
        // A cancelled test is refused on its own; the worker keeps serving the others.
        const onAbort = () => { const item = pending.get(id); if (!item) return; pending.delete(id); clearTimeout(item.timer); item.reject(new RegexAdmissionError(operation, 'cancelled')); };
        const settle = { resolve: (value: boolean) => { signal?.removeEventListener('abort', onAbort); resolve(value); },
          reject: (error: Error) => { signal?.removeEventListener('abort', onAbort); reject(error); },
          timer: timeoutMs > 0 ? setTimeout(() => reset(`exceeded its ${timeoutMs} ms deadline`), timeoutMs) : undefined };
        pending.set(id, settle);
        signal?.addEventListener('abort', onAbort, { once: true });
        started.post({ id, source, flags, operation: 'test', input, lastIndex: 0, replacement: '' });
      });
    },
    async [Symbol.asyncDispose]() { disposed = true; reset('executor closed'); },
  });
}

/** No cache: one exact pattern/configuration and one installed/request lifetime. */
export async function admitRegex(source: string, flags: string, options: RegexAdmissionOptions): Promise<AdmittedRegex> {
  const operation = options.operation;
  syntax(source, flags, options);
  const maximum = limit(options.maxInputChars, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  // Execute off-thread until completion or cancellation, under the caller's ownership.
  const callerCurrent = options.assertCurrent;
  const signal = options.signal ?? new AbortController().signal;
  const owner = { signal, assertCurrent: () => {
    signal.throwIfAborted();
    const result: unknown = callerCurrent?.();
    if (result !== undefined) { drainOwned(result); throw new RegexAdmissionError(operation, 'asynchronous owner check'); }
    signal.throwIfAborted();
  } };
  owner.assertCurrent();
  const timeoutMs = limit(options.timeoutMs, 0, Number.MAX_SAFE_INTEGER);
  let retired = false, sequence = 0;
  let activeId: number | undefined;
  let worker: WorkerPort | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>; request: unknown }>();
  const pump = () => {
    if (retired || activeId !== undefined) return;
    const next = pending.entries().next();
    if (next.done) return;
    const [id, item] = next.value;
    activeId = id;
    if (timeoutMs > 0) item.timer = setTimeout(stop, timeoutMs);
    try { owner.assertCurrent(); worker!.post(item.request); } catch { stop(); }
  };
  const stop = () => {
    if (retired) return;
    retired = true; owner.signal.removeEventListener('abort', stop); worker?.stop();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new RegexAdmissionError(operation, 'executor retired, cancelled or exceeded its deadline')); }
    pending.clear();
  };
  owner.signal.addEventListener('abort', stop, { once: true });
  if (owner.signal.aborted) stop();
  try {
    worker = await createWorker(value => {
      try {
        owner.assertCurrent();
        if (!value || typeof value !== 'object') { stop(); return; }
        const response = value as { id: number; result?: unknown; error?: boolean };
        const item = pending.get(response.id);
        if (!item || response.id !== activeId || response.error) { stop(); return; }
        pending.delete(response.id); clearTimeout(item.timer); item.resolve(response.result);
        activeId = undefined; pump();
      } catch { stop(); }
    }, stop);
    owner.assertCurrent();
    if (retired) { worker.stop(); throw new RegexAdmissionError(operation, 'executor retired'); }
  } catch { worker?.stop(); stop(); throw new RegexAdmissionError(operation, 'isolated worker startup is unavailable'); }
  let yieldAt = performance.now() + 4;
  const call = async <T>(kind: string, input: string, lastIndex = 0, replacement = '', inputLimit = maximum): Promise<T> => {
    // A bad argument is that call's own mistake: it is refused here, before the
    // executor is involved, so a caller that handles the refusal (an oversize
    // file in a search over many) can keep using the same admitted expression.
    // Only an executor failure, a deadline or a change of owner retires it.
    const bound = limit(inputLimit, maximum, maximum);
    if (input.length > bound) throw new RegexAdmissionError(operation, `input exceeds ${bound} characters`);
    if (!Number.isSafeInteger(lastIndex) || lastIndex < 0) throw new RegexAdmissionError(operation, 'invalid operation input');
    try {
      // Worker replies can continuously replenish the message/microtask queue
      // during a line-by-line search. Give input and timers a turn as well.
      if (performance.now() >= yieldAt) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        yieldAt = performance.now() + 4;
      }
      owner.assertCurrent();
      if (retired) throw new RegexAdmissionError(operation, 'executor is unavailable');
      const id = ++sequence;
      const result = await new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: value => resolve(value as T), reject, request: { id, source, flags, operation: kind, input, lastIndex, replacement } });
        pump();
      });
      owner.assertCurrent();
      if (retired) throw new RegexAdmissionError(operation, 'executor retired');
      return result;
    } catch (error) { stop(); throw error; }
  };
  return Object.freeze({
    assertCurrent: () => { owner.assertCurrent(); if (retired) throw new RegexAdmissionError(operation, 'executor retired'); },
    test: (input: string, cap?: number) => call<boolean>('test', input, 0, '', cap),
    matchingLines: (input: string, cap?: number) => call<readonly number[]>('matchingLines', input, 0, '', cap),
    exec: (input: string, lastIndex = 0, cap?: number) => call<RegexMatch | null>('exec', input, lastIndex, '', cap),
    replace: (input: string, replacement: string, cap?: number) => call<string>('replace', input, 0, replacement, cap),
    positions: (input: string, cap?: number) => call<readonly { start: number; end: number }[]>('positions', input, 0, '', cap),
    [Symbol.asyncDispose]: async () => { stop(); },
  });
}
