/**
 * places/browser.ts, the place declarations as the web UI's browser bundle
 * loads them (`@goodvibes/engine/terminal-shell/places/browser`), and the one
 * registry of places: index.ts builds `PLACES` from `BROWSER_PLACES` and the
 * place only a terminal program draws. Nothing here reaches the terminal or the
 * daemon. The web UI draws each from its daemon lists and its capability
 * actions; a list whose source is the terminal program's own (`session`,
 * `program`) has no web side. The daemon counts every place from the same
 * declarations (`places.counts`).
 *
 * This conversation is not here: every list of its is the conversation in a
 * terminal program, so the browser has nothing of its to read. A new place is
 * added here, unless the same is true of it.
 */
export type {
  AnyPlace, PlaceAction, PlaceAnswer, PlaceCapabilityAction, PlaceCount, PlaceDeclaration, PlaceDetailLine, PlaceFollow,
  PlaceGroupId, PlaceItem, PlaceList, PlaceOfferedWhen, PlaceProgramAction, PlaceRow, PlaceSource,
} from './place-types.js';
// Whether an action is offered on an item (its states and its `offeredWhen`): the one test every renderer uses.
export { actionOfferedFor, startingValues } from './place-types.js';
import type { AnyPlace } from './place-types.js';
import { AUTOMATION_PLACE } from './automation-place.js';
import { CODE_PLACE } from './code-place.js';
import { DEVICES_PLACE } from './devices-place.js';
import { MEMORY_PLACE } from './memory-place.js';
import { MESSAGES_PLACE } from './messages-place.js';
import { MODELS_PLACE } from './models-place.js';
import { MONEY_PLACE } from './money-place.js';
import { SAFETY_PLACE } from './safety-place.js';
import { SESSIONS_PLACE } from './sessions-place.js';
import { SYSTEM_PLACE } from './system-place.js';
import { TOOLS_PLACE } from './tools-place.js';
import { WAITING_PLACE } from './waiting-place.js';
import { WORK_PLACE } from './work-place.js';

/** Every place the browser draws; the web UI orders them by their group (capabilities/groups.ts). */
export const BROWSER_PLACES: readonly AnyPlace[] = [
  WAITING_PLACE, AUTOMATION_PLACE, SYSTEM_PLACE, SESSIONS_PLACE, MESSAGES_PLACE, WORK_PLACE, MONEY_PLACE, DEVICES_PLACE,
  CODE_PLACE, TOOLS_PLACE, SAFETY_PLACE, MEMORY_PLACE, MODELS_PLACE,
];

/** The places the terminal programs draw and the browser does not, with why, in a person's words. */
export const TERMINAL_ONLY_PLACES: readonly { readonly group: 'conversation'; readonly why: string }[] = [
  { group: 'conversation', why: 'This conversation acts on the chat in front of you: in the web UI its controls are on the chat itself.' },
];
