import type { HookResult } from './types.js';

/** Optional ownership context for an admitted hook invocation. */
export interface HookExecutionOptions {
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_TIMEOUT_SECONDS: Readonly<Record<string, number>> = { agent: 60 };
const FALLBACK_TIMEOUT_SECONDS = 30;

/**
 * The deadline, in seconds, a hook runs under: its own `timeout` when set
 * (0 asks for no deadline), otherwise 30s (60s for an agent hook). Every
 * runner reads it here so the documented default is the one that applies.
 */
export function hookTimeoutSeconds(hook: { readonly timeout?: number | undefined }, kind: string): number {
  const own = hook.timeout;
  if (typeof own === 'number' && Number.isFinite(own) && own >= 0) return own;
  return DEFAULT_TIMEOUT_SECONDS[kind] ?? FALLBACK_TIMEOUT_SECONDS;
}

/** How long a hook has to stop after its deadline passed or its turn was cancelled. */
export const HOOK_STOP_GRACE_MS = 2_000;

/**
 * The one rule for waiting on a hook. Its work is joined until it settles, or
 * until its deadline (`timeoutSeconds`, 0 = none) or `signal` asks it to stop
 * and it then does not stop within {@link HOOK_STOP_GRACE_MS}. Past that the
 * work is left running, and the join answers a failed result that says so, so
 * neither a turn nor its cancellation waits on a hook that ignores its signal.
 */
export function joinHookWithin(
  work: Promise<HookResult>,
  options: { readonly name: string; readonly timeoutSeconds: number; readonly signal?: AbortSignal | undefined },
): Promise<HookResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const leftRunning = new Promise<HookResult>((settle) => {
    const giveUp = (why: string) => {
      if (timer !== undefined) return;
      timer = setTimeout(() => settle({
        ok: false,
        error: `Hook ${options.name} did not stop ${HOOK_STOP_GRACE_MS / 1000} s after ${why} and was left running.`,
      }), HOOK_STOP_GRACE_MS);
      timer.unref?.();
    };
    if (options.timeoutSeconds > 0) {
      deadline = setTimeout(() => giveUp(`its ${options.timeoutSeconds} s deadline`), options.timeoutSeconds * 1000);
      deadline.unref?.();
    }
    onAbort = () => giveUp('it was asked to stop');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
  return Promise.race([work, leftRunning]).finally(() => {
    clearTimeout(timer); clearTimeout(deadline);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  });
}

/**
 * A hook deadline requests cancellation through the signal; the caller's join
 * ({@link joinHookWithin}) bounds how long an operation that ignores it is
 * waited for.
 */
export function createHookExecution(
  options: HookExecutionOptions,
  timeoutSeconds: number,
  kind: string,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = timeoutSeconds > 0 ? setTimeout(() => {
    controller.abort(new Error(`${kind} hook timed out after ${timeoutSeconds}s`));
  }, timeoutSeconds * 1000) : undefined;
  timer?.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}
