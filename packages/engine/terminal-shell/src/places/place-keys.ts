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
/**
 * The key that lists every key of the place that applies now, each runnable from the list; its entry in each
 * place's context. The hint row ends with it when the place's keys do not fit in two rows.
 */
export const MORE_KEYS_ACTION = 'more-keys';
const MORE_KEYS_DEFAULT = '?';

/**
 * Capabilities that end the program the person is in: never on a letter of a place. Only Enter on a row the person
 * selected runs one (the System place's "Close this program" row); a letter declared for one is not bound.
 */
export const ENDS_THE_PROGRAM: ReadonlySet<string> = new Set(['system.quit']);

/** The entry of a list's search key in its place's context (place-types.ts `search`). */
export function searchActionName(listId: string): string {
  return `search-${listId}`;
}

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
      // `key: ''`: an entry with no default key (This conversation's controls), bound only when a person binds it.
      defaults: action.key === '' ? [] : [comboOf(action.key)],
      scope: { ...(action.list !== undefined ? { list: action.list } : {}), ...(action.states ? { states: action.states } : {}) },
    });
  }
  // A list searched in place as the person types (place-types.ts `search`): its key starts typing.
  for (const list of place.lists) {
    if (!list.search) continue;
    actions.push({ name: searchActionName(list.id), description: list.search.label, defaults: [comboOf(list.search.key)], scope: { list: list.id } });
  }
  actions.push({ name: READ_AGAIN_ACTION, description: 'read every list again', defaults: [{ key: READ_AGAIN_DEFAULT }] });
  actions.push({ name: MORE_KEYS_ACTION, description: 'list every key of this place', defaults: [{ key: MORE_KEYS_DEFAULT }] });
  return { id: placeKeyContextId(place), title: place.title, actions };
}
