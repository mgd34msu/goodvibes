import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools/input-projection';
import { captureCatalogData } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-data';
import { type CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';

const ALLOWED_OPTIONS: readonly string[] = ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource', 'semantic'];

/**
 * A reader's view of its call: the arguments captured once as a frozen copy,
 * and one answer to "is this call still wanted", the call's AbortSignal plus
 * the caller's own check, each run once per check. The caller's check is
 * handed to nested readers unchanged, so a check at the bottom of any number
 * of readers costs the same as one at the top. A frozen copy cannot change, so
 * nothing re-compares it, and a status read keeps no list of source re-reads:
 * it is correct for the moment it was taken.
 */
export function captureAsyncHarnessInput<T>(rawArgs: T, options: CatalogRankingOptions, _retainAtPublication = false, _initialGuards: readonly (() => void)[] = []) {
  if (Reflect.ownKeys(options).some(key => typeof key !== 'string' || !ALLOWED_OPTIONS.includes(key))) throw new ToolInputProjectionError('invalid');
  const signal = options.signal, callerCurrent = options.assertCurrent;
  if (callerCurrent !== undefined && typeof callerCurrent !== 'function') throw new ToolInputProjectionError('invalid');
  const assertCurrent = (): void => { signal?.throwIfAborted(); callerCurrent?.(); };
  const checkSignal = (): void => { signal?.throwIfAborted(); };
  assertCurrent();
  const args = captureCatalogData(rawArgs);
  // Kept so existing readers can still name what they read; nothing is re-read on a later check.
  const retainCurrent = (_guard: () => void, _key?: string): void => { checkSignal(); };
  const retainSourceCurrent = (_key?: string): void => { checkSignal(); };
  return { args, assertCurrent, assertCallerCurrent: assertCurrent, assertInputCurrent: checkSignal, assertSourceCurrent: checkSignal, retainSourceCurrent,
    options: { signal, sourceOwner: options.sourceOwner, assertCurrent: callerCurrent ?? checkSignal, retainCurrent,
      ...(options.requirePreservedSource !== undefined ? { requirePreservedSource: options.requirePreservedSource } : {}),
      // A caller that asked for a reading of meaning keeps it through the capture.
      ...(options.semantic !== undefined ? { semantic: options.semantic } : {}) } satisfies CatalogRankingOptions };
}
