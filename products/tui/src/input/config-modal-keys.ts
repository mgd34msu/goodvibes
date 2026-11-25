/**
 * How a config-modal action key is pressed. A typed character always goes to
 * the modal's search row, so an action fires from Enter (or another named key)
 * or from a chord: Ctrl plus the action's letter, or the leader Ctrl+G
 * followed by the key. The leader exists because most terminals cannot send
 * some chords as themselves: Ctrl+C is the app's cancel, Ctrl+H, I, J and M
 * arrive as Backspace, Tab and Enter, and Ctrl with a digit or a capital sends
 * nothing distinct.
 */

/** Letters whose Ctrl chord does not reach the modal as itself. */
const NO_DIRECT_CHORD = new Set(['c', 'h', 'i', 'j', 'm']);

/** The leader's letter: Ctrl+G arms the next typed key as an action key. */
export const CONFIG_MODAL_ACTION_LEADER = 'g';

/** True for a one-character action key that fires from its own Ctrl chord. */
export function hasDirectChord(key: string): boolean {
  return /^[a-z]$/.test(key) && key !== CONFIG_MODAL_ACTION_LEADER && !NO_DIRECT_CHORD.has(key);
}

/** The leader as the key table binds it ("Ctrl+G"), set by the shell each frame (the leader is rebindable). */
let leaderLabel = 'Ctrl+G';

/** Keep the labels below in step with the bound leader; an unbound leader keeps the last label. */
export function setConfigModalLeaderLabel(label: string | undefined): void {
  if (label && label !== '(unbound)') leaderLabel = label;
}

/** The leader as a short keycap: `^G` for a Ctrl chord, else the label as typed. */
function leaderCap(): string {
  const ctrl = /^Ctrl\+(.)$/.exec(leaderLabel);
  return ctrl ? `^${ctrl[1]!.toUpperCase()}` : leaderLabel.toLowerCase();
}

/** The short label the hint bar shows: `^d`, `^G c`, or a named key as itself. */
export function actionKeyLabel(key: string): string {
  if ([...key].length !== 1) return key;
  return hasDirectChord(key) ? `^${key}` : `${leaderCap()} ${key}`;
}

/** The words a surface uses in a sentence: "Ctrl+D", "Ctrl+G then c", or "Enter". */
export function actionKeyText(key: string): string {
  if ([...key].length !== 1) return key.charAt(0).toUpperCase() + key.slice(1);
  return hasDirectChord(key) ? `Ctrl+${key.toUpperCase()}` : `${leaderLabel} then ${key}`;
}

/**
 * A surface's own hint that opens with a bare action character (`d delete`,
 * `1-6 set status`) shown with the keys that press it.
 */
export function chordHint(hint: string): string {
  const match = /^([0-9a-zA-Z])(?:-([0-9a-zA-Z]))? (?=\S)/.exec(hint);
  if (!match) return hint;
  const [whole, first, last] = match;
  const keys = last === undefined ? actionKeyLabel(first!) : (
    hasDirectChord(first!) && hasDirectChord(last) ? `^${first}-^${last}` : `${leaderCap()} ${first}-${last}`
  );
  return `${keys} ${hint.slice(whole.length)}`;
}
