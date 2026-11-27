/**
 * outside-every-call.ts, the process's own context: the one a timer, an interval, a queue's worker or a lazy
 * singleton is armed in, wherever it is first made.
 *
 * Every per-call store (the untrusted-content window, the turn record, whose input a turn acts on, the project a
 * decision is made for, a file's maker, a call's context) is an AsyncLocalStorage, and a timer runs every one of its
 * callbacks in the context it was armed in. One armed inside a request (the first trigger made, the first schedule
 * added) would run every later check and every run it starts as that request: in its untrusted-content window, as its
 * caller. Armed through {@link outsideEveryCall} it runs with no caller's context, and what it serves takes its project
 * and its party from the record it serves (a trigger's, a schedule's).
 *
 * The context is taken when this module is first evaluated: at the process's start, in its static import graph, before
 * any request (the trigger supervisor, the schedules and the watchers import it).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const processContext = AsyncLocalStorage.snapshot();

/** Runs `fn` (arming a timer, starting a worker, making a long-lived singleton) in the process's own context. */
export function outsideEveryCall<T>(fn: () => T): T {
  return processContext(fn);
}
