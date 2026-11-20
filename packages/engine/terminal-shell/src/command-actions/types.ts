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

/** What running an action reaches. Replaces `effect`, `readVerbs` and the Agent's verb table. */
export type ActionTouches = 'reads' | 'this-machine' | 'another-machine' | 'credential';
/** The one risk word an action carries, shown in lists and in the sentence; anything but `none` asks first. */
export type ActionRisk = 'none' | 'loosens-a-protection' | 'cannot-be-undone' | 'spends-money' | 'sends-out';
/** How long a change lasts; `byInput` names the input whose chosen value decides it. */
export type ActionLasts = 'session' | 'kept' | { readonly byInput: string };
export type InputKind = 'choice' | 'text' | 'long-text' | 'secret' | 'number' | 'money' | 'date-time' | 'path' | 'yes-no' | 'list';
/** The name of a live list registered with `defineList` (lists.ts). */
export type ListName = string & { readonly __list: unique symbol };

export interface FixedChoice {
  readonly value: string;
  readonly label: string;
  readonly help?: string | undefined;
  /** A choice that raises the action's risk (a looser trust mode). */
  readonly risk?: ActionRisk | undefined;
  /** For an input that decides how long the action lasts: what this value means. */
  readonly lasts?: 'session' | 'kept' | undefined;
}

export interface ListChoices {
  readonly list: ListName;
  /** The earlier input whose value the list is read for (a server's tools). */
  readonly dependsOn?: string | undefined;
  /** A value outside the list is accepted, for the reason given (shown as the placeholder). */
  readonly allowOther?: { readonly reason: string } | undefined;
}

export interface InputDescription {
  readonly id: string;
  /** A noun a person would say out loud: "Server". */
  readonly label: string;
  /** One line under the label. */
  readonly help: string;
  readonly kind: InputKind;
  readonly choices?: ListChoices | readonly FixedChoice[] | undefined;
  /** Required when the input is typed text with no list: why it has to be typed. */
  readonly freeTextReason?: string | undefined;
  readonly required: true | { readonly default: string; readonly defaultMeans: string };
  /**
   * Where it sits on the typed line: a bare word (first or second after the
   * action word), a named option (`--scope global`, or a bare switch such as
   * `--keep`), or the free-text tail.
   */
  readonly typed:
    | { readonly position: 1 | 2 }
    /** Not typed: read from whether another input was given (a web address given means "start it at an address"). */
    /** `orIfGiven`: further inputs, each meaning its own value when given (the first given wins; `input` is tried first). */
    | { readonly impliedBy: { readonly input: string; readonly ifGiven: string; readonly ifNot: string; readonly orIfGiven?: readonly { readonly input: string; readonly value: string }[] | undefined } }
    /** `switchOn`: the option is a bare switch (`--keep`) whose presence means that value. `repeats`: given once per value. */
    | { readonly flag: `--${string}`; readonly repeats?: true | undefined; readonly switchOn?: string | undefined }
    | { readonly tail: true };
  /** The form step it is asked in (1, 2, ...); inputs of one step are shown together as one page. */
  readonly step?: number | undefined;
  /** Shown and needed only while another input holds a value ("Command" when it starts as a command). */
  readonly showWhen?: { readonly input: string; readonly is: string } | undefined;
  /** A value to offer from what is filled in so far, marked "suggested from ..." until the person changes it. */
  readonly suggest?: ((earlier: ActionValues) => { readonly value: string; readonly from: string } | undefined) | undefined;
}

/** The values an action runs with, by input id. A repeating option's values are joined with a newline. */
export type ActionValues = Readonly<Record<string, string>>;

export interface ActionDescription<Ctx> {
  readonly id: string;
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
  /** Only counts when the owner types it; a model is refused with the reason and what it may do instead. */
  readonly ownerOnly?: { readonly reason: string; readonly instead: string } | undefined;
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
   * nothing to run. The Agent workspace runs such a report when one of the
   * command's rows is selected; any other report waits for Ctrl+R.
   */
  readonly readsOnlyThisMachine?: true | undefined;
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
  readonly invokedByModel?: boolean | undefined;
  readonly openSelection?: OpenSelection | undefined;
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
  readonly beginPlainInput?: ((request: PlainLineInputRequest) => void) | undefined;
  readonly renderRequest?: (() => void) | undefined;
  /** Push a kit modal on the surface's modal stack (the guided panel draws there). */
  readonly pushSurfaceModal?: ((modal: SurfaceModal) => void) | undefined;
}

/** The sentence ending for each lifetime, the same everywhere. */
export const LASTS_WORDS: Readonly<Record<'session' | 'kept', string>> = {
  session: 'for this session only',
  kept: 'until you change it',
};

/** The risk word shown beside an action and in its question. */
export const RISK_WORDS: Readonly<Record<Exclude<ActionRisk, 'none'>, string>> = {
  'loosens-a-protection': 'loosens a protection',
  'cannot-be-undone': 'cannot be undone',
  'spends-money': 'spends money',
  'sends-out': 'sends something outside this machine',
};
