/**
 * Default routing policy, maps notification level + domain verbosity to how
 * loudly it is shown. This is the base layer; the quiet-typing, mode-context
 * and collapse policies can only quieten it.
 */

import type {
  DomainVerbosity,
  NotificationLevel,
  NotificationPresence,
} from '../types.js';

/**
 * Apply the default level-based rule.
 *
 * - `critical` → always `toast`
 * - `warning`  → `toast` if verbosity is `normal` or `verbose`, else `history`
 * - `info`     → `toast` only when verbosity is `verbose`, else `history`
 * - `debug`    → always `history`
 */
export function applyDefaultPolicy(
  level: NotificationLevel,
  verbosity: DomainVerbosity
): NotificationPresence {
  switch (level) {
    case 'critical':
      return 'toast';

    case 'warning':
      return verbosity === 'normal' || verbosity === 'verbose' ? 'toast' : 'history';

    case 'info':
      return verbosity === 'verbose' ? 'toast' : 'history';

    case 'debug':
      return 'history';
  }
}
