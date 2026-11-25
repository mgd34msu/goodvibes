/**
 * place-keys.ts, a place's keys in the key table.
 *
 * Every place is one key context (`place.<id>`): each of its actions with a
 * letter is a rebindable entry whose default is the letter the declaration
 * gives, and "read again" is one too. Its name in keybindings.json is
 * `place.<place>.<action>` (`place.automation.pause`). The table checks the
 * context for conflicts within the place (two actions on one key that can
 * apply at once) and against the program's own keys, and the Keys place
 * lists the entries under the place's name. An action on a navigation key
 * (`enter`) is that navigation action wherever it is bound; an item's
 * answers keep the item's own keys (the daemon's, the same on every surface).
 */
import { NAVIGATION_KEYS, type KeyCombo, type KeyContext, type KeyContextAction } from '../keybindings.js';
import type { AnyPlace, PlaceAction, PlaceItem } from './place-types.js';

/** The key that reads every list of a place again at once; its entry in each place's context. */
export const READ_AGAIN_ACTION = 'read-again';
const READ_AGAIN_DEFAULT = 'r';

/** The context id of a place's keys. */
export function placeKeyContextId(place: Pick<AnyPlace, 'id'>): string {
  return `place.${place.id}`;
}

/** Whether a declared key is a navigation key of the table (Enter, Tab, Esc, an arrow) rather than a letter of the place. */
export function isNavigationKey(key: string): boolean {
  return Object.values(NAVIGATION_KEYS).some((combo) => combo.key === key);
}

/** An action's name in its place's context: its `id`, else its label in lower case with dashes. */
export function placeActionName(action: PlaceAction<PlaceItem>): string {
  if (action.id) return action.id;
  const words = action.kind === 'program' ? action.label : action.label ?? action.capability.slice(action.capability.indexOf('.') + 1);
  return words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Whether an action is an entry of its place's context (a letter, not a navigation key or an item's answers). */
export function inPlaceKeyContext(action: PlaceAction<PlaceItem>): boolean {
  if (action.kind !== 'program' && action.answers) return false;
  return !isNavigationKey(action.key);
}

function comboOf(key: string): KeyCombo {
  return /^[A-Z]$/.test(key) ? { key: key.toLowerCase(), shift: true } : { key };
}

/** A place's key context: its lettered actions and read-again, with the declared keys as defaults. */
export function placeKeyContext(place: AnyPlace): KeyContext {
  const actions: KeyContextAction[] = [];
  const named = new Set<string>();
  for (const action of place.actions) {
    if (!inPlaceKeyContext(action)) continue;
    const name = placeActionName(action);
    if (named.has(name)) continue;
    named.add(name);
    const label = action.kind === 'program' ? action.label : action.label ?? name.replace(/-/g, ' ');
    actions.push({
      name,
      description: label,
      defaults: [comboOf(action.key)],
      scope: { ...(action.list !== undefined ? { list: action.list } : {}), ...(action.states ? { states: action.states } : {}) },
    });
  }
  actions.push({ name: READ_AGAIN_ACTION, description: 'read every list again', defaults: [{ key: READ_AGAIN_DEFAULT }] });
  return { id: placeKeyContextId(place), title: place.title, actions };
}
