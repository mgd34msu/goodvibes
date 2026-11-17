/**
 * Quiet-while-typing policy, keeps non-critical notifications off the screen
 * while the user is composing input, so nothing pops up mid-keystroke. They
 * are still kept in the history.
 */

import type { NotificationLevel, NotificationPresence } from '../types.js';

/**
 * Whether a notification that would toast is held in the history instead
 * because the user is typing. Critical notifications always toast.
 *
 * @returns The suppression reason when held, undefined otherwise.
 */
export function applyQuietTypingPolicy(
  level: NotificationLevel,
  presence: NotificationPresence,
  quietEnabled: boolean
): string | undefined {
  if (!quietEnabled || level === 'critical' || presence === 'history') return undefined;
  return 'quiet_while_typing';
}
