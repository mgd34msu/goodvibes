import { useEffect, useState } from 'react';
import { useWebUiPreferences } from '../../lib/ui-preferences';

/**
 * True when motion should be held still: the system asks for it
 * (`prefers-reduced-motion: reduce`) or this browser's "Reduce motion"
 * setting is on (Settings > General).
 */
export function useReducedMotion(): boolean {
  const [preferences] = useWebUiPreferences();
  const [system, setSystem] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setSystem(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return system || preferences.reduceMotion;
}
