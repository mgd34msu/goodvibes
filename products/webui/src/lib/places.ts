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
  actionOfferedFor, startingValues, BROWSER_PLACES, TERMINAL_ONLY_PLACES, type AnyPlace, type PlaceAction, type PlaceCapabilityAction, type PlaceCount, type PlaceItem, type PlaceList,
} from '@goodvibes/engine/terminal-shell/places/browser';
import { CAPABILITY_GROUPS, type CapabilityGroupId } from '@goodvibes/engine/platform/platform/capabilities/words';
import { invokeMethod, invokeOwnerMethod, invokeThroughMethod } from './goodvibes';
import { EVERY_PROJECT } from './place-project';
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

/** A place's capability actions the web UI runs (a program action is the terminal program's own). */
function webActions(place: AnyPlace): readonly PlaceCapabilityAction<PlaceItem>[] {
  return place.actions.filter((action): action is PlaceCapabilityAction<PlaceItem> => action.kind !== 'program' && forWeb(action));
}

const PROGRAM_WORDS: Readonly<Record<string, string>> = { tui: 'the terminal app', agent: 'the Agent' };

/**
 * An action of a place that runs only in a terminal program, shown greyed in the browser with where it runs: its
 * words, and the one line that says where.
 */
export interface ElsewhereAction {
  readonly label: string;
  readonly where: string;
}

/**
 * Where an action runs when the browser cannot run it: a program action (the program's own screen), a control
 * declared for the terminal programs only, or a capability that runs where a conversation is (or only inside a
 * terminal program for now). Undefined: the browser runs it.
 */
export function elsewhereOf(action: PlaceAction<PlaceItem>, runsIn: 'daemon' | 'session' | 'terminal' | undefined, group?: string | undefined): string | undefined {
  if (action.kind === 'program') return 'Runs in the terminal app, on its own screen there.';
  if (!forWeb(action)) {
    const named = (action.programs ?? []).filter((program) => program !== 'web').map((program) => PROGRAM_WORDS[program] ?? program);
    return `Runs in ${named.length > 0 ? named.join(' and ') : 'a terminal program'}.`;
  }
  if (runsIn === 'session') {
    return group === 'conversation' || group === 'sessions'
      ? 'Runs in the terminal app, on the conversation there.'
      : 'Runs in the terminal app or the Agent, on what that program holds.';
  }
  if (runsIn === 'terminal') return 'Runs in the terminal app or the Agent for now.';
  return undefined;
}

/** Every action of a place on a list the browser shows (or on the place), the program ones included. */
export function allActionsOf(place: AnyPlace): readonly PlaceAction<PlaceItem>[] {
  const shown = new Set(webListsOf(place).shown.map((list) => list.id));
  return place.actions.filter((action) => action.list === undefined || shown.has(action.list));
}

/** The place's lists the browser shows, and the labels of those it leaves to the terminal programs. */
export function webListsOf(place: AnyPlace): { readonly shown: readonly PlaceList<PlaceItem>[]; readonly elsewhere: readonly string[] } {
  const shown = place.lists.filter(isWebList);
  // A terminal list whose web twin (the same id, read from the daemon) is shown here is not named as elsewhere.
  const twins = new Set(shown.map((list) => list.id));
  return {
    shown,
    elsewhere: place.lists.filter((list) => !isWebList(list) && !twins.has(list.id)).map((list) => list.label),
  };
}

/** The reads that take `everyProject` (the daemon's memory reads, method-catalog-runtime.ts). */
const EVERY_PROJECT_READS: ReadonlySet<string> = new Set(['memory.records.list', 'memory.records.search']);

/** The key of a read: lists of one method and input are one call per refresh. */
export function readKey(list: PlaceList<PlaceItem>): string {
  return list.source.kind === 'daemon' ? `${list.source.method} ${JSON.stringify(list.source.input)}` : `${list.source.kind}:${list.source.name}`;
}

/**
 * Call a list's daemon source. A read through `capabilities.run` is the person's own (they opened the list), so it
 * carries their claim and is never put to them as a question; every other method is a plain read.
 */
export async function readSource(list: PlaceList<PlaceItem>, project?: string | undefined, signal?: AbortSignal): Promise<unknown> {
  if (list.source.kind !== 'daemon') throw new Error(`${list.noun} is kept by the terminal program you work in`);
  const { method, input } = list.source;
  // A capability's read is bound to the project the person chose (place-project.ts), never the daemon's own folder;
  // "Every project" names none and says so (the daemon takes it from the owner himself only).
  if (method === 'capabilities.run') {
    return invokeOwnerMethod(method, project === EVERY_PROJECT ? { ...input, everyProject: true } : project ? { ...input, workingDirectory: project } : input, signal);
  }
  // A list bound to a project (`projectAs`) is read through the method invoke with the chosen project; with none
  // chosen yet it is not read, so the daemon's own folder is never read in its place.
  const projectAs = list.source.projectAs;
  if (projectAs) {
    if (project === EVERY_PROJECT) throw new Error('this list is one project\'s: choose a project to read it');
    if (!project) throw new Error('no project is chosen yet');
    return invokeThroughMethod(method, { ...input, [projectAs]: project }, signal);
  }
  // "Every project": a read of per-project memory says so (the daemon takes it from the owner himself only); no
  // project is named, so every other read covers what belongs to no project.
  if (project === EVERY_PROJECT && EVERY_PROJECT_READS.has(method)) return invokeThroughMethod(method, { ...input, everyProject: true }, signal);
  // The method id is the declaration's, held to the daemon's catalog; it goes through the typed signature as itself.
  return invokeMethod(method as Parameters<typeof invokeMethod>[0], input as never) as Promise<unknown>;
}

/** One place's count as the daemon answers `places.counts` (the place's own count, over its own lists). */
export interface PlaceCountRow {
  readonly count: PlaceCount | undefined;
  /** The lists whose read the daemon was refused (by id): the count is made without them. */
  readonly unread: readonly string[];
}

/** Every place's count in one call, for the browser's view of each place and the chosen project. */
export async function readPlaceCounts(project: string | undefined): Promise<Readonly<Record<string, PlaceCountRow>>> {
  const answer = await invokeOwnerMethod('places.counts', { program: 'web', ...(project && project !== EVERY_PROJECT ? { workingDirectory: project } : {}) });
  const rows = answer && typeof answer === 'object' && Array.isArray((answer as { places?: unknown }).places) ? (answer as { places: unknown[] }).places : [];
  const out: Record<string, PlaceCountRow> = {};
  for (const entry of rows) {
    const row = (entry && typeof entry === 'object' ? entry : {}) as { place?: unknown; count?: unknown; words?: unknown; tone?: unknown; unread?: unknown };
    if (typeof row.place !== 'string') continue;
    out[row.place] = {
      count: typeof row.count === 'number' && row.count > 0 && typeof row.words === 'string'
        ? { count: row.count, words: row.words, tone: row.tone === 'wrong' ? 'wrong' : 'waiting' } : undefined,
      unread: Array.isArray(row.unread) ? row.unread.filter((id): id is string => typeof id === 'string') : [],
    };
  }
  return out;
}

/** What one list follows, as the event stream's frames: domains to carry, frame names to hear, LIST_CHANGED lists. */
export interface ListInterest {
  readonly domains: readonly RuntimeEventDomain[];
  readonly frames: readonly string[];
  readonly lists: readonly string[];
  /** The capabilities whose run changes this list (LIST_CHANGED `capabilities` names each by id), as the terminal places hear them. */
  readonly capabilities: readonly string[];
}

/** The LIST_CHANGED list the daemon announces every change capability on, with its id (runtime/list-changes.ts). */
const CAPABILITY_RAN_LIST = 'capabilities';

/** A capability's command, the part of its id before the first dot (`schedule.pause` -> `schedule`). */
const commandOf = (id: string): string => id.split('.')[0] ?? id;

/**
 * What a list hears, as the terminal places decide it (place-modal.ts `followPlace`): the domains, frame names and
 * event types it names, the LIST_CHANGED lists it names, and the capabilities that act on it (its own actions, those
 * whose outcome lands on it, place-wide actions of the same command, and those it names in `follows.capabilities`).
 */
export function interestOf(list: PlaceList<PlaceItem>, place?: AnyPlace): ListInterest {
  if (!isWebList(list)) return { domains: [], frames: [], lists: [], capabilities: [] };
  const follows = list.follows;
  const actions = place ? webActions(place) : [];
  const own = actions.filter((action) => action.list === list.id || (action as { readonly doneOn?: string }).doneOn === list.id);
  const commands = new Set(own.map((action) => commandOf(action.capability)));
  const placeWide = actions.filter((action) => action.list === undefined && commands.has(commandOf(action.capability)));
  const capabilities = [...new Set([...own, ...placeWide].map((action) => action.capability).concat(follows?.capabilities ?? []))];
  const lists = [...(follows?.lists ?? []), ...(capabilities.length > 0 ? [CAPABILITY_RAN_LIST] : [])];
  const domains = [...(follows?.domains ?? []), ...(lists.length > 0 ? ['workspace'] : [])].filter(isRuntimeEventDomain);
  return { domains, frames: [...new Set([...(follows?.domains ?? []), ...(follows?.events ?? [])])], lists, capabilities };
}

/** What a frame names: the LIST_CHANGED list and record (a capability's id), and its runtime event type. */
export interface FrameNames {
  readonly list?: string | undefined;
  readonly id?: string | undefined;
  readonly type?: string | undefined;
}

/**
 * Whether a frame means this list changed: a LIST_CHANGED list it names (a capability's run only when that capability
 * acts on it), a frame name, or a runtime event type it names (`NATIVE_REQUEST_CHANGED`).
 */
export function frameTouches(interest: ListInterest, name: string, frame: FrameNames): boolean {
  if (name === 'workspace' && frame.list === CAPABILITY_RAN_LIST) return frame.id !== undefined && interest.capabilities.includes(frame.id);
  if (name === 'workspace' && frame.list !== undefined && interest.lists.includes(frame.list)) return true;
  return interest.frames.includes(name) || (frame.type !== undefined && interest.frames.includes(frame.type));
}

/** The list, record and event type a frame names, read defensively (the frame or its `payload`). */
export function frameNamesOf(frame: unknown): FrameNames {
  const outer = (frame ?? {}) as { type?: unknown; list?: unknown; id?: unknown; payload?: unknown };
  const inner = (outer.payload ?? {}) as { type?: unknown; list?: unknown; id?: unknown };
  const type = typeof inner.type === 'string' ? inner.type : typeof outer.type === 'string' ? outer.type : undefined;
  for (const event of [inner, outer]) {
    if (event.type === 'LIST_CHANGED' && typeof event.list === 'string') return { type, list: event.list, ...(typeof event.id === 'string' ? { id: event.id } : {}) };
  }
  return { type };
}

/** The list a LIST_CHANGED frame names. */
export function changedListOf(frame: unknown): string | undefined {
  return frameNamesOf(frame).list;
}

/** The actions on the place itself (no list), always shown. */
export function placeActions(place: AnyPlace): readonly PlaceCapabilityAction<PlaceItem>[] {
  return webActions(place).filter((action) => action.list === undefined);
}

/** The actions on a list's kind of thing (`whole`), shown on its tab whether or not an item is selected. */
export function wholeActions(place: AnyPlace, listId: string): readonly PlaceCapabilityAction<PlaceItem>[] {
  return webActions(place).filter((action) => action.list === listId && action.whole === true);
}

/** The actions that apply to the selected item: its state, and its own data where the action says (`offeredWhen`). */
export function itemActions(place: AnyPlace, listId: string, item: PlaceItem): readonly PlaceCapabilityAction<PlaceItem>[] {
  return webActions(place).filter((action) => action.list === listId && action.whole !== true && actionOfferedFor(action, item));
}

/** Whether an action is offered on an item (the engine's one test, place-types.ts `actionOfferedFor`). */
export { actionOfferedFor };
/** The values a form opens on from the item (the engine's one reading, place-types.ts `startingValues`). */
export { startingValues };

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
  messages: [{ label: 'Calendar', view: 'personal', tab: 'calendar' }, { label: 'Mail', view: 'personal', tab: 'mail' }],
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
