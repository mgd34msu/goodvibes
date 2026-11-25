/**
 * places/browser.ts, the place declarations as the web UI's browser bundle
 * loads them (`@goodvibes/engine/terminal-shell/places/browser`): the same
 * declarations the terminal programs draw (index.ts `PLACES`), and their
 * types, with nothing that reaches the terminal or the daemon. The web UI
 * draws each from its daemon lists and its capability actions; a list whose
 * source is the terminal program's own (`session`, `program`) has no web side.
 *
 * Code and changes and This conversation are not here: every list of theirs is
 * the terminal program's own (the project files a turn changed, the live
 * conversation), so the browser has nothing of theirs to read. A place added
 * to `PLACES` is added here too, unless the same is true of it.
 */
export type {
  AnyPlace, PlaceAction, PlaceAnswer, PlaceCapabilityAction, PlaceCount, PlaceDeclaration, PlaceDetailLine, PlaceFollow,
  PlaceGroupId, PlaceItem, PlaceList, PlaceProgramAction, PlaceRow, PlaceSource,
} from './place-types.js';
import type { AnyPlace } from './place-types.js';
import { AUTOMATION_PLACE } from './automation-place.js';
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
  TOOLS_PLACE, SAFETY_PLACE, MEMORY_PLACE, MODELS_PLACE,
];

/** The places the terminal programs draw and the browser does not, with why, in a person's words. */
export const TERMINAL_ONLY_PLACES: readonly { readonly group: 'code' | 'conversation'; readonly why: string }[] = [
  { group: 'code', why: 'Code and changes reads the project folder of the terminal program you work in, so it opens there.' },
  { group: 'conversation', why: 'This conversation acts on the chat in front of you: in the web UI its controls are on the chat itself.' },
];
