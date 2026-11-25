/**
 * place-modal.ts, a place drawn in a terminal program (both, the same code).
 *
 *   ✦ Automation   Schedules · Runs                                     esc
 *
 *    ● Morning brief      every weekday 09:00    │ Morning brief
 *    ○ Weekly report      paused                 │ When      every Monday 08:00
 *                                                │ Next run  none (paused)
 *                                                │ What it does  summarise ...
 *
 *    Paused Weekly report. To undo: p resume.
 *    n new schedule   g run now   p resume   c change   x remove   r read again
 *
 * The lists read by themselves when the place opens and again on every
 * change event they follow (a schedule paused from the web UI shows paused
 * here with no key pressed). A list that could not be read says why in plain
 * words; it is read again by itself when its daemon's event stream comes
 * back, or when the program's own daemon connection is back (a place opened
 * while the daemon was down), and the read-again key reads it at once. For
 * the selected item the hint row shows only the actions that apply to it in
 * its present state, with the keys bound in the place's key context
 * (place-keys.ts), first, then the tab's and the place's keys; it never takes
 * more than two rows: what does not fit is behind one "more keys" entry, a
 * list of every key that applies now, each runnable from it. Pressing a key is
 * the request: it runs and the place says, on the tab it was pressed on,
 * what happened and how to undo it. A list read again drops "may be out of
 * date"; an empty list says what would be there and names only the keys
 * that act on it. An action that cannot be undone or
 * weakens a protection asks first, except one that answers the waiting item
 * itself: the item is the question, so its answer runs on the press. Enter on
 * an item with answers lists them, starting on the refusing one for an ask
 * that loosens a protection. Nothing waits on a clock.
 */
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { DaemonFrameStreamState } from '@goodvibes/engine/platform/platform/runtime/client';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from '../surface-modal-host.js';
import type { KeyCombo, KeyToken } from '../keybindings.js';
import { keyTokenFromText } from '../keybindings.js';
import { beginModal, finishModal, hintLayoutWidth, layoutHintRows, MODAL_MARK_INSET, modalGeometry, modalInnerWidth, scrollCountText, wrapLines, type KitHint, type SurfaceLayer } from '../renderer/surface-kit.js';
import { drawList, type KitRow } from '../renderer/surface-kit-list.js';
import { splitListDetail } from '../renderer/surface-kit-extra.js';
import { inset, tabs, type InsetLine } from '../renderer/surface-kit-parts.js';
import { activeTokens } from '../renderer/theme.js';
import { actionButton, actionDoneLine, actionSentence, effectiveRisk, isShown, riskWords } from '../command-actions/typed-line.js';
import type { ActionValues } from '../command-actions/types.js';
import { keycapOf, plainReason, reasonOf, type PlaceHost, type PlacePrograms } from './place-host.js';
import type { CapabilityRevealed } from '../command-actions/capability-actions.js';
import { copyOutcomeWords, copyToClipboard } from '../clipboard.js';

/** The program's copy key (Ctrl+Y by default): in a reveal pane it copies the value. */
const COPY_ACTION = 'block-copy';
import { ENDS_THE_PROGRAM, inPlaceKeyContext, isNavigationKey, MORE_KEYS_ACTION, placeActionName, placeKeyContextId, READ_AGAIN_ACTION } from './place-keys.js';
import type { AnyPlace, PlaceAction, PlaceAnswer, PlaceCapabilityAction, PlaceItem, PlaceList, PlaceRow } from './place-types.js';

/** The read-again key's default (its entry in each place's key context, place-keys.ts). */
export const READ_AGAIN_KEY = 'r';
/** The more-keys key's default (its entry in each place's key context, place-keys.ts). */
const MORE_KEYS_KEY = '?';
/** The hint row never takes more rows than this: the rest of the place's keys are one "more keys" entry away. */
const HINT_ROWS_MAX = 2;

/** An action's whole answer, longer than the outcome line: its pane, and how far it is scrolled. */
interface ResultPane {
  readonly title: string;
  readonly lines: readonly string[];
  offset: number;
  page: number;
  max: number;
}

/** One row of the list "more keys" opens: a key of the place as bound, and what pressing it (or choosing the row) does. */
interface KeyListEntry {
  readonly cap: string;
  readonly label: string;
  readonly run: () => void;
}

interface ListState {
  items: readonly PlaceItem[];
  status: 'reading' | 'ready' | 'failed';
  reason: string | undefined;
  /** The event stream it follows was lost: the list may be old until it is back. */
  lost: string | undefined;
  /** The stream opened once: the transport reconnects it by itself. */
  followed: boolean;
  selectedId: string | undefined;
  seq: number;
}

/** One key on the hint row for the selected item. */
interface BoundAction {
  /** The key as the hint shows it (bound now). */
  readonly cap: string;
  readonly label: string;
  readonly action: PlaceAction<PlaceItem>;
  /** An item's own answer (its key is the item's, compared as typed). */
  readonly answer?: PlaceAnswer | undefined;
}

const MARKS: Readonly<Record<NonNullable<PlaceRow['mark']>, string>> = { ok: '●', paused: '○', attention: '▲', running: '◐', waiting: '?' };

/** Reads shared by the lists of one refresh: lists of the same method and input are one call. */
export type PlaceReadMemo = Map<string, Promise<unknown>>;

/** Read one list's items from its source (a daemon method, or the program's source by name). */
export async function readListItems(list: PlaceList<PlaceItem>, host: PlaceHost, memo?: PlaceReadMemo): Promise<readonly PlaceItem[]> {
  if (list.source.kind === 'daemon') {
    const { method, input } = list.source;
    const key = `${method} ${JSON.stringify(input)}`;
    let call = memo?.get(key);
    if (!call) { call = host.invoke(method, input); memo?.set(key, call); }
    return list.source.items(await call);
  }
  const source = host.source(list.source.name);
  if (!source) throw new Error(`this program keeps no ${list.noun}`);
  // A program source may read its items as it is asked (git, a register file): its answer is awaited.
  return list.source.items(await source.read());
}

/**
 * Follow what makes a place's lists change, with one daemon event stream for
 * the whole place (the union of what its daemon lists follow): `onChange` is
 * told which lists to read again, every daemon list on a daemon event (read
 * together, so lists of one method are one call). Returns the stops.
 */
export function followPlace(
  lists: readonly PlaceList<PlaceItem>[],
  host: PlaceHost,
  onChange: (indexes: readonly number[]) => void,
  onStream?: ((state: DaemonFrameStreamState) => void) | undefined,
): Array<() => void> {
  const stops: Array<() => void> = [];
  const followed = lists.flatMap((list, index) => list.source.kind === 'daemon' && list.follows ? [{ index, follows: list.follows }] : []);
  if (followed.length > 0) {
    const interest = {
      domains: [...new Set(followed.flatMap(({ follows }) => follows.domains))],
      events: [...new Set(followed.flatMap(({ follows }) => follows.events))],
      lists: [...new Set(followed.flatMap(({ follows }) => follows.lists ?? []))],
    };
    stops.push(host.follow(interest, () => onChange(followed.map(({ index }) => index)), onStream ?? (() => {})));
  }
  lists.forEach((list, index) => {
    if (list.source.kind === 'daemon') return;
    const stop = host.source(list.source.name)?.subscribe(() => onChange([index]));
    if (stop) stops.push(stop);
  });
  return stops;
}

/** A key or one typed character as a key token (the key after a text token is that character). */
function keyOf(token: InputToken): KeyToken | undefined {
  // Some terminals deliver Tab as text: it is the Tab key, never an action letter.
  if (token.type === 'text') return token.value === '\t' ? { logicalName: 'tab' } : keyTokenFromText(token.value);
  if (token.type !== 'key') return undefined;
  return { logicalName: token.logicalName, ctrl: token.ctrl, shift: token.shift, meta: token.meta };
}

/** A key as an item's own answer keys are written ('y', '1'). */
function typedKey(token: InputToken): string | undefined {
  if (token.type === 'text') return [...token.value].length === 1 ? token.value : undefined;
  if (token.type !== 'key' || token.ctrl || token.meta) return undefined;
  return token.logicalName;
}

/** Whether an action answers the waiting item itself (place-types.ts `answersItem`). */
function answersItem(action: PlaceAction<PlaceItem>): boolean {
  return action.kind !== 'program' && (action.answersItem === true || action.answers !== undefined);
}

export class PlaceModal implements SurfaceModal {
  readonly name: string;
  private readonly lists: ListState[];
  private active = 0;
  /** The outcome of the last action, with the tab it happened on: it is shown only on that tab. */
  private message: { readonly text: string; readonly tone: 'plain' | 'warning'; readonly tab: number } | undefined;
  /** The list "more keys" opened: which row is selected. */
  private keyList: { index: number } | undefined;
  /** An action's whole answer when it is longer than the outcome line: shown in its own pane, scrolled like the detail. */
  private result: ResultPane | undefined;
  /** How far the selected item's detail is scrolled (it starts at the top for each item). */
  private detailScroll: { key: string; offset: number; page: number; max: number } = { key: '', offset: 0, page: 1, max: 0 };
  private busy = false;
  private closed = false;
  private readonly stops: Array<() => void> = [];
  private followStops: Array<() => void> = [];
  private capture: { readonly prompt: string; readonly resolve: (combo: KeyCombo | undefined) => void; leader: boolean } | undefined;
  /**
   * A value the person must see once (a capability that declares `reveals`): shown whole in its own pane, with the
   * copy key, until he leaves it. Held only here; never in the outcome line, a log or the transcript.
   */
  private revealed: { readonly shown: CapabilityRevealed; copied: string | undefined } | undefined;
  /** An item's answers listed by Enter: which one is selected. */
  private choosing: { readonly itemId: string; readonly action: PlaceCapabilityAction<PlaceItem>; readonly answers: readonly PlaceAnswer[]; index: number } | undefined;
  private readonly context: string;

  constructor(private readonly place: AnyPlace, private readonly host: PlaceHost, start?: { readonly list?: string | undefined }) {
    this.name = `place:${place.id}`;
    this.context = placeKeyContextId(place);
    this.lists = place.lists.map(() => ({ items: [], status: 'reading', reason: undefined, lost: undefined, followed: false, selectedId: undefined, seq: 0 }));
    const startAt = start?.list ? place.lists.findIndex((list) => list.id === start.list) : -1;
    if (startAt >= 0) this.active = startAt;
    this.startFollowing();
    // The program's own daemon connection back (spine adoption): a list that could not be read, or a stream that
    // never opened, is read and followed again with no key pressed.
    this.stops.push(host.onDaemonBack(() => this.daemonBack()));
    this.readAll();
  }

  get takesEveryKey(): boolean { return this.capture !== undefined; }

  // -- reading -----------------------------------------------------------

  /** One daemon event stream for the place, and the program sources' own notices. */
  private startFollowing(): void {
    for (const stop of this.followStops.splice(0)) stop();
    this.followStops = followPlace(this.place.lists, this.host, (indexes) => this.readSome(indexes), (stream: DaemonFrameStreamState) => {
      this.place.lists.forEach((list, index) => {
        if (list.source.kind !== 'daemon') return;
        const state = this.lists[index]!;
        if (stream.kind === 'open') { state.followed = true; state.lost = undefined; }
        else state.lost = plainReason(stream.reason);
      });
      this.host.requestRender();
    });
  }

  private daemonBack(): void {
    if (this.closed) return;
    const daemonLists = this.place.lists.flatMap((list, index) => list.source.kind === 'daemon' ? [index] : []);
    // A stream that never opened is not reconnected by the transport: follow again.
    if (daemonLists.some((index) => !this.lists[index]!.followed)) this.startFollowing();
    this.readSome(daemonLists.filter((index) => {
      const state = this.lists[index]!;
      return state.status === 'failed' || state.lost !== undefined || !state.followed;
    }));
  }

  /** Read one list from its source; the newest read wins, and the selection stays on the same item. */
  private async read(index: number, memo?: PlaceReadMemo): Promise<void> {
    const list = this.place.lists[index]!;
    const state = this.lists[index]!;
    const seq = ++state.seq;
    if (state.status === 'failed') state.status = 'reading';
    try {
      const items = await readListItems(list, this.host, memo);
      if (this.closed || seq !== state.seq) return;
      state.items = items;
      state.status = 'ready';
      state.reason = undefined;
      // A list just read is not out of date, whatever the event stream last said.
      state.lost = undefined;
      if (!items.some((item) => item.id === state.selectedId)) state.selectedId = items[0]?.id;
      if (this.choosing && !items.some((item) => item.id === this.choosing!.itemId) && index === this.active) this.choosing = undefined;
    } catch (error) {
      if (this.closed || seq !== state.seq) return;
      state.status = 'failed';
      state.reason = reasonOf(error);
    }
    this.host.requestRender();
  }

  private readAll(): void {
    this.readSome(this.place.lists.map((_list, index) => index));
  }

  /** Read these lists now, as one refresh (lists of one method and input are one call). */
  private readSome(indexes: readonly number[]): void {
    const memo: PlaceReadMemo = new Map();
    for (const index of indexes) void this.read(index, memo);
  }

  // -- selection and actions ----------------------------------------------

  private selectedIndex(state: ListState = this.lists[this.active]!): number {
    return Math.max(0, state.items.findIndex((item) => item.id === state.selectedId));
  }

  private selectedItem(): PlaceItem | undefined {
    const state = this.lists[this.active]!;
    return state.status === 'failed' ? undefined : state.items[this.selectedIndex(state)];
  }

  private move(delta: number): void {
    const state = this.lists[this.active]!;
    if (state.items.length === 0) return;
    const next = (this.selectedIndex(state) + delta + state.items.length) % state.items.length;
    state.selectedId = state.items[next]!.id;
  }

  private label(action: PlaceAction<PlaceItem>): string {
    if (action.kind === 'program') return action.label;
    if (action.label) return action.label;
    const resolved = this.host.capability(action.capability);
    return resolved ? resolved.action.label.toLowerCase() : action.capability;
  }

  /** The key of a navigation action as bound ('⏎' for choose by default). */
  private keyLabel(action: string, fallback: string): string {
    return keycapOf(this.host.keys, action, fallback);
  }

  /** An action's key as bound now: its entry in the place's context, or the navigation action it names. */
  private capOf(action: PlaceAction<PlaceItem>): string {
    if (isNavigationKey(action.key)) {
      const navigation: Readonly<Record<string, readonly [string, string]>> = {
        enter: ['choose', '⏎'], tab: ['next-field', 'tab'], escape: ['back', 'esc'],
        up: ['move-up', 'up'], down: ['move-down', 'down'], left: ['move-left', 'left'], right: ['move-right', 'right'],
      };
      const [name, fallback] = navigation[action.key] ?? [action.key, action.key];
      return this.keyLabel(name, fallback);
    }
    return keycapOf(this.host.keys, `${this.context}.${placeActionName(action)}`, action.key);
  }

  /** The actions on the hint row now: the place's own, then those that apply to the selected item in its state. */
  private boundActions(): BoundAction[] {
    const list = this.place.lists[this.active]!;
    const item = this.selectedItem();
    const bound: BoundAction[] = [];
    for (const action of this.place.actions) {
      // A capability this program does not have (the terminal app's own hosted sessions, in the Agent) is no control here.
      if (action.kind !== 'program' && !this.host.capability(action.capability)) continue;
      // A screen this program does not have (the Changes view, in the Agent) is no control here either.
      if (action.kind === 'program' && !this.host.programAction(action.run)) continue;
      // Nothing ends the program from a letter: only Enter on the row the person selected (place-keys.ts).
      if (action.kind !== 'program' && ENDS_THE_PROGRAM.has(action.capability) && action.key !== 'enter') continue;
      // An entry with no default key (`key: ''`) is a control only once a person has bound it.
      if (action.key === '' && this.capOf(action) === '') continue;
      if (action.list === undefined) { bound.push({ cap: this.capOf(action), label: this.label(action), action }); continue; }
      // An action on the list's kind of thing (place-types.ts `whole`) is shown on its tab, an item selected or not.
      if (action.list === list.id && action.kind !== 'program' && action.whole) { bound.push({ cap: this.capOf(action), label: this.label(action), action }); continue; }
      if (action.list !== list.id || !item) continue;
      if (action.states && !action.states.includes(item.state)) continue;
      if (action.kind !== 'program' && action.answers) {
        for (const answer of action.answers(item)) bound.push({ cap: answer.key, label: answer.label, action, answer });
        continue;
      }
      bound.push({ cap: this.capOf(action), label: this.label(action), action });
    }
    return bound;
  }

  /** The bound action a token presses: an item's own answer key, a context entry, or a navigation key. */
  private pressed(token: InputToken): BoundAction | undefined {
    const bound = this.boundActions();
    const typed = typedKey(token);
    const answer = typed !== undefined ? bound.find((candidate) => candidate.answer && candidate.answer.key === typed) : undefined;
    if (answer) return answer;
    const key = keyOf(token);
    if (!key) return undefined;
    const names = this.host.keys.lookupInContext(this.context, key);
    const lettered = bound.find((candidate) => !candidate.answer && inPlaceKeyContext(candidate.action) && names.includes(placeActionName(candidate.action)));
    if (lettered) return lettered;
    return bound.find((candidate) => !candidate.answer && isNavigationKey(candidate.action.key) && candidate.action.key === key.logicalName && !key.ctrl && !key.meta);
  }

  private filled(action: PlaceCapabilityAction<PlaceItem>, item: PlaceItem | undefined, extra: ActionValues | undefined): Record<string, string> {
    const values: Record<string, string> = {};
    if (item && action.fill) {
      for (const [input, from] of Object.entries(action.fill)) {
        const value = typeof from === 'function' ? from(item) : (item as unknown as Readonly<Record<string, unknown>>)[from];
        if (typeof value === 'string' && value !== '') values[input] = value;
      }
    }
    return { ...values, ...(extra ?? {}) };
  }

  /** The values as a person reads them: an item's id shown as its title. */
  private shown(values: ActionValues, item: PlaceItem | undefined, tab: number = this.active): ActionValues {
    if (!item) return values;
    const title = this.place.lists[tab]!.row(item).title;
    return Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value === item.id ? `"${title}"` : value]));
  }

  private async press(bound: BoundAction): Promise<void> {
    const item = bound.action.list === undefined || (bound.action.kind !== 'program' && bound.action.whole) ? undefined : this.selectedItem();
    // The outcome belongs to the tab the key was pressed on, even when the person moves on before it is said.
    const tab = this.active;
    if (bound.action.kind === 'program') {
      const run = this.host.programAction(bound.action.run);
      if (!run || !item) return;
      this.busy = true;
      try {
        const said = await run(item.id, this.programs());
        if (said) this.message = { text: said, tone: 'plain', tab };
      } catch (error) {
        this.message = { text: `Not done: ${reasonOf(error)}`, tone: 'warning', tab };
      } finally {
        this.busy = false;
        this.readAll();
        this.host.requestRender();
      }
      return;
    }
    const action = bound.action;
    const resolved = this.host.capability(action.capability);
    if (!resolved) { this.message = { text: `${bound.label}: not available in this program.`, tone: 'warning', tab }; return; }
    let values: ActionValues = this.filled(action, item, bound.answer?.values);
    // Inputs the item does not give are asked in a form built from the capability's inputs.
    const missing = action.form === true
      || resolved.action.inputs.some((input) => input.required === true && values[input.id] === undefined && isShown(input, values) && !('impliedBy' in input.typed));
    if (missing) {
      const given = Object.keys(this.filled(action, item, undefined));
      const shown = this.shown(values, item, tab);
      const display = Object.fromEntries(given.flatMap((input) => shown[input] !== undefined ? [[input, shown[input]!]] : []));
      const formed = await this.host.openForm(action.capability, values, { title: this.place.title, given, display });
      // A form left with Esc is a change of mind: nothing ran, and nothing needs saying.
      if (!formed) { this.host.requestRender(); return; }
      values = formed;
    }
    const risk = effectiveRisk(resolved.action, values);
    // Asked only when it cannot be undone or weakens a protection, and never for an answer to the waiting item:
    // the item is the question, so the press is the answer (a pressed key is otherwise the request).
    if ((risk === 'cannot-be-undone' || risk === 'loosens-a-protection') && !resolved.action.asksItself && !answersItem(action)) {
      const yes = await this.host.confirm({
        title: `${resolved.action.label}?`,
        body: `${actionSentence(resolved.action, this.shown(values, item, tab))} This ${riskWords(risk)}.`,
        confirmLabel: actionButton(resolved.action),
      });
      if (!yes) { this.host.requestRender(); return; }
    }
    this.busy = true;
    this.message = { text: `${resolved.action.label}…`, tone: 'plain', tab };
    this.host.requestRender();
    const outcome = await this.host.runCapability(action.capability, values);
    this.busy = false;
    if (!outcome.ok) {
      this.message = { text: `Not done: ${outcome.reason}`, tone: 'warning', tab };
    } else {
      const done = actionDoneLine(resolved.action, this.shown(values, item, tab));
      const plain = actionDoneLine(resolved.action, values);
      // The place names items by title: the item's own id in a line becomes its title, and a line
      // naming another record by a long id (a run's) says nothing a person reads.
      const title = item ? `"${this.place.lists[tab]!.row(item).title}"` : '';
      // The item's id, or a short form of it (a command prints the first characters), becomes its title.
      const named = (word: string): boolean => item !== undefined && (word === item.id || (word.length >= 8 && item.id.startsWith(word)));
      // An answer is named as the person pressed it ("No"), never by the value it stored ("deny").
      const said = bound.answer?.said;
      const sent = said ? Object.values(bound.answer?.values ?? {}).filter((value) => value !== '' && value !== said) : [];
      const asPressed = (line: string): string => sent.reduce((current, value) => current.replace(`: ${value}`, `: ${said}`), line);
      const told = outcome.lines
        .filter((line) => line !== plain && line !== done)
        // "This cannot be undone" is said before the act, in its question, never after it.
        .filter((line) => !/^This cannot be undone\b/.test(line.trim()))
        .map(asPressed)
        // A word inside a path or a file name (".../skills/compost.md") is part of that name, never replaced.
        .map((line) => item ? line.replace(/(?<![\w/.~-])[\w-]+(?![\w/~-]|\.\w)/g, (word) => named(word) ? title : word) : line);
      const rest = told.filter((line) => !/\S{28,}/.test(line));
      const undo = this.undoHint(resolved.action.undoneBy, resolved.command.name);
      // Lines are said as one paragraph: each ends as a sentence.
      const sentence = (line: string): string => /[.!?:)"]$/.test(line.trimEnd()) ? line.trimEnd() : `${line.trimEnd()}.`;
      // An answer longer than the outcome line (a message read, a report) opens whole in the result pane; the line
      // then says in one sentence what was done. Length decides: nothing is declared for it.
      const long = told.filter((line) => line.trim() !== '').length > 3 || told.join(' ').length > 240;
      if (long && !outcome.reveal) {
        this.result = { title: resolved.action.label, lines: told, offset: 0, page: 1, max: 0 };
        // What was done, in one sentence: the done line, else the answer's own first line.
        const first = told.find((line) => line.trim() !== '' && !/\S{28,}/.test(line));
        this.message = { text: sentence(done || first || `${resolved.action.label}: done`), tone: 'plain', tab };
      } else {
        this.message = { text: [done || rest.shift() || 'Done.', ...rest.slice(0, 2), ...(undo ? [undo] : [])].map(sentence).join(' '), tone: 'plain', tab };
      }
      if (outcome.reveal) this.revealed = { shown: outcome.reveal, copied: undefined };
    }
    this.readAll();
    this.host.requestRender();
  }

  /** How to undo what just ran: the key of the place's action that undoes it, as bound. */
  private undoHint(undoneBy: string | undefined, command?: string | undefined): string | undefined {
    if (!undoneBy) return undefined;
    for (const action of this.place.actions) {
      if (action.kind === 'program') continue;
      const resolved = this.host.capability(action.capability);
      // `undoneBy` names an action of the same command: another command's action of that id (two commands' "off") is not it.
      if (resolved?.action.id === undoneBy && (command === undefined || resolved.command.name === command)) return `To undo: ${this.capOf(action)} ${this.label(action)}.`;
    }
    return undefined;
  }

  private programs(): PlacePrograms {
    return {
      captureKey: (prompt) => new Promise((resolve) => {
        this.capture = { prompt, resolve, leader: false };
        this.host.requestRender();
      }),
      run: (id, values) => this.host.runCapability(id, values),
    };
  }

  /** Enter on an item with answers: list them, starting on the one its ask opens on. */
  private openAnswers(): boolean {
    const item = this.selectedItem();
    if (!item) return false;
    const listId = this.place.lists[this.active]!.id;
    for (const action of this.place.actions) {
      if (action.kind === 'program' || !action.answers || action.list !== listId) continue;
      if (action.states && !action.states.includes(item.state)) continue;
      const answers = action.answers(item);
      if (answers.length === 0) continue;
      this.choosing = { itemId: item.id, action, answers, index: Math.max(0, answers.findIndex((answer) => answer.opensOn === true)) };
      return true;
    }
    return false;
  }

  // -- keys --------------------------------------------------------------

  handleToken(token: InputToken, _host: SurfaceModalHost): void {
    if (this.capture) { this.captureToken(token); return; }
    if (this.busy) return;
    if (token.type === 'mouse') return;
    if (this.revealed) {
      // The pane takes only the copy key; leaving it (back) ends the reveal.
      const read = keyOf(token);
      if (read && this.boundTo(COPY_ACTION, read)) {
        this.revealed.copied = copyOutcomeWords(copyToClipboard(this.revealed.shown.value));
        this.host.requestRender();
      }
      return;
    }
    const read = keyOf(token);
    const pageDown = read !== undefined && this.boundTo('scroll-page-down', read);
    const pageUp = read !== undefined && this.boundTo('scroll-page-up', read);
    if (this.result) {
      // The result pane takes the arrows (a line) and the page keys (a page); back (Esc) closes it.
      const result = this.result;
      const step = pageDown || pageUp ? result.page : 1;
      const down = pageDown || read?.logicalName === 'down';
      const up = pageUp || read?.logicalName === 'up';
      if (down || up) { result.offset = Math.min(Math.max(0, result.offset + (down ? step : -step)), result.max); this.host.requestRender(); }
      return;
    }
    if ((pageDown || pageUp) && !this.choosing && !this.keyList) { this.scrollDetail(pageDown ? 1 : -1, this.detailScroll.page); return; }
    const key = read?.logicalName;
    const choosing = this.choosing;
    if (choosing) {
      if (key === 'up' || key === 'down') choosing.index = (choosing.index + (key === 'up' ? -1 : 1) + choosing.answers.length) % choosing.answers.length;
      else if (key === 'enter') {
        const answer = choosing.answers[choosing.index]!;
        this.choosing = undefined;
        void this.press({ cap: answer.key, label: answer.label, action: choosing.action, answer });
      } else {
        // An item's own answer key answers from the list too.
        const typed = typedKey(token);
        const answer = typed !== undefined ? choosing.answers.find((candidate) => candidate.key === typed) : undefined;
        if (answer) { this.choosing = undefined; void this.press({ cap: answer.key, label: answer.label, action: choosing.action, answer }); }
      }
      this.host.requestRender();
      return;
    }
    const names = (() => { const read = keyOf(token); return read ? this.host.keys.lookupInContext(this.context, read) : []; })();
    if (this.keyList) {
      // The list of every key: move and Enter run the chosen row; a key of the place runs as it would without the list.
      const entries = this.keyListEntries();
      const keyList = this.keyList;
      if (key === 'up' || key === 'down') {
        if (entries.length > 0) keyList.index = (keyList.index + (key === 'up' ? -1 : 1) + entries.length) % entries.length;
      } else if (key === 'enter') {
        const entry = entries[Math.min(keyList.index, entries.length - 1)];
        this.keyList = undefined;
        entry?.run();
      } else if (names.includes(MORE_KEYS_ACTION)) {
        this.keyList = undefined;
      } else {
        const bound = this.pressed(token);
        if (bound) { this.keyList = undefined; void this.press(bound); }
        else if (names.includes(READ_AGAIN_ACTION)) { this.keyList = undefined; this.message = undefined; this.readAll(); }
      }
      this.host.requestRender();
      return;
    }
    const bound = this.pressed(token);
    if (bound) { void this.press(bound); return; }
    if (names.includes(READ_AGAIN_ACTION)) { this.message = undefined; this.readAll(); return; }
    if (names.includes(MORE_KEYS_ACTION)) { this.keyList = { index: 0 }; this.host.requestRender(); return; }
    if (key === 'enter' && this.openAnswers()) { this.host.requestRender(); return; }
    if (key === 'up') this.move(-1);
    else if (key === 'down') this.move(1);
    // The line under the list is about what was done on the list shown; another list does not carry it along.
    else if (key === 'tab' || key === 'right') { this.active = (this.active + 1) % this.lists.length; this.message = undefined; }
    else if (key === 'left') { this.active = (this.active - 1 + this.lists.length) % this.lists.length; this.message = undefined; }
    this.host.requestRender();
  }

  private captureToken(token: InputToken): void {
    const capture = this.capture!;
    const key = token.type === 'key' ? token : token.type === 'text' ? keyTokenFromText(token.value) : undefined;
    if (!key?.logicalName) return;
    const combo: KeyCombo = {
      key: key.logicalName,
      ...(key.ctrl ? { ctrl: true } : {}),
      ...(key.shift ? { shift: true } : {}),
      ...(key.meta ? { alt: true } : {}),
    };
    // The leader first: the key after it makes a sequence.
    if (!capture.leader && this.isLeader(combo)) { capture.leader = true; this.host.requestRender(); return; }
    this.capture = undefined;
    capture.resolve(capture.leader ? { ...combo, leader: true } : combo);
    this.host.requestRender();
  }

  /** Whether a key is bound, in the program's table, to a global action (the copy key). */
  private boundTo(action: string, key: KeyToken): boolean {
    const combos = this.host.keys.getAll().find((entry) => entry.action === action)?.combos ?? [];
    return combos.some((bound) => !bound.leader && bound.key === key.logicalName && !bound.ctrl === !key.ctrl && !bound.shift === !key.shift && !bound.alt === !key.meta);
  }

  private isLeader(combo: KeyCombo): boolean {
    const leader = this.host.keys.getAll().find((entry) => entry.action === 'leader')?.combos ?? [];
    return leader.some((bound) => bound.key === combo.key && !bound.ctrl === !combo.ctrl && !bound.shift === !combo.shift && !bound.alt === !combo.alt);
  }

  escape(): boolean {
    if (this.capture) { const capture = this.capture; this.capture = undefined; capture.resolve(undefined); return true; }
    // Leaving the pane ends the reveal: the value is dropped and not shown again.
    if (this.revealed) { this.revealed = undefined; this.host.requestRender(); return true; }
    if (this.result) { this.result = undefined; this.host.requestRender(); return true; }
    if (this.choosing) { this.choosing = undefined; this.host.requestRender(); return true; }
    if (this.keyList) { this.keyList = undefined; this.host.requestRender(); return true; }
    return false;
  }

  onClose(_reason: SurfaceModalCloseReason): void {
    this.closed = true;
    this.revealed = undefined;
    for (const stop of this.stops.splice(0)) stop();
    for (const stop of this.followStops.splice(0)) stop();
  }

  /** The counts the lists hold as read now, for the menu row of this place. */
  itemsByList(): Readonly<Record<string, readonly PlaceItem[]>> {
    return Object.fromEntries(this.place.lists.map((list, index) => [list.id, this.lists[index]!.items]));
  }

  // -- drawing -----------------------------------------------------------

  /** Whether an action acts on the selected item (not on the tab's kind of thing, nor on the place). */
  private onItem(action: PlaceAction<PlaceItem>): boolean {
    return action.list !== undefined && !(action.kind !== 'program' && action.whole);
  }

  /** Every key of the place that applies now (tab and selected item), as the list "more keys" opens shows them. */
  private keyListEntries(): KeyListEntry[] {
    const bound = this.boundActions();
    const ordered = [...bound.filter((entry) => this.onItem(entry.action)), ...bound.filter((entry) => !this.onItem(entry.action))];
    return [
      ...ordered.map((entry): KeyListEntry => ({ cap: entry.cap, label: entry.label, run: () => { void this.press(entry); } })),
      { cap: keycapOf(this.host.keys, `${this.context}.${READ_AGAIN_ACTION}`, READ_AGAIN_KEY), label: 'read again', run: () => { this.message = undefined; this.readAll(); } },
      // Every other tab by name (some may be cut from the tab row): choosing one opens it.
      ...this.place.lists.flatMap((list, index): KeyListEntry[] => index === this.active ? [] : [{
        cap: '', label: `open the tab ${list.label}`, run: () => { this.active = index; this.choosing = undefined; },
      }]),
    ];
  }

  /**
   * What an empty tab names: the keys that act on that list and change something (usually its "new" action): an
   * action on the tab's kind of thing, or a place-wide action of the same command as the list's own actions.
   */
  private emptyMakers(list: PlaceList<PlaceItem>): string[] {
    const commandOf = (action: PlaceAction<PlaceItem>): string | undefined => action.kind === 'program' ? undefined : this.host.capability(action.capability)?.command.name;
    const changes = (action: PlaceAction<PlaceItem>): boolean => action.kind !== 'program' && this.host.capability(action.capability)?.action.lasts !== 'not-a-change';
    const listCommands = new Set(this.place.actions.filter((action) => action.list === list.id).map(commandOf).filter((name): name is string => name !== undefined));
    return this.boundActions()
      .filter((entry) => !this.onItem(entry.action) && changes(entry.action))
      .filter((entry) => entry.action.list === list.id || (entry.action.list === undefined && listCommands.has(commandOf(entry.action) ?? '')))
      .map((entry) => `${entry.cap} (${entry.label})`);
  }

  private hints(width?: number): KitHint[] {
    if (this.revealed) return [[this.keyLabel(COPY_ACTION, 'ctrl+y'), 'copy'], [this.keyLabel('back', 'esc'), 'done, hide it']];
    if (this.choosing) {
      const up = this.keyLabel('move-up', 'up');
      const down = this.keyLabel('move-down', 'down');
      return [[up === 'up' && down === 'down' ? '↑↓' : `${up}/${down}`, 'choose'], [this.keyLabel('choose', '⏎'), 'answer'], [this.keyLabel('back', 'esc'), 'back']];
    }
    const up = this.keyLabel('move-up', 'up');
    const down = this.keyLabel('move-down', 'down');
    const moveCap = up === 'up' && down === 'down' ? '↑↓' : `${up}/${down}`;
    if (this.keyList) return [[moveCap, 'choose'], [this.keyLabel('choose', '⏎'), 'run it'], [this.keyLabel('back', 'esc'), 'back']];
    if (this.result) {
      return [[moveCap, 'scroll'], [`${this.keyLabel('scroll-page-up', 'pgup')}/${this.keyLabel('scroll-page-down', 'pgdn')}`, 'a page'], [this.keyLabel('back', 'esc'), 'back to the list']];
    }
    // The selected item's own actions first, then the tab's and the place's, then reading and moving.
    const bound = this.boundActions();
    const own = bound.filter((entry) => this.onItem(entry.action)).map((entry) => [entry.cap, entry.label] as const);
    const wide = bound.filter((entry) => !this.onItem(entry.action)).map((entry) => [entry.cap, entry.label] as const);
    const general: KitHint[] = [[keycapOf(this.host.keys, `${this.context}.${READ_AGAIN_ACTION}`, READ_AGAIN_KEY), 'read again'], [moveCap, 'move']];
    if (this.lists.length > 1) general.push([this.keyLabel('next-field', 'tab'), 'next list']);
    const all: KitHint[] = [...own, ...wide, ...general];
    if (width === undefined || layoutHintRows(all, width).length <= HINT_ROWS_MAX) return all;
    // Two rows at most: what fits, in that order, then one entry that lists every key (the detail keeps the rest of the height).
    const more: KitHint = [keycapOf(this.host.keys, `${this.context}.${MORE_KEYS_ACTION}`, MORE_KEYS_KEY), 'more keys'];
    const shown: KitHint[] = [];
    for (const hint of all) {
      if (layoutHintRows([...shown, hint, more], width).length <= HINT_ROWS_MAX) shown.push(hint);
    }
    return [...shown, more];
  }

  /**
   * The reveal pane: what the value is, the value whole (broken across lines only where it is longer than the pane is
   * wide), its QR code when one was asked for and fits, and its note. Nothing of it reaches the outcome line.
   */
  private renderReveal(f: ReturnType<typeof beginModal>, shown: CapabilityRevealed, copied: string | undefined): SurfaceLayer {
    const t = activeTokens();
    const width = Math.max(10, f.r - f.l - 1);
    let y = f.top;
    const put = (text: string, style: { readonly fg: string; readonly bold?: boolean }): void => {
      if (y < f.bottom) f.canvas.put(f.l + 1, y, text, { fg: style.fg, ...(style.bold ? { bold: true } : {}) });
      y += 1;
    };
    put(shown.label, { fg: t.text, bold: true });
    y += 1;
    for (let at = 0; at < shown.value.length; at += width) put(shown.value.slice(at, at + width), { fg: t.primary, bold: true });
    y += 1;
    const qr = shown.qr ? shown.qr.split('\n') : [];
    // The QR code is drawn only when it fits whole: a cut QR code scans as nothing.
    const noteLines = wrapLines(shown.note, width);
    if (qr.length > 0 && qr.length + noteLines.length + 3 <= f.bottom - y && Math.max(...qr.map((line) => [...line].length)) <= width) {
      for (const line of qr) put(line, { fg: t.text });
      y += 1;
    }
    for (const line of noteLines) put(line, { fg: t.textMuted });
    if (copied) { y += 1; put(`${copied}.`, { fg: t.text }); }
    return finishModal(f);
  }

  /**
   * The selected item's detail, scrolled: a detail longer than its pane is read a page at a time with the page keys
   * as bound (`scroll-page-up`/`scroll-page-down`) or the wheel over it, and its last row names the key that shows more.
   */
  private drawDetail(f: ReturnType<typeof beginModal>, box: ReturnType<typeof inset>, key: string, paragraphs: readonly InsetLine[]): void {
    const t = activeTokens();
    const lines: InsetLine[] = [];
    for (const para of paragraphs) {
      if (para.text === '') lines.push(para);
      else for (const text of wrapLines(para.text, box.r - box.l + 1)) lines.push({ text, style: para.style });
    }
    const room = Math.max(1, box.bottom - box.top + 1);
    const overflow = lines.length > room;
    // One row is kept for the line that says how to see more.
    const page = overflow ? Math.max(1, room - 1) : room;
    const maxOffset = overflow ? lines.length - page : 0;
    if (this.detailScroll.key !== key) this.detailScroll = { key, offset: 0, page, max: maxOffset };
    this.detailScroll.page = page;
    this.detailScroll.max = maxOffset;
    this.detailScroll.offset = Math.min(Math.max(0, this.detailScroll.offset), maxOffset);
    const offset = this.detailScroll.offset;
    let y = box.top;
    for (const line of lines.slice(offset, offset + page)) f.canvas.put(box.l, y++, line.text, { ...line.style, bg: box.bg });
    if (overflow) {
      const below = lines.length - offset - page;
      const down = this.keyLabel('scroll-page-down', 'pgdn');
      const up = this.keyLabel('scroll-page-up', 'pgup');
      const said = below > 0 ? `${below} more lines: ${down} shows them` : `${up} goes back up`;
      f.canvas.put(box.l, box.top + page, said.slice(0, box.r - box.l + 1), { fg: t.textFaint, bg: box.bg });
    }
    f.canvas.hitTargets.push({ id: 'place-detail', x: box.x, y: box.y, width: box.w, height: box.h, onWheel: (direction) => this.scrollDetail(direction) });
  }

  /** An action's whole answer, in its own pane: wrapped, scrolled a line or a page at a time, Esc back to the list. */
  private renderResult(f: ReturnType<typeof beginModal>, result: ResultPane): SurfaceLayer {
    const t = activeTokens();
    const width = Math.max(10, f.r - f.l - 1);
    f.canvas.put(f.l + 1, f.top, result.title, { fg: t.text, bold: true });
    const lines = result.lines.flatMap((line) => line.trim() === '' ? [''] : wrapLines(line, width));
    const top = f.top + 2;
    const room = Math.max(1, f.bottom - top + 1);
    const overflow = lines.length > room;
    result.page = overflow ? Math.max(1, room - 1) : room;
    result.max = overflow ? lines.length - result.page : 0;
    result.offset = Math.min(Math.max(0, result.offset), result.max);
    let y = top;
    for (const line of lines.slice(result.offset, result.offset + result.page)) f.canvas.put(f.l + 1, y++, line, { fg: t.text });
    if (overflow) {
      const below = lines.length - result.offset - result.page;
      const said = below > 0 ? `${below} more lines: ${this.keyLabel('scroll-page-down', 'pgdn')} shows them` : `${this.keyLabel('scroll-page-up', 'pgup')} goes back up`;
      f.canvas.put(f.l + 1, top + result.page, said, { fg: t.textFaint });
    }
    f.canvas.hitTargets.push({ id: 'place-result', x: f.l, y: top, width: f.r - f.l + 1, height: room, onWheel: (direction) => {
      result.offset = Math.min(Math.max(0, result.offset + direction), result.max);
      this.host.requestRender();
    } });
    return finishModal(f);
  }

  /** Move the detail by a step: a page from the keys, a line per wheel step. */
  private scrollDetail(direction: -1 | 1, step = 1): void {
    this.detailScroll.offset = Math.min(Math.max(0, this.detailScroll.offset + direction * step), this.detailScroll.max);
    this.host.requestRender();
  }

  /** The list "more keys" opens: every key that applies now, as bound, each runnable by Enter, a click or the key itself. */
  private renderKeyList(f: ReturnType<typeof beginModal>, top: number, bottom: number): SurfaceLayer {
    const t = activeTokens();
    const entries = this.keyListEntries();
    const keyList = this.keyList!;
    if (keyList.index >= entries.length) keyList.index = Math.max(0, entries.length - 1);
    const list = this.place.lists[this.active]!;
    f.canvas.put(f.l + 1, top, `Every key here, on ${list.label}:`, { fg: t.text, bold: true });
    const capWidth = Math.max(0, ...entries.map((entry) => [...entry.cap].length));
    const rows: KitRow[] = entries.map((entry, index) => ({
      label: `${entry.cap.padEnd(capWidth)}  ${entry.label}`,
      selected: index === keyList.index,
      onClick: () => { this.keyList = undefined; entry.run(); this.host.requestRender(); },
    }));
    const listed = drawList(f.canvas, { mouseNavigation: true, rows, top: Math.min(top + 2, bottom), bottom, x0: f.l + 1 + MODAL_MARK_INSET, x1: f.r - MODAL_MARK_INSET, scrollKey: { owner: this, name: 'place-keys' } });
    f.hintRight = scrollCountText(listed.above, listed.below);
    return finishModal(f);
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    const t = activeTokens();
    const capture = this.capture;
    const readAgain = keycapOf(this.host.keys, `${this.context}.${READ_AGAIN_ACTION}`, READ_AGAIN_KEY);
    // The hints are laid out in the width the modal gives them, so the row can stop at two lines.
    const hintWidth = hintLayoutWidth(modalInnerWidth(modalGeometry(screenWidth, screenHeight).w));
    const hints: KitHint[] = capture ? [[this.keyLabel('back', 'esc'), 'keep the key as it is']] : this.hints(hintWidth);
    const f = beginModal(screenWidth, screenHeight, { title: this.place.title, hints });
    if (this.revealed) return this.renderReveal(f, this.revealed.shown, this.revealed.copied);
    if (this.result) return this.renderResult(f, this.result);
    let y = f.top;
    const list = this.place.lists[this.active]!;
    const state = this.lists[this.active]!;
    if (this.place.lists.length > 1) {
      tabs(f.canvas, f.l + 1, y, this.place.lists.map((entry, index) => {
        const read = this.lists[index]!;
        return read.status === 'ready' && read.items.length > 0 ? `${entry.label} ${read.items.length}` : entry.label;
      }), this.active, f.r, (index) => { this.active = index; this.choosing = undefined; this.host.requestRender(); });
      y += 2;
    }
    // The outcome of the last action, and a list that may be old, sit under the hints' blank row.
    const notes: Array<{ readonly text: string; readonly fg: string; readonly bg?: string | undefined; readonly bold?: boolean | undefined }> = [];
    if (capture) notes.push({ text: capture.leader ? `${capture.prompt} ${this.keyLabel('leader', 'the leader')} then…` : capture.prompt, fg: t.text });
    else if (this.choosing) {
      notes.push({ text: 'Answer:', fg: t.text });
      this.choosing.answers.forEach((answer, index) => {
        const selected = index === this.choosing!.index;
        notes.push({ text: `${selected ? '▸' : ' '} ${answer.key}  ${answer.label}`, fg: selected ? t.selectedListItemText : t.text, ...(selected ? { bg: t.primary, bold: true } : {}) });
      });
    } else if (this.message && this.message.tab === this.active) notes.push({ text: this.message.text, fg: this.message.tone === 'warning' ? t.warning : t.text });
    if (state.lost && state.status !== 'failed') notes.push({ text: `This list may be out of date: ${state.lost}. It is read again by itself when the daemon answers again; ${readAgain} reads it now.`, fg: t.textMuted });
    const noteLines = notes.flatMap((note) => wrapLines(note.text, Math.max(10, f.r - f.l - 1)).map((text) => ({ text, fg: note.fg, bg: note.bg, bold: note.bold })));
    const bottom = Math.max(y, f.bottom - (noteLines.length > 0 ? noteLines.length + 1 : 0));
    noteLines.forEach((line, index) => f.canvas.put(f.l + 1, bottom + 2 + index, line.text, { fg: line.fg, ...(line.bg ? { bg: line.bg } : {}), ...(line.bold ? { bold: true } : {}) }));

    if (this.keyList) return this.renderKeyList(f, y, bottom);

    if (state.status === 'failed') {
      const said = [
        `Could not read ${list.noun}: ${state.reason ?? 'no reason was given'}.`,
        `The list is read again by itself when the daemon answers again; ${readAgain} reads it now.`,
      ];
      let row = y;
      said.forEach((text, index) => {
        for (const line of wrapLines(text, Math.max(10, f.r - f.l - 1))) f.canvas.put(f.l + 1, row++, line, { fg: index === 0 ? t.warning : t.textMuted });
      });
      return finishModal(f);
    }
    if (state.status === 'reading' && state.items.length === 0) {
      f.canvas.put(f.l + 1, y, `Reading ${list.noun}…`, { fg: t.textMuted });
      return finishModal(f);
    }
    if (state.items.length === 0) {
      // What would be listed here, whole (wrapped, never cut), and only the keys that act on this list.
      const makers = this.emptyMakers(list);
      const width = Math.max(10, f.r - f.l - 1);
      let row = y;
      for (const line of wrapLines(list.empty, width)) if (row <= bottom) f.canvas.put(f.l + 1, row++, line, { fg: t.text });
      if (makers.length > 0) {
        row += 1;
        for (const line of wrapLines(`Press ${makers.join(' or ')}.`, width)) if (row <= bottom) f.canvas.put(f.l + 1, row++, line, { fg: t.textMuted });
      }
      return finishModal(f);
    }

    const split = splitListDetail(f.l + 1, f.r, y, bottom, 0.45);
    const selected = this.selectedIndex(state);
    const rows: KitRow[] = state.items.map((item, index) => {
      const row = list.row(item);
      const markFg = row.mark === 'attention' ? t.warning : row.mark === 'paused' ? t.textMuted : row.mark === 'ok' ? t.success : t.info;
      return {
        label: row.title,
        ...(row.right ? { right: row.right } : {}),
        ...(row.mark ? { mark: MARKS[row.mark], markFg } : {}),
        selected: index === selected,
        onClick: () => { state.selectedId = item.id; this.choosing = undefined; this.host.requestRender(); },
      };
    });
    const listed = drawList(f.canvas, { mouseNavigation: true, rows, top: split.top, bottom: split.bottom, x0: split.x0 + MODAL_MARK_INSET, x1: split.x1 - MODAL_MARK_INSET, scrollKey: { owner: this, name: `place-${list.id}` } });
    f.hintRight = scrollCountText(listed.above, listed.below);
    const item = state.items[selected];
    if (item && split.detailH >= 3) {
      const box = inset(f.canvas, split.detailX, split.detailY, split.detailW, split.detailH);
      const lines: InsetLine[] = [{ text: list.row(item).title, style: { fg: t.text, bold: true } }, { text: '', style: {} }];
      for (const line of list.detail(item)) {
        const fg = line.tone === 'warning' ? t.warning : line.tone === 'muted' ? t.textMuted : t.text;
        lines.push({ text: line.label ? `${line.label}: ${line.text}` : line.text, style: { fg } });
      }
      this.drawDetail(f, box, `${this.active}:${item.id}`, lines);
    }
    return finishModal(f);
  }
}
