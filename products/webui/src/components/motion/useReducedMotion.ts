import { useWebUiPreferences } from '../../lib/ui-preferences';

/**
 * True when motion should be held still: this browser's "Reduce motion"
 * setting is on (Settings > General). It is off unless the person turns it
 * on and follows nothing else, not the operating system's preference.
 */
export function useReducedMotion(): boolean {
  const [preferences] = useWebUiPreferences();
  return preferences.reduceMotion;
}
