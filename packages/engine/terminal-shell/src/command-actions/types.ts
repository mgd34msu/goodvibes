/**
 * One description of a slash command: what it can do (its actions), what each
 * action needs (its inputs), what each one says before and after it runs, and
 * what it touches. Everything else a command used to write by hand (usage,
 * argument hints, subcommand hints, effect, read verbs, secret arguments, free
 * text, the confirmation question, the help entry, the guided path in the
 * terminal, completion, the web UI's sheet and the model's catalogue entry) is
 * produced from this one object, so no two of them can disagree.
 */
import type { ConfirmationHost } from '../command-confirmation.js';
import type { OpenSelection } from '../selection-modal.js';
import type { ConcealedInputRequest } from '../concealed-input.js';
import type { PlainLineInputRequest } from '../plain-line-input.js';
import type { SurfaceModal } from '../surface-modal-host.js';

import type { ActionRisk, ActionLasts, ActionTouches, ActionValues, CapabilityDeclaration, InputDescription } from '@goodvibes/engine/platform/platform/capabilities';

/**
 * An action IS a capability: the input shapes, risk, lifetime and touch words
 * are defined once with the capabilities in the platform (where an action's
 * definition goes when it moves beside its handler) and only re-exported here.
 */
export type {
  ActionLasts, ActionRisk, ActionTouches, ActionValues, CapabilityDeclaration, FixedChoice, InputDescription, InputKind, ListChoices, ListName,
} from '@goodvibes/engine/platform/platform/capabilities';
export { LASTS_WORDS, RISK_DONE_WORDS, RISK_WORDS } from '@goodvibes/engine/platform/platform/capabilities/words';

export interface ActionDescription<Ctx> {
  readonly id: string;
  /**
   * What makes the action a capability on its own: its id, function group,
   * home and what a repeat does. An action that carries it is reached by
   * capability find and run; one moved to its home is built from its
   * definition in the platform (capabilityAction, capability-actions.ts).
   */
  readonly capability?: CapabilityDeclaration | undefined;
  /** Named for what you get: "Block a tool". */
  readonly label: string;
  /** The confirming button's words when the label's verb cannot be read from it (actionButton, typed-line.ts): "Let them run it". */
  readonly button?: string | undefined;
  /** The only typed spelling: `block`. */
  readonly word: string;
  readonly inputs: readonly InputDescription[];
  /** What is about to happen, with `{input}` blanks and `{lasts}`: "Every call to {tool} on {server} will be refused {lasts}." */
  readonly sentence: string;
  /** What happened: "Blocked {tool} on {server} {lasts}." */
  readonly done: string;
  readonly touches: ActionTouches;
  readonly lasts: ActionLasts | 'not-a-change';
  readonly risk: ActionRisk;
  /**
   * What the act did, said after the result in place of the risk's own words
   * ({@link RISK_DONE_WORDS}, "This spent money."), whenever those would not be
   * true of what ran: the risk names what may follow, so approving a purchase
   * ahead says "Nothing has been bought yet: ...", never "This spent money.".
   * One or more whole sentences, with `{input}` blanks. Absent: the risk's words,
   * which must then be true of every run.
   */
  readonly riskDone?: string | undefined;
  /** Only counts when the owner types it; a model is refused with the reason and what it may do instead. */
  readonly ownerOnly?: { readonly reason: string; readonly instead: string } | undefined;
  /**
   * The action asks its own question before it does what its risk names, with
   * what it read at that moment (and refuses where it cannot ask). The kit then
   * asks nothing first, on a typed line or on the guided path, so the person is
   * asked once; its risk is still shown beside it on the first screen, in help
   * and in the catalogue.
   */
  readonly asksItself?: true | undefined;
  /**
   * Its outcome carries a value the person must see once (platform capabilities/types.ts `reveals`): a place shows
   * it whole in its own pane with the copy key, until the person leaves it, and nowhere else.
   */
  readonly reveals?: { readonly label: string; readonly note: string } | undefined;
  /** The action id that undoes this one. */
  readonly undoneBy?: string | undefined;
  /**
   * How the web UI runs it: an operator method and which input fills which
   * field, or why only a terminal can. With `preview`, `fields` fill that
   * method's input instead (plus `zone`, the browser's time zone): it reads
   * the values the way `run` does (a described time, a trigger's definition)
   * and answers `{ summary, input }`; the sheet shows the summary above its
   * button and then runs `method` with `input`. Nothing is kept by a preview.
   */
  readonly operator?: { readonly method: string; readonly fields: Readonly<Record<string, string>>; readonly preview?: string | undefined } | { readonly terminalOnly: string } | undefined;
  /** Filled-in inputs for the help entry and the round-trip check. */
  readonly example: ActionValues;
  /**
   * Does the action. Throws a refusal (`commandRefusal`) when it did not do
   * what was asked. A read prints what it shows; a change may return one more
   * line of fact (where a rule was kept), printed under the done line.
   */
  readonly run: (values: ActionValues, ctx: Ctx) => Promise<string | CommandReport | void>;
  /** A question shown at the top of a form step, by step (index 0 is step 1); empty for none. */
  readonly stepTitles?: readonly string[] | undefined;
  /** A short live value beside the action's row on the first screen ("none connected yet"), read when the list opens. */
  readonly rowValue?: ((ctx: Ctx) => Promise<string>) | undefined;
  /**
   * On a command's report action: it reads only this machine's own files and
   * settings, never a mailbox, a daemon or remote host, or a provider, and costs
   * nothing to run. The Agent workspace reads every report by itself; it marks
   * an old reading "may be out of date" only for a report without this flag,
   * since only those change on their own.
   */
  readonly readsOnlyThisMachine?: true | undefined;
  /**
   * Chosen from the bare command's list, the action runs at once with its
   * defaults and shows no form: its blanks are only typed (`/settings open
   * permissions`). Only for an action whose blanks are all optional and whose
   * result has its own way to choose them (the settings screen's topics and search).
   */
  readonly blanksTypedOnly?: true | undefined;
  /**
   * Typed with its blanks left empty where a screen can be shown, this action
   * of the same command runs instead, a screen that chooses them (`/model use`
   * alone opens the model picker).
   */
  readonly blankOpens?: string | undefined;
}

export interface CommandDescription<Ctx> {
  /** The command's only name: no aliases. */
  readonly name: string;
  readonly title: string;
  /** One plain sentence. */
  readonly summary: string;
  readonly group: string;
  /** The action id a bare command runs where no list can be shown (a model, a script); first row of the list. */
  readonly report?: string | undefined;
  /**
   * The action a bare command runs where a screen can be shown, in place of
   * the action list: a command whose screen is the point (`/work` opens the
   * work view). Every action stays reachable typed and from that screen.
   */
  readonly bareOpens?: string | undefined;
  /**
   * Opens place: the id of the place (places/index.ts `PLACES`) a bare command opens where a screen can be shown,
   * in place of the action list. A typed command that stays only to open its place (`/checkpoint` opens This
   * conversation) declares it here, with no action for it: the place is how its actions are reached. A model or a
   * script typing it bare still gets the `report` action.
   */
  readonly opens?: string | undefined;
  /**
   * The last blank of an action is text a person wrote (a message, a note):
   * `--yes` confirms only right after the action word, and the same word inside
   * the text is text. Words after `--` are text for every command.
   */
  readonly leadingFlagsOnly?: boolean | undefined;
  /** False: listed only once something is typed. Every action stays reachable from the guided path. */
  readonly firstScreen?: boolean | undefined;
  /**
   * The rows of the bare command's list: an action id, or a group row that
   * opens a short list of its actions ("Choose what a server may do…"). Every
   * action is on it or inside one of its groups. Absent: every action is a row.
   */
  readonly firstScreenRows?: readonly (string | FirstScreenGroup)[] | undefined;
  /**
   * A one-key choice on the bare command's list, for the selected row: what
   * the key is called there (undefined: that row has none), and what pressing
   * it does. `/setup`'s "s skip for now" on a checklist topic is one.
   */
  readonly rowKey?: {
    readonly key: string;
    readonly label: (actionId: string, ctx: Ctx) => string | undefined;
    readonly press: (actionId: string, ctx: Ctx) => void;
  } | undefined;
  readonly actions: readonly ActionDescription<Ctx>[];
}

export interface FirstScreenGroup { readonly label: string; readonly actions: readonly string[] }

/** What a report action shows: a verdict, a headline and the things that need attention, each with how to fix it. */
export interface CommandReport {
  readonly verdict: 'ok' | 'attention';
  readonly headline: string;
  readonly items: readonly { readonly sentence: string; readonly fix?: { readonly label: string; readonly line: string } | undefined }[];
}

/** An action as data: what the typed line, the sentence and the button are read from (the web UI holds this much). */
export type ActionShape = Pick<ActionDescription<never>, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'done' | 'lasts' | 'risk' | 'button'>;
/** A command as data. */
export interface CommandShape { readonly name: string; readonly actions: readonly ActionShape[] }

/** What the generated handler and the guided path read from a surface's command context. */
export interface CommandActionContext extends ConfirmationHost {
  readonly print: (message: string) => void;
  /**
   * Print a line that later calls replace in place (a progress line), and return what replaces
   * it; null when the output cannot update a line in place (the line was printed as it is).
   * Absent where no transcript can.
   */
  readonly printLive?: ((message: string) => ((next: string) => void) | null) | undefined;
  readonly invokedByModel?: boolean | undefined;
  readonly openSelection?: OpenSelection | undefined;
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
  readonly beginPlainInput?: ((request: PlainLineInputRequest) => void) | undefined;
  readonly renderRequest?: (() => void) | undefined;
  /** Push a kit modal on the surface's modal stack (the guided panel draws there). */
  readonly pushSurfaceModal?: ((modal: SurfaceModal) => void) | undefined;
  /** Open a place of this program by id (a command's `opens`); absent where the surface has no places. */
  readonly openPlace?: ((placeId: string) => void) | undefined;
}
