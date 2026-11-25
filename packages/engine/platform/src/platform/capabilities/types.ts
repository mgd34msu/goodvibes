/**
 * A capability is one thing a person, a model or a script can have GoodVibes
 * do: a name, the inputs it needs, what it says before and after, its risk,
 * which of the fourteen function groups it belongs to, where it runs, and what
 * sending it twice does. It is defined once. A slash command's action is this
 * definition (terminal-shell's command-actions/types.ts re-exports the input
 * shapes below), and the definition of an action that has moved stands here,
 * in the platform, beside its handler.
 *
 * Where it runs (`home`):
 *  - `daemon`: it acts on something a person sets up, connects, stores or
 *    configures. It runs in the daemon and nowhere else (capabilities.run).
 *  - `session`: it acts on the live conversation, the terminal's own screen or
 *    hardware, or the project files a turn changed. It runs in the program
 *    holding the conversation.
 */
import type { CapabilityGroupId } from './groups.js';
import type { EffectId } from '../security/effect-authority.js';

/** What running an action reaches. */
export type ActionTouches = 'reads' | 'this-machine' | 'another-machine' | 'credential';
/**
 * The one risk word an action carries, shown in lists, in help and with the
 * result. A line the owner typed in full, or a form he submitted, is the
 * request and runs at once whatever its risk, its result saying what the risk
 * did; a line a model runs is put to the owner first when its risk is not `none`.
 */
export type ActionRisk = 'none' | 'loosens-a-protection' | 'cannot-be-undone' | 'spends-money' | 'sends-out';
/** How long a change lasts; `byInput` names the input whose chosen value decides it. */
export type ActionLasts = 'session' | 'kept' | { readonly byInput: string };
export type InputKind = 'choice' | 'text' | 'long-text' | 'secret' | 'number' | 'money' | 'date-time' | 'path' | 'yes-no' | 'list';
/** The name of a live list registered with `defineList` (terminal-shell command-actions/lists.ts). */
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

/** The values an action runs with, by input id. A repeating option's values are joined with a newline. */
export type ActionValues = Readonly<Record<string, string>>;

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
    /** `untilNextFlag`: the value is every word up to the next `--option` (or `--`) or the end, so `--title Tomato blight notes` needs no quotes. */
    | { readonly flag: `--${string}`; readonly repeats?: true | undefined; readonly switchOn?: string | undefined; readonly untilNextFlag?: true | undefined }
    | { readonly tail: true };
  /** The form step it is asked in (1, 2, ...); inputs of one step are shown together as one page. */
  readonly step?: number | undefined;
  /** Shown and needed only while another input holds a value ("Command" when it starts as a command). */
  readonly showWhen?: { readonly input: string; readonly is: string } | undefined;
  /** A value to offer from what is filled in so far, marked "suggested from ..." until the person changes it. */
  readonly suggest?: ((earlier: ActionValues) => { readonly value: string; readonly from: string } | undefined) | undefined;
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

/** The risk words said with the result of an action that ran: "This loosened a protection." */
export const RISK_DONE_WORDS: Readonly<Record<Exclude<ActionRisk, 'none'>, string>> = {
  'loosens-a-protection': 'loosened a protection',
  'cannot-be-undone': 'cannot be undone',
  'spends-money': 'spent money',
  'sends-out': 'sent something outside this machine',
};

/** Where a capability runs; see the file header. */
export type CapabilityHome = 'daemon' | 'session';

/**
 * What sending the same request twice does (the daemon's `repeat` rule):
 * `safe`, the repeat changes nothing more (it sets what is set, or reads);
 * `unsafe`, it acts again (a second record, a second run).
 */
export type CapabilityRepeat = 'safe' | 'unsafe';

/**
 * What an action adds to its description to stand on its own as a
 * capability: its id (`<command>.<action word>` from today's words; a command
 * of one action with no word is `<group>.<command>`), its function group, its
 * home and its repeat. An action that carries it is reached by find and run.
 */
export interface CapabilityDeclaration {
  readonly id: string;
  readonly group: CapabilityGroupId;
  readonly home: CapabilityHome;
  readonly repeat: CapabilityRepeat;
}

/** A refusal a capability throws when it did not do what was asked: what is true, and what to do instead. */
export class CapabilityRefusal extends Error {
  constructor(message: string, readonly next?: string | undefined, readonly code: string = 'CAPABILITY_REFUSED') {
    super(message);
    this.name = 'CapabilityRefusal';
  }
}

/**
 * What a capability answers: the words a person or a model reads, and the
 * facts a screen or a script reads (never a secret value).
 */
export interface CapabilityResult {
  readonly text: string;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

/** Facts about who asked, read by a handler that acts on the caller's project or program. */
export interface CapabilityCaller {
  /** The caller's working directory: the project a hook file or a project secret store belongs to. */
  readonly workingDirectory?: string | undefined;
  /** The terminal program that asked (`tui` is the terminal app, `agent` the Agent), when one did. */
  readonly program?: 'tui' | 'agent' | undefined;
}

/**
 * One capability, defined once with its handler. `Services` is the narrow
 * context its handler needs: named stores and clients, never a screen and
 * never a program's whole command context.
 */
export interface CapabilityDefinition<Services> {
  readonly capability: CapabilityDeclaration;
  /** The action's id inside its command (what its command's first screen and `undoneBy` name). */
  readonly actionId: string;
  /** Named for what you get: "Switch a hook on". */
  readonly label: string;
  /** The typed word after the command (`enable`); `''` for a command of one action. */
  readonly word: string;
  readonly inputs: readonly InputDescription[];
  /** What is about to happen, with `{input}` blanks and `{lasts}`. */
  readonly sentence: string;
  /** What happened, with `{input}` blanks; `''` when the result's own text says it. */
  readonly done: string;
  readonly touches: ActionTouches;
  readonly lasts: ActionLasts | 'not-a-change';
  readonly risk: ActionRisk;
  readonly riskDone?: string | undefined;
  readonly ownerOnly?: { readonly reason: string; readonly instead: string } | undefined;
  /**
   * What a run causes, as rows of the effect table (security/effect-authority.ts), admitted for the caller and
   * read by the model's gate (a row a model never causes makes it the owner's own act). Absent: derived from
   * the risk (`capabilityEffects`, catalog.ts). State them outright where the derived ones are wrong.
   */
  readonly effects?: readonly EffectId[] | undefined;
  /** The action id (in the same command) that undoes this one. */
  readonly undoneBy?: string | undefined;
  /** The confirming button's words when the label's verb cannot be read from it ("Put them back"). */
  readonly button?: string | undefined;
  readonly example: ActionValues;
  readonly run:(values: ActionValues, services: Services, caller: CapabilityCaller) => Promise<CapabilityResult>;
}
