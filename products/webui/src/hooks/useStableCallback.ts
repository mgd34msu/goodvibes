import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A callback whose identity never changes but which always runs the latest
 * `fn`. Handed to memoised children so a parent re-render (a keystroke, a
 * streamed token) does not re-render every child for a new closure.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
