import { keepAwakeCondition, type PowerState } from '@goodvibes-jev/engine/platform/platform/power';

/**
 * The composer power chip (see shell-surface.ts): it renders on the
 * composer's inner row beside the auto-approve warning, each its own chip
 * that is never dropped for lack of room, since both are safety-relevant and
 * must stay visible at once. Priority order for WHICH power note text to show: the owner
 * keep-awake toggle first (an ALWAYS-ON override the user set explicitly, and
 * per the platform's own PowerManager doc comment the chip, not a timer, is the
 * safety mechanism while it's on), then the automatic work-hold ("held
 * because X"), real state names, never invented. Returns null when neither
 * applies (nothing to show).
 */
export function describePowerStatus(state: Pick<PowerState, 'work' | 'keepAwake'> & Partial<Pick<PowerState, 'sleepEdge'>>): string | null {
  const held = describeHeld(state);
  // The sleep-edge hooks being off (no checkpoint before sleep, no catch-up on
  // wake) is true whatever is held, so it is said beside either note.
  const edge = state.sleepEdge?.note ? `sleep hooks off: ${state.sleepEdge.note}` : null;
  if (held && edge) return `${held}; ${edge}`;
  return held ?? edge;
}

/**
 * The status line's power chip and the full note behind it. The chip names
 * only a state the owner holds or should see at a glance (sleep disabled,
 * keep-awake refused, sleep held); an operational warning (the sleep-edge
 * hooks being off) is never status-bar text, only the notice. The full note
 * is read in the notifications, where it is posted when it changes. Chip null
 * when no state applies; null when nothing applies at all.
 */
export function describePowerChip(state: Pick<PowerState, 'work' | 'keepAwake'> & Partial<Pick<PowerState, 'sleepEdge'>>): { readonly chip: string | null; readonly detail: string } | null {
  const detail = describePowerStatus(state);
  if (detail === null) return null;
  const chip = state.keepAwake.enabled
    ? (keepAwakeCondition(state.keepAwake) === 'refused' ? 'keep-awake refused' : 'sleep disabled')
    : state.work.held && state.work.reasons.length > 0 ? 'sleep held' : null;
  return { chip, detail };
}

function describeHeld(state: Pick<PowerState, 'work' | 'keepAwake'>): string | null {
  if (state.keepAwake.enabled) {
    // On but not holding: the OS refused the inhibitor, so saying "sleep disabled" would be false.
    if (keepAwakeCondition(state.keepAwake) === 'refused') return 'keep-awake refused by the OS: this host can still sleep';
    const base = 'sleep disabled';
    return state.keepAwake.note ? `${base}, ${state.keepAwake.note}` : `${base} (keep-awake)`;
  }
  if (state.work.held && state.work.reasons.length > 0) {
    return `held: ${state.work.reasons.join('; ')}`;
  }
  return null;
}
