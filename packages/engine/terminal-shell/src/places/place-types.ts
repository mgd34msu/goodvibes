/**
 * place-types.ts, how a place is declared: data, not drawing.
 *
 * A place is a screen for one function group (Automation, Waiting for you,
 * ...): one or more lists of live items read from a source, a selection, a
 * detail for the selected item, and actions. An action is a capability: the
 * place names it by its id (`schedule.pause`) and says which item states it
 * applies to and which of its inputs the selected item fills. The terminal
 * programs draw a declaration with the place framework (place-modal.ts); the
 * web UI will draw the same declaration with its own components, so nothing
 * here knows how it is drawn.
 */
import type { ActionValues } from '../command-actions/types.js';

/** The fourteen function groups (platform capabilities/groups.ts): one place each. */
export type PlaceGroupId = 'conversation' | 'sessions' | 'code' | 'work' | 'waiting' | 'models' | 'safety' | 'tools'
  | 'memory' | 'messages' | 'automation' | 'devices' | 'money' | 'system';

/** Every item has an id and a state (the word its actions are attached to). */
export interface PlaceItem {
  readonly id: string;
  readonly state: string;
}

/**
 * Where a list's items come from.
 *
 * - `daemon`: a daemon method, called with `input`; `items` turns its answer into items.
 * - `session`: a source of the program holding the conversation, by name
 *   (`held-calls`): the program supplies it (place-host.ts), with its own
 *   change notices.
 * - `program`: a source of the terminal program itself, by name (`keys`: its key table).
 */
export type PlaceSource<Item extends PlaceItem> =
  | { readonly kind: 'daemon'; readonly method: string; readonly input: Readonly<Record<string, unknown>>; readonly items: (output: unknown) => readonly Item[] }
  | { readonly kind: 'session'; readonly name: string; readonly items: (raw: unknown) => readonly Item[] }
  | { readonly kind: 'program'; readonly name: string; readonly items: (raw: unknown) => readonly Item[] };

/**
 * What a daemon-sourced list follows, so it reads itself again when it
 * changes elsewhere: whole domains (`automation`), named wire events
 * (`owner-inbox-update`), LIST_CHANGED lists (`memory`).
 */
export interface PlaceFollow {
  readonly domains: readonly string[];
  readonly events: readonly string[];
  readonly lists?: readonly string[] | undefined;
}

/** How an item looks in its list: what it is called, a short state on the right, a mark. */
export interface PlaceRow {
  readonly title: string;
  readonly right?: string | undefined;
  /** ok ● | paused ○ | attention ▲ | running ◐ | waiting ? */
  readonly mark?: 'ok' | 'paused' | 'attention' | 'running' | 'waiting' | undefined;
}

/** One line of an item's detail: a label and its value, or a paragraph. */
export interface PlaceDetailLine {
  readonly label?: string | undefined;
  readonly text: string;
  readonly tone?: 'plain' | 'muted' | 'warning' | undefined;
}

export interface PlaceList<Item extends PlaceItem> {
  readonly id: string;
  /** The tab's words: "Schedules". */
  readonly label: string;
  /** What the list holds, for a sentence: "your schedules". */
  readonly noun: string;
  readonly source: PlaceSource<Item>;
  readonly follows?: PlaceFollow | undefined;
  /** What an empty list says: "No schedules yet." The place adds the action that makes one. */
  readonly empty: string;
  readonly row: (item: Item) => PlaceRow;
  readonly detail: (item: Item) => readonly PlaceDetailLine[];
  /**
   * The programs that have the thing this list shows (`['tui']`: only the terminal app records runs). A program not
   * named leaves the tab out, as the web view leaves out a list with no web side. Absent: every program has it.
   */
  readonly programs?: readonly PlaceProgramName[] | undefined;
}

/** A program a place is drawn in: the terminal app, the Agent, the web UI. */
export type PlaceProgramName = 'tui' | 'agent' | 'web';

/**
 * An action on the selected item (or on the place, with no `list`): a
 * capability by id, shown on the hint row as `key` while the selected item
 * is in one of `states`. `fill` gives the capability's inputs from the item:
 * a field name of the item, or a function. Inputs not filled open a form
 * built from the capability's inputs.
 */
export interface PlaceCapabilityAction<Item extends PlaceItem> {
  readonly kind?: 'capability' | undefined;
  /**
   * Its default key: a letter is a rebindable entry of the place's key context
   * (`place.<place>.<id>` in keybindings.json); `enter`, `tab`, `escape` or an
   * arrow is the table's navigation key of that name, wherever it is bound;
   * `''` is an entry with no default key, shown and pressed only once a person
   * binds it in the Keys place.
   */
  readonly key: string;
  /** Its name in the place's key context; the label in lower case with dashes when absent. */
  readonly id?: string | undefined;
  /** A capability id as A's registry names it (`schedule.pause`): its declared id, else `<command>.<word>`. */
  readonly capability: string;
  readonly list?: string | undefined;
  readonly states?: readonly string[] | undefined;
  /**
   * It acts on the list's kind of thing, not on the selected item ("watch for something" on the Triggers tab):
   * shown while its list is the open tab, whether or not an item is selected, and given nothing from an item.
   */
  readonly whole?: true | undefined;
  /**
   * It always opens its form, even when every input the item does not give is optional: a change of several
   * fields, each blank keeping what is set (an address). Without it, an action with nothing required left runs at once.
   */
  readonly form?: true | undefined;
  /** The hint's words; the capability's label is used when absent. */
  readonly label?: string | undefined;
  readonly fill?: Readonly<Record<string, string | ((item: Item) => string)>> | undefined;
  /**
   * One action per answer the item offers (an inbox item's options): each
   * with its own key, words and filled inputs. Replaces `key` and `label`.
   * The keys are the item's own (the daemon words every surface's), not the
   * place's key table. `refuses` marks the answer that says no; `opensOn` the
   * one the answer list starts on (the refusing one for an ask that loosens a
   * protection).
   */
  readonly answers?: ((item: Item) => readonly PlaceAnswer[]) | undefined;
  /**
   * It answers the waiting item itself (a question, an approval, a held
   * call): the item is the question, so pressing it never asks again
   * (place-modal.ts). An action with `answers` is one.
   */
  readonly answersItem?: true | undefined;
  /**
   * The programs that have this control (`['tui']`: the Agent keeps one line of conversation, so it has no "Branch this
   * conversation here"), as `PlaceList.programs` says for a list: a program not named shows no control for it.
   * Absent: every program that resolves the capability has it.
   */
  readonly programs?: readonly PlaceProgramName[] | undefined;
}

/** One answer an item offers, as a key on the hint row and a row of its answer list. */
export interface PlaceAnswer {
  readonly key: string;
  readonly label: string;
  readonly values: ActionValues;
  /**
   * The answer as the person pressed it, in its own words ("No", "Yes, once"): the outcome line names the
   * choice by these, never by the stored value it sends ("deny").
   */
  readonly said?: string | undefined;
  readonly refuses?: true | undefined;
  readonly opensOn?: true | undefined;
}

/**
 * An action of the terminal program itself that is not a capability (the
 * Keys place's "change this key"): it runs in the program, on the item.
 */
export interface PlaceProgramAction<Item extends PlaceItem> {
  readonly kind: 'program';
  /** Its default key, as for a capability action. */
  readonly key: string;
  /** Its name in the place's key context; the label in lower case with dashes when absent. */
  readonly id?: string | undefined;
  readonly label: string;
  readonly list?: string | undefined;
  readonly states?: readonly string[] | undefined;
  /** The program's handler by name (place-host.ts `programAction`). */
  readonly run: string;
}

export type PlaceAction<Item extends PlaceItem> = PlaceCapabilityAction<Item> | PlaceProgramAction<Item>;

/** The count a menu row shows: something waiting or wrong. */
export interface PlaceCount {
  readonly count: number;
  readonly words: string;
  readonly tone: 'waiting' | 'wrong';
}

export interface PlaceDeclaration<Item extends PlaceItem = PlaceItem> {
  readonly id: string;
  readonly group: PlaceGroupId;
  readonly title: string;
  readonly lists: readonly PlaceList<Item>[];
  readonly actions: readonly PlaceAction<Item>[];
  /** From the lists as read: what waits or is wrong, for the menu. Undefined: nothing to count. */
  readonly count?: ((lists: Readonly<Record<string, readonly Item[]>>) => PlaceCount | undefined) | undefined;
}

/** A declaration with its item type erased, for registries and the menu. */
export type AnyPlace = PlaceDeclaration<PlaceItem>;

/** Declare a place (keeps its item type for the lists and actions). */
export function definePlace<Item extends PlaceItem>(place: PlaceDeclaration<Item>): AnyPlace {
  return place as unknown as AnyPlace;
}
