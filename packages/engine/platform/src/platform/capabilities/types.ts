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
 * result. A line the owner typed in full, or a form they submitted, is the
 * request and runs at once whatever its risk, its result saying what the risk
 * did; a line a model runs is put to the owner first when its risk is not `none`.
 */
export type ActionRisk = 'none' | 'loosens-a-protection' | 'cannot-be-undone' | 'spends-money' | 'sends-out' | 'runs-later';
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
  /**
   * What the act did when this choice raised its risk, said after it ran in place of the risk's own words whenever
   * those would not be true of every run ("Write over it": there may have been nothing to write over). Whole sentences.
   */
  readonly riskDone?: string | undefined;
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
  /**
   * For a `path` input, whether the capability reads the file it names or writes it there. Only a written one is a file
   * the capability puts on disk, so only it can be one that runs by itself later and is asked of the owner as a model's
   * write of it is (tools/capability/definitions.ts `writesFiles`). Absent: read.
   */
  readonly file?: 'read' | 'written' | undefined;
  /**
   * For a `path` input that names a folder: whether a turn or a process will work in it (a hosted agent's folder, the
   * folders a tool server may use): true, and the daemon's dispatch checks it as a project the caller may name
   * (workspace/caller-project.ts), as a method's `workFolders`; false for a folder only read or written (an export's
   * folder, a folder published). A daemon capability's path input that names a folder states it, or the catalog does
   * not load (capabilities/work-folders.ts).
   */
  readonly workFolder?: boolean | undefined;
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
  /**
   * When it is shown and needed, declared as data every form reads the same way (the terminal places, the web form,
   * `capabilities.list`, the daemon's own check): see {@link InputShowWhen}.
   */
  readonly showWhen?: InputShowWhen | undefined;
  /** A value to offer from what is filled in so far, marked "suggested from ..." until the person changes it. */
  readonly suggest?: ((earlier: ActionValues) => { readonly value: string; readonly from: string } | undefined) | undefined;
  /**
   * A secret input whose value is not secret for what is filled in so far (a setting that holds no password or key):
   * the form shows it as typed. It stays a secret everywhere else (never printed, kept or sent in clear).
   */
  readonly plainWhen?: ((earlier: ActionValues) => boolean) | undefined;
}

/**
 * When an input is shown and needed, as data (never a function, so it travels in `capabilities.list` and the
 * generated command actions, and a form reads it without the platform's code):
 *
 *  - `{ input, is }`: while that input holds this value ("Command" when it starts as a command).
 *  - `{ input, isOneOf }`: while that input holds one of these values.
 *  - `{ input, isNoneOf }`: once that input holds a value, and it is none of these (a program asked only for a setting
 *    a program holds: none of the daemon's own settings); with `startsWithNoneOf`, nor does it start with one of
 *    those and go on past it (a family of names declared by its start).
 *  - `{ suppliedBy }`: never shown or asked: the program or the place asking fills it from what it knows (the row
 *    pressed on, the program's own view links); the words say from what. A caller with nothing to fill leaves it out.
 */
export type InputShowWhen =
  | { readonly input: string; readonly is: string }
  | { readonly input: string; readonly isOneOf: readonly string[] }
  | { readonly input: string; readonly isNoneOf: readonly string[]; readonly startsWithNoneOf?: readonly string[] | undefined }
  | { readonly suppliedBy: string };

/** Whether an input with this `showWhen` is shown and needed, given the values filled in so far. */
export function showWhenHolds(when: InputShowWhen | undefined, values: ActionValues): boolean {
  if (!when) return true;
  if ('suppliedBy' in when) return false;
  const value = values[when.input];
  if ('is' in when) return value === when.is;
  if ('isOneOf' in when) return value !== undefined && when.isOneOf.includes(value);
  return value !== undefined && value !== '' && !valueNamed(value, when.isNoneOf, when.startsWithNoneOf);
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
  // A schedule, a trigger, a watcher: decided as any other change (a judgment under the mode, as a model's schedule or
  // trigger was in 3.5.0), never as a loosened protection.
  'runs-later': 'sets something to run by itself later',
};

/** The risk words said with the result of an action that ran: "This loosened a protection." */
export const RISK_DONE_WORDS: Readonly<Record<Exclude<ActionRisk, 'none'>, string>> = {
  'loosens-a-protection': 'loosened a protection',
  'cannot-be-undone': 'cannot be undone',
  'spends-money': 'spent money',
  'sends-out': 'sent something outside this machine',
  'runs-later': 'set something to run by itself later',
};

/**
 * What "Write over it" or "Replace it" did, said after it ran (a choice's `riskDone`): true whether or not anything
 * was there to write over, where "This cannot be undone." would not be when nothing was.
 */
export const REPLACED_DONE = 'Whatever was there before, if anything, is gone and cannot be brought back.';

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
  /**
   * `code` names what refused it (NOT_FOUND, INVALID_ARGUMENT, UNAVAILABLE, a method's own code); `capabilities.run`
   * answers with the status that code stands for (routes/capabilities.ts `refusalStatus`), or `status` when given.
   */
  constructor(message: string, readonly next?: string | undefined, readonly code: string = 'CAPABILITY_REFUSED', readonly status?: number | undefined) {
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
  /**
   * The value the person must see once (a capability that declares `reveals`): a new device's one-time token, the
   * group's join key. Never in `text` or `data`: `capabilities.run` returns it only to the person who asked, a place
   * shows it in its own pane until the person leaves it, and nothing writes it to a log, a transcript, a frame or an outcome line.
   */
  readonly reveal?: { readonly value: string; readonly qr?: string | undefined } | undefined;
  /**
   * What this run did, about what the risk names, when it is not what every run does (a check-in that stayed quiet
   * sent nothing): said in place of the definition's line (outcome.ts `riskDoneLine`); '' says nothing.
   */
  readonly riskDone?: string | undefined;
}

/** What a capability's revealed value is, as its pane names it (CapabilityDefinition `reveals`). */
export interface CapabilityReveal {
  /** What the value is: "One-time token", "Join key". */
  readonly label: string;
  /** One sentence under it: what it does and whether it can be seen again. */
  readonly note: string;
}

/**
 * Who wrote a record that steers the owner's turns (state/memory-store.ts MemoryAuthor has the same shape): `owner`
 * (their own press or typed words), `owner-model` (their model in their own turn) or `other` (a device, a member, an outside
 * agent, a script or command line with no person, a turn on someone else's input), with who in words.
 */
export interface RecordAuthor {
  readonly kind: 'owner' | 'owner-model' | 'other';
  readonly who?: string | undefined;
}

/** The author of a write whose caller nobody named: someone else's, never the owner's. */
export const UNNAMED_AUTHOR: RecordAuthor = { kind: 'other', who: 'a caller the daemon did not name' };

/** Words for who wrote a record, for its provenance line: nothing for the owner's own. */
export function authorWords(author: RecordAuthor | undefined): string {
  const by = author ?? UNNAMED_AUTHOR;
  if (by.kind === 'owner') return '';
  if (by.kind === 'owner-model') return 'written by your model in your own conversation';
  return `written by someone else (${by.who ?? 'not named'})`;
}

/** Facts about who asked, read by a handler that acts on the caller's project or program. */
export interface CapabilityCaller {
  /** The caller's working directory: the project a hook file or a project secret store belongs to. */
  readonly workingDirectory?: string | undefined;
  /** The terminal program that asked (`tui` is the terminal app, `agent` the Agent), when one did. */
  readonly program?: 'tui' | 'agent' | undefined;
  /**
   * The model the asking program's conversation uses (`provider:model`), when a terminal program asked: a capability
   * on "the model of this conversation" (its context window size) acts on it unless the call names another.
   */
  readonly model?: string | undefined;
  /** The asking program's conversation, when a terminal program asked: what a capability records as where a thing came from. */
  readonly sessionId?: string | undefined;
  /** The person asked it themselves (a key pressed, a form submitted, a line typed): not a model, not another agent. */
  readonly personAsked?: boolean | undefined;
  /**
   * The owner in person chose "Every project" in their place's project chooser (no project named): a read of per-project
   * things (memory) covers every project. Set by the daemon's `capabilities.run` only for the owner in person; absent,
   * a call naming no project reads only what belongs to no project.
   */
  readonly everyProject?: boolean | undefined;
  /**
   * Whether the person asking may name any file on this disk: only from the owner's own program (its credential: this
   * machine's, the operator token, the Agent's). From a paired device or a member, a person's path is still a file
   * inside a project given to that caller, or its own file carried from its machine (path-inputs.ts). Set by the
   * daemon's `capabilities.run`; absent elsewhere (the program holding the conversation is the owner's own).
   */
  readonly namesAnyFile?: boolean | undefined;
  /**
   * The owner made the call in person or from their own command line (their sign-in, their registered program, their typed
   * `do`: daemon/method-owner-decision.ts `makesOwnerOnlyAct`, the one test), never their model or a daemon turn: an act
   * only the owner makes (a record moved out of the project it belongs to). Set by the daemon's `capabilities.run`.
   */
  readonly ownerHimself?: boolean | undefined;
  /**
   * The call came from another machine (the listener saw it arrive over the network, not over loopback): a path it
   * names is on that machine, and the daemon reads by path only what is on its own machine and was named by a caller
   * there. Set by the daemon's `capabilities.run`; absent for a caller on this machine or in process.
   */
  readonly elsewhere?: boolean | undefined;
  /**
   * The daemon's own scratch folders holding the files and folders the program asking sent for this call's path inputs
   * (capabilities/carried-files.ts): a path inside one is that content, on this machine, whoever the caller is; what the
   * run leaves there goes back to the program, which writes it on its own machine.
   */
  readonly carried?: readonly string[] | undefined;
  /**
   * Who caused this run, for an act that makes work run (builtin/work.ts keeps it on the work's record): the owner
   * in person (their own press or typed line, their answer in Waiting for you, a model of their own conversation) or someone
   * else. Set by the daemon's `capabilities.run`; absent anywhere else, which is read as someone else's.
   */
  readonly cause?: import('../workflow/work-ledger/work-plans.js').WorkCause | undefined;
  /**
   * Who writes what this run keeps that later steers the owner's turns (a memory record, a persona, a note, a routine,
   * a skill), from the credential the daemon authenticated, never a field the caller sends: the owner in person (their own
   * press or typed words, their yes in Waiting for you), their model in their own turn, or someone else. Set by the daemon's
   * `capabilities.run`; absent anywhere else, which is read as someone else's.
   */
  readonly author?: RecordAuthor | undefined;
  /**
   * Who made this run's act and how it was decided (the owner's press, their yes to a call put to them, or admitted under their rules
   * for the caller named), for a shared setting it sends to a machine group, which keeps the record on every member.
   * Set by the daemon's `capabilities.run`; absent elsewhere.
   */
  readonly settingAct?: import('@goodvibes/engine/daemon-api/control-routes').SettingAct | undefined;
  /**
   * Whether this caller registered a session (session-broker-sessions.ts `registrantMayName`): a session a caller names
   * is recorded as where a thing came from only when it is its own. Absent: no session it names is recorded.
   */
  readonly registeredSession?: ((sessionId: string) => boolean) | undefined;
  /**
   * Run a daemon method as this same caller (its own admission applies; the person's claim travels with it only as
   * the daemon kept it): a handler whose act a daemon method already does calls that method and words its answer.
   * Set by the daemon's `capabilities.run`; absent where no daemon dispatch runs the handler.
   */
  readonly method?: ((methodId: string, body: Record<string, unknown>) => Promise<unknown>) | undefined;
}

/** The sentence a capability says when one input holds one of `values` (CapabilityDefinition `sentenceWhen`). */
export interface CapabilitySentenceWhen {
  readonly input: string;
  readonly values: readonly string[];
  /** Also when the input's value starts with one of these and goes on past it (a family of names: `SLACK_TOKEN_<name>`). */
  readonly startsWith?: readonly string[] | undefined;
  readonly sentence: string;
}

/** Whether a value is one of `values`, or starts with one of `prefixes` and goes on past it. */
function valueNamed(value: string, values: readonly string[], prefixes: readonly string[] | undefined): boolean {
  return values.includes(value) || (prefixes ?? []).some((prefix) => value.length > prefix.length && value.startsWith(prefix));
}

/** Whether a capability's `sentenceWhen` applies to these values (its sentence is said instead of the general one). */
export function sentenceWhenHolds(when: CapabilitySentenceWhen | undefined, values: ActionValues): boolean {
  return when !== undefined && valueNamed(values[when.input] ?? '', when.values, when.startsWith);
}

/** The chosen values of one input with which a capability only tightens a protection (CapabilityDefinition `tightens`). */
export interface CapabilityTightensWhen {
  readonly input: string;
  readonly values: readonly string[];
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
  /**
   * What happened, said only by a place (the press's outcome line), for a control whose typed line prints nothing on
   * purpose (`/clear` keeps the empty conversation's splash): "Started a fresh conversation." Absent: `done`.
   */
  readonly doneInPlace?: string | undefined;
  readonly touches: ActionTouches;
  readonly lasts: ActionLasts | 'not-a-change';
  readonly risk: ActionRisk;
  /**
   * What the act did, said after it ran in place of the risk's own words ("This spent money.") whenever those would
   * not be true of what ran (outcome.ts): the risk names what may follow, so approving a purchase ahead says "Nothing
   * has been bought yet: ...". Whole sentences, with `{input}` blanks. Absent: the risk's words.
   */
  readonly riskDone?: string | undefined;
  readonly ownerOnly?: { readonly reason: string; readonly instead: string } | undefined;
  /**
   * Only the owner in person does it, whoever else holds the access: any other caller's call (a paired device, a member,
   * an admin's sign-in, a person's press on a credential that is not the owner's) is put to the owner as their own act, opening
   * on No, and runs on their yes (routes/capabilities.ts). Set with `ownerOnly`, which puts a model's call to the owner.
   */
  readonly ownersAct?: true | undefined;
  /**
   * The act is the owner's own for these values only (a change to one of the owner's shared memory records, which belong to no
   * project): any caller but the owner in person and their own turns is put to the owner as their own act, as `ownersAct` puts every
   * call (routes/capabilities.ts). Read before anything is asked; true means put to the owner.
   */
  readonly ownersActWhen?: ((values: ActionValues, services: Services) => boolean) | undefined;
  /**
   * It writes what steers a model in the owner's turns (a memory record, a persona or the one in use, a note, a routine,
   * a skill): who wrote it is kept from the credential the daemon authenticated, and a command line's `do` of it is held
   * for the owner like the other risky classes (capabilities/command-line-hold.ts).
   */
  readonly steersModel?: true | undefined;
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
  /**
   * The action asks its own question, with what it read at that moment, before it does what its risk names (a
   * restore shown on a preview): a screen that runs it asks nothing first, so the person is asked once.
   */
  readonly asksItself?: true | undefined;
  /**
   * Its outcome carries a value the person must see once (the result's `reveal`): a place shows it whole in its own
   * pane, with the copy key, until the person leaves it; `capabilities.run` returns it only to the person who asked.
   */
  readonly reveals?: CapabilityReveal | undefined;
  /**
   * What its result carries that is secret, in words for the owner's card ("your sign-in tokens", "the group's join
   * key"): a file it writes with working tokens, a value it reveals. When the result would go to a caller that is not
   * the owner's own program (a paired device or a member: carried back to its machine, revealed to its person, written
   * where it reads), the run is the owner's own act, put to them opening on No, the card saying "This sends <it> to
   * <that caller>." (routes/capabilities.ts). Every capability whose result is secret declares it.
   */
  readonly resultSecret?: string | undefined;
  /**
   * It only tightens a protection (plan mode on, a folder restricted, a "never" rule added, a protection switched on):
   * a model's call of it is never refused or asked about, in any mode and any folder (tools/capability/definitions.ts
   * classes it so). `true` for every run; `{ input, values }` when only those chosen values tighten (a rule that
   * refuses or asks, not one that allows).
   */
  readonly tightens?: true | CapabilityTightensWhen | undefined;
  /**
   * It writes only the model's own working state (the running checklist), not the person's things: a model's call of
   * it is never held or asked about, in any mode, with or without a decision model (tools/capability/definitions.ts
   * classes it so, as the `work_plan` tool is).
   */
  readonly ownWorkingState?: true | undefined;
  /**
   * Whether a run with these values loosens a protection although its own risk is `none` (a setting changed in the
   * direction that loosens it: settings.set, settings.reset): such a run asks first, opening on No (risk.ts
   * `effectiveRisk`); a change the other way applies at once. A model's call is classed by the gate from the setting's
   * current value (permissions/manager.ts `settingsWriteLoosens`).
   */
  readonly loosensIf?: ((values: ActionValues) => boolean) | undefined;
  /**
   * The chosen values of one input with which a run cannot be undone although the action's own risk is `none` (a
   * reset of a setting that holds a credential removes the stored secret): such a run is `cannot-be-undone` (risk.ts
   * `effectiveRisk`), and a model's or an outside caller's is put to the owner, opening on No (the gate reads the same
   * list: tools/capability/definitions.ts `irreversibleWhen`).
   */
  readonly irreversibleWhen?: CapabilityTightensWhen | undefined;
  /**
   * The chosen values of one input with which a run writes a secret although the action itself does not always (a
   * setting that holds a credential: its new value goes to the secret store): such a run has the `secret.write` effect
   * (catalog.ts `capabilityEffects`), the writes-a-secret class of the one owner decision, so anyone but the owner
   * in person is put to the owner, once, before it runs.
   */
  readonly secretWhen?: CapabilityTightensWhen | undefined;
  /**
   * The sentence said in place of `sentence` when one input holds one of these values (a reset of a setting that holds
   * a credential removes the stored secret; any other goes back to its default): the card a model's call is put to the
   * owner with says what will really happen. `{input}` blanks as in `sentence`.
   */
  readonly sentenceWhen?: CapabilitySentenceWhen | undefined;
  /**
   * The question a place asks before a run that cannot be undone or loosens a protection, with `{input}` blanks
   * ("Set {key} to {value}?"); absent, the label with a question mark. It names the change, where the form's title
   * names the act.
   */
  readonly question?: string | undefined;
  readonly example: ActionValues;
  /**
   * Whether the program holding the conversation can run it with the services it has (a session capability whose
   * program lacks the piece it needs: the Agent keeps no code index). Absent: always. A place shows no control for
   * one that is not available, and the model's run refuses it in words.
   */
  readonly available?: ((services: Services) => boolean) | undefined;
  /**
   * What its caller must send for it to run at all, each with the sentence that says what to name: `project`, the
   * project folder it acts in (`workingDirectory`); `program`, the terminal program asking. `capabilities.run` refuses a
   * call without it at once, before the owner is asked anything about a call that would then be refused.
   */
  readonly callerNeeds?: { readonly project?: string | undefined; readonly program?: string | undefined } | undefined;
  /**
   * Whether a run with these values changed only what the caller's project shows (a memory kept for "this project"):
   * the change notice then names that project, so a screen open in another project does not read again. Absent: only a
   * capability that needs a project (`callerNeeds.project`) names it.
   */
  readonly changesCallerProject?: ((values: ActionValues) => boolean) | undefined;
  /**
   * Its preview check: what refuses a call for a reason its values and its caller alone show (a file outside the
   * project named by a caller who is not the person). Run before anything is asked, at every door: `capabilities.run`
   * refuses before the owner is put the question, the model's `capability_run` before its program's gate decides it.
   * The handler keeps its own check. Returns the refusal, or undefined when the call may go on.
   */
  readonly check?: ((values: ActionValues, caller: CapabilityCaller) => CapabilityRefusal | undefined) | undefined;
  /**
   * For a capability that applies a file: the file read once, in the daemon, before anything is asked. It answers the
   * refusal the file's content already earns (a setting in it locked as managed), or the values with that content in
   * them (`filesAt: program`, `content`), so the owner is asked about exactly what then runs and the run never reads the
   * file again. Not run again for the call's run on the owner's yes (it runs on the values kept with the question).
   */
  readonly readsFileBefore?: ((values: ActionValues, services: Services, caller: CapabilityCaller) => ActionValues | CapabilityRefusal | undefined) | undefined;
  /**
   * A refusal the daemon can read only by asking (a piece of work this caller did not cause: builtin/work.ts), read in
   * `capabilities.run` before anything is decided or asked, with `caller.method` set: a call refused whatever the answer is
   * refused before any question. Returns the refusal, or undefined when the call may go on.
   */
  readonly refusedBefore?: ((values: ActionValues, services: Services, caller: CapabilityCaller) => Promise<CapabilityRefusal | undefined>) | undefined;
  /**
   * Why no place has a control for it, when that is meant: it exists for a model or a program (a model proposing work
   * with its plan, a program counting a routine it started), and a person reaches what it does by another control,
   * named here. Every other capability has a control in a place; this sentence is the record that its absence is meant.
   */
  readonly noControl?: string | undefined;
  readonly run:(values: ActionValues, services: Services, caller: CapabilityCaller) => Promise<CapabilityResult>;
}
