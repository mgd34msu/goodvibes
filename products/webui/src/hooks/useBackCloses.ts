/**
 * Back closes an open detail before it leaves the view.
 *
 * While `open`, the detail has a history entry of its own: the same address,
 * marked in `history.state`. The browser's Back (or a phone's back gesture) pops
 * that entry and the detail closes; the view stays. A detail closed another way
 * (its close button, Escape, the view's own Back button) takes its entry back off
 * so the next Back is not spent on nothing. Opening another item while one is
 * open keeps the one entry.
 *
 * Cost: one history entry while a detail is open; no request.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

const MARK = 'gvDetail';

function markOf(state: unknown): unknown {
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[MARK] : undefined;
}

let nextMark = 0;

export function useBackCloses(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    nextMark += 1;
    const mark = `detail-${String(nextMark)}`;
    const base: unknown = window.history.state;
    window.history.pushState({ ...(typeof base === 'object' && base !== null ? base : {}), [MARK]: mark }, '', window.location.href);
    let popped = false;
    function onPopState(): void {
      if (markOf(window.history.state) === mark) return;
      popped = true;
      closeRef.current();
    }
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (!popped && markOf(window.history.state) === mark) window.history.back();
    };
  }, [open]);
}
