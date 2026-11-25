/**
 * places.ts, the web UI's side of the places: the same declarations the
 * terminal programs draw (`@goodvibes/engine/terminal-shell/places/browser`),
 * ordered by the fourteen function groups (one definition, the engine's
 * capabilities/groups.ts), and what the browser does with a declaration that
 * holds no drawing: read a list's daemon source, say which frames of the event
 * stream mean a list changed, and which of a place's lists and actions the
 * browser can show.
 *
 * A list whose source is the terminal program's own (`session`, `program`:
 * the Keys, a conversation's checklist) has no web side and is left out, with
 * a line saying where it is. A program action (`kind: 'program'`) is the
 * terminal program's own interaction and is left out too.
 */
import { isRuntimeEventDomain, type RuntimeEventDomain } from '@goodvibes/engine/contracts';
import {
  BROWSER_PLACES, TERMINAL_ONLY_PLACES, type AnyPlace, type PlaceAction, type PlaceCapabilityAction, type PlaceCount, type PlaceItem, type PlaceList,
} from '@goodvibes/engine/terminal-shell/places/browser';
import { CAPABILITY_GROUPS, type CapabilityGroupId } from '@goodvibes/engine/platform/platform/capabilities/words';
import { invokeMethod, invokeOwnerMethod } from './goodvibes';
import type { ViewId } from './router';

export type { AnyPlace, PlaceAction, PlaceCapabilityAction, PlaceCount, PlaceItem, PlaceList };
export type { PlaceAnswer, PlaceDetailLine, PlaceRow } from '@goodvibes/engine/terminal-shell/places/browser';

/** One row of the places' navigation: a group, its place in the browser (or why it has none here). */
export interface PlaceGroupRow {
  readonly group: CapabilityGroupId;
  readonly title: string;
  readonly line: string;
  readonly place?: AnyPlace | undefined;
  /** Why the browser has no place for this group, in a person's words. */
  readonly elsewhere?: string | undefined;
}

/** The fourteen groups in their order, each with its place. */
export const PLACE_GROUPS: readonly PlaceGroupRow[] = CAPABILITY_GROUPS.map((group) => {
  const place = BROWSER_PLACES.find((candidate) => candidate.group === group.id);
  const elsewhere = TERMINAL_ONLY_PLACES.find((entry) => entry.group === group.id)?.why;
  // The group's line starts a sentence here (it continues one in the model's prompt).
  return { group: group.id, title: group.title, line: `${group.line.charAt(0).toUpperCase()}${group.line.slice(1)}.`,...(place ? { place } : {}), ...(elsewhere && !place ? { elsewhere } : {}) };
});

/** Every place the browser draws, in group order. */
export const WEB_PLACES: readonly AnyPlace[] = PLACE_GROUPS.flatMap((row) => (row.place ? [row.place] : []));

export function placeById(id: string): AnyPlace | undefined {
  return WEB_PLACES.find((place) => place.id === id);
}

/** Whether a list or an action is the web UI's: one whose `programs` leaves out `'web'` is not. */
function forWeb(entry: { readonly programs?: readonly string[] | undefined }): boolean {
  return entry.programs === undefined || entry.programs.includes('web');
}

/** A daemon-sourced list the web UI has: the only kind the browser reads. */
export function isWebList(list: PlaceList<PlaceItem>): boolean {
  return list.source.kind === 'daemon' && forWeb(list);
}

/** A place's capability actions the web UI has (a program action is the terminal program's own). */
function webActions(place: AnyPlace): readonly PlaceCapabilityAction<PlaceItem>[] {
  return place.actions.filter((action): action is PlaceCapabilityAction<PlaceItem> => action.kind !== 'program' && forWeb(action));
}

/** The place's lists the browser shows, and the labels of those it leaves to the terminal programs. */
export function webListsOf(place: AnyPlace): { readonly shown: readonly PlaceList<PlaceItem>[]; readonly elsewhere: readonly string[] } {
  return {
    shown: place.lists.filter(isWebList),
    elsewhere: place.lists.filter((list) => !isWebList(list)).map((list) => list.label),
  };
}

/** The key of a read: lists of one method and input are one call per refresh. */
export function readKey(list: PlaceList<PlaceItem>): string {
  return list.source.kind === 'daemon' ? `${list.source.method} ${JSON.stringify(list.source.input)}` : `${list.source.kind}:${list.source.name}`;
}

/**
 * Call a list's daemon source. A read through `capabilities.run` is the person's own (they opened the list), so it
 * carries their claim and is never put to them as a question; every other method is a plain read.
 */
export async function readSource(list: PlaceList<PlaceItem>, signal?: AbortSignal): Promise<unknown> {
  if (list.source.kind !== 'daemon') throw new Error(`${list.noun} is kept by the terminal program you work in`);
  const { method, input } = list.source;
  if (method === 'capabilities.run') return invokeOwnerMethod(method, input, signal);
  // The method id is the declaration's, held to the daemon's catalog; it goes through the typed signature as itself.
  return invokeMethod(method as Parameters<typeof invokeMethod>[0], input as never) as Promise<unknown>;
}

/** What one list follows, as the event stream's frames: domains to carry, frame names to hear, LIST_CHANGED lists. */
export interface ListInterest {
  readonly domains: readonly RuntimeEventDomain[];
  readonly frames: readonly string[];
  readonly lists: readonly string[];
}

export function interestOf(list: PlaceList<PlaceItem>): ListInterest {
  const follows = list.follows;
  if (!follows || !isWebList(list)) return { domains: [], frames: [], lists: [] };
  const lists = follows.lists ?? [];
  const domains = [...follows.domains, ...(lists.length > 0 ? ['workspace'] : [])].filter(isRuntimeEventDomain);
  return { domains, frames: [...new Set([...follows.domains, ...follows.events])], lists };
}

/** Whether a frame (its name, and for `workspace` the LIST_CHANGED list it names) means this list changed. */
export function frameTouches(interest: ListInterest, name: string, changedList: string | undefined): boolean {
  if (name === 'workspace' && changedList !== undefined && interest.lists.includes(changedList)) return true;
  return interest.frames.includes(name);
}

/** The list a LIST_CHANGED frame names, read defensively (the frame or its `payload`). */
export function changedListOf(frame: unknown): string | undefined {
  const outer = (frame ?? {}) as { type?: unknown; list?: unknown; payload?: unknown };
  const inner = (outer.payload ?? {}) as { type?: unknown; list?: unknown };
  for (const event of [inner, outer]) {
    if (event.type === 'LIST_CHANGED' && typeof event.list === 'string') return event.list;
  }
  return undefined;
}

/** The actions on the place itself (no list), always shown. */
export function placeActions(place: AnyPlace): readonly PlaceCapabilityAction<PlaceItem>[] {
  return webActions(place).filter((action) => action.list === undefined);
}

/** The actions on a list's kind of thing (`whole`), shown on its tab whether or not an item is selected. */
export function wholeActions(place: AnyPlace, listId: string): readonly PlaceCapabilityAction<PlaceItem>[] {
  return webActions(place).filter((action) => action.list === listId && action.whole === true);
}

/** The actions that apply to the selected item in its state. */
export function itemActions(place: AnyPlace, listId: string, item: PlaceItem): readonly PlaceCapabilityAction<PlaceItem>[] {
  return webActions(place).filter((action) => action.list === listId && action.whole !== true && (!action.states || action.states.includes(item.state)));
}

/** The action that undoes one just run: the place's web action on the same list whose capability is named by `undoneBy`. */
export function undoActionOf(
  place: AnyPlace, listId: string | undefined, undoneBy: string, actionIdOf: (action: PlaceCapabilityAction<PlaceItem>) => string | undefined,
): PlaceCapabilityAction<PlaceItem> | undefined {
  return webActions(place).find((action) => action.list === listId && actionIdOf(action) === undoneBy);
}

/** Whether an action answers the waiting item itself: pressing it never asks again (place-types.ts `answersItem`). */
export function answersItem(action: PlaceCapabilityAction<PlaceItem>): boolean {
  return action.answersItem === true || action.answers !== undefined;
}

/** The inputs the selected item gives an action (a field of the item, or a function of it). */
export function filledFrom(action: PlaceCapabilityAction<PlaceItem>, item: PlaceItem | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  if (!item || !action.fill) return values;
  for (const [input, from] of Object.entries(action.fill)) {
    const value = typeof from === 'function' ? from(item) : (item as unknown as Readonly<Record<string, unknown>>)[from];
    if (typeof value === 'string' && value !== '') values[input] = value;
  }
  return values;
}

/**
 * A custom pane a list names (`pane: '<name>'`, for one that draws more than label and value lines, such as a
 * work's step graph): the web twin of that name draws it, else the item's plain detail.
 */
export function paneOf(list: PlaceList<PlaceItem>): string | undefined {
  const named = (list as { readonly pane?: unknown }).pane;
  return typeof named === 'string' && named ? named : undefined;
}

/** The web UI's own views that cover the same ground as a place, richer there: linked from the place. */
export interface RicherView {
  readonly label: string;
  readonly view?: ViewId | undefined;
  readonly tab?: string | undefined;
  /** A settings section instead of a view. */
  readonly settings?: string | undefined;
}

export const RICHER_VIEWS: Readonly<Record<string, readonly RicherView[]>> = {
  waiting: [{ label: 'Work: what waits for you', view: 'work', tab: 'waiting' }],
  automation: [{ label: 'Check-in settings', settings: 'checkins' }],
  sessions: [{ label: 'Chat', view: 'chat' }, { label: 'Work: sessions', view: 'work', tab: 'sessions' }],
  work: [{ label: 'Work', view: 'work', tab: 'all' }],
  messages: [{ label: 'Calendar', view: 'personal', tab: 'calendar' }, { label: 'Mail', view: 'personal', tab: 'mail' }, { label: 'Channels', view: 'personal', tab: 'channels' }],
  memory: [{ label: 'Library: memory', view: 'library', tab: 'memory' }, { label: 'Library: knowledge', view: 'library', tab: 'knowledge' }],
  models: [{ label: 'Models and providers settings', settings: 'models' }, { label: 'Decision model settings', settings: 'decision-models' }],
  safety: [{ label: 'Permission settings', settings: 'permissions' }, { label: 'Credentials', settings: 'credentials' }],
  devices: [{ label: 'Device settings', settings: 'devices' }, { label: 'Secure address', settings: 'secure-address' }, { label: 'Phone node', view: 'phone' }],
  money: [{ label: 'Usage settings', settings: 'usage' }],
  system: [{ label: 'Settings', settings: 'general' }, { label: 'About', settings: 'about' }],
};

/** Text from another process, with control characters taken out before it is shown. */
export function plainText(value: string): string {
  // eslint-disable-next-line no-control-regex -- the control characters are exactly what is taken out
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ');
}
