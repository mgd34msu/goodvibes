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
 * (place-keys.ts); pressing one is the request: it runs and the place says
 * what happened and how to undo it. An action that cannot be undone or
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
import { beginModal, finishModal, MODAL_MARK_INSET, scrollCountText, wrapLines, type KitHint, type SurfaceLayer } from '../renderer/surface-kit.js';
import { drawList, type KitRow } from '../renderer/surface-kit-list.js';
import { splitListDetail } from '../renderer/surface-kit-extra.js';
import { inset, insetLines, tabs, type InsetLine } from '../renderer/surface-kit-parts.js';
import { activeTokens } from '../renderer/theme.js';
import { actionButton, actionDoneLine, actionSentence, effectiveRisk, isShown, riskWords } from '../command-actions/typed-line.js';
import type { ActionValues } from '../command-actions/types.js';
import { keycapOf, plainReason, reasonOf, type PlaceHost, type PlacePrograms } from './place-host.js';
import { inPlaceKeyContext, isNavigationKey, placeActionName, placeKeyContextId, READ_AGAIN_ACTION } from './place-keys.js';
import type { AnyPlace, PlaceAction, PlaceAnswer, PlaceCapabilityAction, PlaceItem, PlaceList, PlaceRow } from './place-types.js';

/** The read-again key's default (its entry in each place's key context, place-keys.ts). */
export const READ_AGAIN_KEY = 'r';

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
  return list.source.items(source.read());
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
  private message: { readonly text: string; readonly tone: 'plain' | 'warning' } | undefined;
  private busy = false;
  private closed = false;
  private readonly stops: Array<() => void> = [];
  private followStops: Array<() => void> = [];
  private capture: { readonly prompt: string; readonly resolve: (combo: KeyCombo | undefined) => void; leader: boolean } | undefined;
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
      if (action.list === undefined) { bound.push({ cap: this.capOf(action), label: this.label(action), action }); continue; }
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
  private shown(values: ActionValues, item: PlaceItem | undefined): ActionValues {
    if (!item) return values;
    const title = this.place.lists[this.active]!.row(item).title;
    return Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value === item.id ? `"${title}"` : value]));
  }

  private async press(bound: BoundAction): Promise<void> {
    const item = bound.action.list === undefined ? undefined : this.selectedItem();
    if (bound.action.kind === 'program') {
      const run = this.host.programAction(bound.action.run);
      if (!run || !item) return;
      this.busy = true;
      try {
        const said = await run(item.id, this.programs());
        if (said) this.message = { text: said, tone: 'plain' };
      } catch (error) {
        this.message = { text: `Not done: ${reasonOf(error)}`, tone: 'warning' };
      } finally {
        this.busy = false;
        this.readAll();
        this.host.requestRender();
      }
      return;
    }
    const action = bound.action;
    const resolved = this.host.capability(action.capability);
    if (!resolved) { this.message = { text: `${bound.label}: not available in this program.`, tone: 'warning' }; return; }
    let values: ActionValues = this.filled(action, item, bound.answer?.values);
    // Inputs the item does not give are asked in a form built from the capability's inputs.
    const missing = resolved.action.inputs.some((input) => input.required === true && values[input.id] === undefined && isShown(input, values) && !('impliedBy' in input.typed));
    if (missing) {
      const given = Object.keys(this.filled(action, item, undefined));
      const shown = this.shown(values, item);
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
        body: `${actionSentence(resolved.action, this.shown(values, item))} This ${riskWords(risk)}.`,
        confirmLabel: actionButton(resolved.action),
      });
      if (!yes) { this.host.requestRender(); return; }
    }
    this.busy = true;
    this.message = { text: `${resolved.action.label}…`, tone: 'plain' };
    this.host.requestRender();
    const outcome = await this.host.runCapability(action.capability, values);
    this.busy = false;
    if (!outcome.ok) {
      this.message = { text: `Not done: ${outcome.reason}`, tone: 'warning' };
    } else {
      const done = actionDoneLine(resolved.action, this.shown(values, item));
      const plain = actionDoneLine(resolved.action, values);
      // The place names items by title: the item's own id in a line becomes its title, and a line
      // naming another record by a long id (a run's) says nothing a person reads.
      const title = item ? `"${this.place.lists[this.active]!.row(item).title}"` : '';
      // The item's id, or a short form of it (a command prints the first characters), becomes its title.
      const named = (word: string): boolean => item !== undefined && (word === item.id || (word.length >= 8 && item.id.startsWith(word)));
      // An answer is named as the person pressed it ("No"), never by the value it stored ("deny").
      const said = bound.answer?.said;
      const sent = said ? Object.values(bound.answer?.values ?? {}).filter((value) => value !== '' && value !== said) : [];
      const asPressed = (line: string): string => sent.reduce((current, value) => current.replace(`: ${value}`, `: ${said}`), line);
      const rest = outcome.lines
        .filter((line) => line !== plain && line !== done)
        .map(asPressed)
        .map((line) => item ? line.replace(/[\w-]+/g, (word) => named(word) ? title : word) : line)
        .filter((line) => !/\S{28,}/.test(line));
      const undo = this.undoHint(resolved.action.undoneBy);
      // Lines are said as one paragraph: each ends as a sentence.
      const sentence = (line: string): string => /[.!?:)"]$/.test(line.trimEnd()) ? line.trimEnd() : `${line.trimEnd()}.`;
      this.message = { text: [done || rest.shift() || 'Done.', ...rest.slice(0, 2), ...(undo ? [undo] : [])].map(sentence).join(' '), tone: 'plain' };
    }
    this.readAll();
    this.host.requestRender();
  }

  /** How to undo what just ran: the key of the place's action that undoes it, as bound. */
  private undoHint(undoneBy: string | undefined): string | undefined {
    if (!undoneBy) return undefined;
    for (const action of this.place.actions) {
      if (action.kind === 'program') continue;
      const resolved = this.host.capability(action.capability);
      if (resolved?.action.id === undoneBy) return `To undo: ${this.capOf(action)} ${this.label(action)}.`;
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
    const key = keyOf(token)?.logicalName;
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
    const bound = this.pressed(token);
    if (bound) { void this.press(bound); return; }
    const names = (() => { const read = keyOf(token); return read ? this.host.keys.lookupInContext(this.context, read) : []; })();
    if (names.includes(READ_AGAIN_ACTION)) { this.message = undefined; this.readAll(); return; }
    if (key === 'enter' && this.openAnswers()) { this.host.requestRender(); return; }
    if (key === 'up') this.move(-1);
    else if (key === 'down') this.move(1);
    else if (key === 'tab' || key === 'right') this.active = (this.active + 1) % this.lists.length;
    else if (key === 'left') this.active = (this.active - 1 + this.lists.length) % this.lists.length;
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

  private isLeader(combo: KeyCombo): boolean {
    const leader = this.host.keys.getAll().find((entry) => entry.action === 'leader')?.combos ?? [];
    return leader.some((bound) => bound.key === combo.key && !bound.ctrl === !combo.ctrl && !bound.shift === !combo.shift && !bound.alt === !combo.alt);
  }

  escape(): boolean {
    if (this.capture) { const capture = this.capture; this.capture = undefined; capture.resolve(undefined); return true; }
    if (this.choosing) { this.choosing = undefined; this.host.requestRender(); return true; }
    return false;
  }

  onClose(_reason: SurfaceModalCloseReason): void {
    this.closed = true;
    for (const stop of this.stops.splice(0)) stop();
    for (const stop of this.followStops.splice(0)) stop();
  }

  /** The counts the lists hold as read now, for the menu row of this place. */
  itemsByList(): Readonly<Record<string, readonly PlaceItem[]>> {
    return Object.fromEntries(this.place.lists.map((list, index) => [list.id, this.lists[index]!.items]));
  }

  // -- drawing -----------------------------------------------------------

  private hints(): KitHint[] {
    if (this.choosing) {
      const up = this.keyLabel('move-up', 'up');
      const down = this.keyLabel('move-down', 'down');
      return [[up === 'up' && down === 'down' ? '↑↓' : `${up}/${down}`, 'choose'], [this.keyLabel('choose', '⏎'), 'answer'], [this.keyLabel('back', 'esc'), 'back']];
    }
    const hints: KitHint[] = this.boundActions().map((bound) => [bound.cap, bound.label] as const);
    hints.push([keycapOf(this.host.keys, `${this.context}.${READ_AGAIN_ACTION}`, READ_AGAIN_KEY), 'read again']);
    const up = this.keyLabel('move-up', 'up');
    const down = this.keyLabel('move-down', 'down');
    hints.push([up === 'up' && down === 'down' ? '↑↓' : `${up}/${down}`, 'move']);
    if (this.lists.length > 1) hints.push([this.keyLabel('next-field', 'tab'), 'next list']);
    return hints;
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    const t = activeTokens();
    const capture = this.capture;
    const readAgain = keycapOf(this.host.keys, `${this.context}.${READ_AGAIN_ACTION}`, READ_AGAIN_KEY);
    const hints: KitHint[] = capture ? [[this.keyLabel('back', 'esc'), 'keep the key as it is']] : this.hints();
    const f = beginModal(screenWidth, screenHeight, { title: this.place.title, hints });
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
    } else if (this.message) notes.push({ text: this.message.text, fg: this.message.tone === 'warning' ? t.warning : t.text });
    if (state.lost && state.status !== 'failed') notes.push({ text: `This list may be out of date: ${state.lost}. It is read again by itself when the daemon answers again; ${readAgain} reads it now.`, fg: t.textMuted });
    const noteLines = notes.flatMap((note) => wrapLines(note.text, Math.max(10, f.r - f.l - 1)).map((text) => ({ text, fg: note.fg, bg: note.bg, bold: note.bold })));
    const bottom = Math.max(y, f.bottom - (noteLines.length > 0 ? noteLines.length + 1 : 0));
    noteLines.forEach((line, index) => f.canvas.put(f.l + 1, bottom + 2 + index, line.text, { fg: line.fg, ...(line.bg ? { bg: line.bg } : {}), ...(line.bold ? { bold: true } : {}) }));

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
      const makers = this.boundActions().filter((bound) => bound.action.list === undefined).map((bound) => `${bound.cap} (${bound.label})`);
      f.canvas.put(f.l + 1, y, list.empty, { fg: t.text });
      if (makers.length > 0) f.canvas.put(f.l + 1, y + 2, `Press ${makers.join(' or ')}.`, { fg: t.textMuted });
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
      insetLines(f.canvas, box, box.l, box.top, lines);
    }
    return finishModal(f);
  }
}
