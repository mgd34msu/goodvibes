/**
 * setup-command.ts, the setup topics of both terminal programs: each topic is
 * the session capability `setup.<topic>` (capabilities/builtin/system-program.ts),
 * which opens one form for that topic (the terminal app's former wizard pages,
 * the Agent's former Start rows) applying only its own fields; the six topics that only open a place
 * (`SETUP_PLACE_TOPICS`) are rows of the list that open it, with no capability. There is no slash
 * command: every topic is a row of the System place's Setup tab (and the topics of
 * another group also a key in that group's place), found and run by id too.
 *
 * The topic list, its words and its order are here, once. A program passes the
 * topics it can open (its own form for each); a topic a program does not pass is
 * not listed there and, run by id, says where it is set up.
 */
import type { ActionValues, CommandActionContext } from './command-actions/types.js';
import { SETUP_TOPIC_WORDS, readSetupState, type SystemSessionServices } from '@goodvibes/engine/platform/platform/capabilities';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { gatePresetLabel } from '@goodvibes/engine/platform/platform/gate/presets';

export type SetupTopicId =
  | 'model'
  | 'sign-in'
  | 'add-provider'
  | 'store-key'
  | 'local-only'
  | 'browser'
  | 'other-devices'
  | 'connect-daemon'
  | 'webhooks'
  | 'chat-apps'
  | 'cloudflare'
  | 'who-signs-in'
  | 'how-it-works'
  | 'safety'
  | 'memory'
  | 'telemetry'
  | 'automation'
  | 'devices-voice'
  | 'provider-behaviour'
  | 'advanced'
  | 'history'
  | 'import-settings'
  | 'first-run';

interface SetupTopicWords {
  readonly label: string;
  readonly word: string;
  /** One sentence: what opening the topic does, in either program. */
  readonly sentence: string;
  /** What the terminal app opens, when it is not the sentence. */
  readonly tui?: string;
  /** What the Agent opens, when it is not the sentence. */
  readonly agent?: string;
}

/** Every topic's words, in list order: the capabilities' own (capabilities/builtin/system-program.ts `setup.<topic>`). */
const { model: MODEL_TOPIC, 'sign-in': SIGN_IN_TOPIC, ...FORM_TOPICS_REST } = SETUP_TOPIC_WORDS;

/**
 * The topics that only open a place: a row of the Setup list that opens `place` on `list`, and nothing else (no
 * capability of its own, as a typed command that opens a place carries `opens`). Both programs open the same control:
 * Devices and network's Addresses and ports (`a` there makes the account that signs in from a browser or another
 * device), and Permissions and safety at the sandbox switch.
 */
export type SetupPlaceTopicId = 'local-only' | 'browser' | 'other-devices' | 'webhooks' | 'who-signs-in' | 'safety';
export interface SetupPlaceTopicWords extends SetupTopicWords {
  readonly opens: { readonly place: string; readonly list: string };
}
export const SETUP_PLACE_TOPICS: Readonly<Record<SetupPlaceTopicId, SetupPlaceTopicWords>> = {
  'local-only': { label: 'Only this computer', word: 'local-only', opens: { place: 'devices', list: 'addresses' }, sentence: 'Opens Addresses and ports in Devices and network, where the daemon, web UI and webhook listeners are turned off so everything stays on this computer.' },
  'browser': { label: 'Use it in a browser', word: 'browser', opens: { place: 'devices', list: 'addresses' }, sentence: 'Opens Addresses and ports in Devices and network: the web UI switch, where it listens, and the account that signs in from a browser.' },
  'other-devices': { label: 'Other devices', word: 'other-devices', opens: { place: 'devices', list: 'addresses' }, sentence: 'Opens Addresses and ports in Devices and network: the addresses and ports your other devices reach, and the account that signs in from them.' },
  'webhooks': { label: 'Receive webhooks', word: 'webhooks', opens: { place: 'devices', list: 'addresses' }, sentence: 'Opens Addresses and ports in Devices and network: the switch for receiving webhooks and events from other tools, and where it listens.' },
  'who-signs-in': { label: 'Who can sign in here', word: 'who-signs-in', opens: { place: 'devices', list: 'addresses' }, sentence: 'Opens Addresses and ports in Devices and network, where the account that signs in to this GoodVibes from a browser or another device is made.' },
  'safety': { label: 'Safety', word: 'safety', opens: { place: 'safety', list: 'sandbox-setting' }, sentence: 'Opens Permissions and safety at the sandbox switch, beside the other safety settings.' },
};

/** Every topic's words: the capabilities' own, the place topics' and a provider of your own. */
export const SETUP_TOPICS: Readonly<Record<SetupTopicId, SetupTopicWords>> = {
  'model': MODEL_TOPIC,
  'sign-in': SIGN_IN_TOPIC,
  'add-provider': { label: 'Add a provider of your own', word: 'add-provider', sentence: 'Opens the form for adding an OpenAI-compatible provider of your own.' },
  ...FORM_TOPICS_REST,
  ...SETUP_PLACE_TOPICS,
};

function isPlaceTopic(id: string): id is SetupPlaceTopicId {
  return Object.prototype.hasOwnProperty.call(SETUP_PLACE_TOPICS, id);
}

/** This program's setup topic runs as the capabilities `setup.<topic>` take them (system-session.ts `setupTopic`). */
export function setupTopicOf<Ctx>(options: SetupCommandOptions<Ctx>, ctx: Ctx): (topic: string) => Promise<string | void> {
  return async (topic) => {
    const id = topic as SetupTopicId;
    const run = options.runs[id];
    if (!run) return options.elsewhere(id, SETUP_TOPICS[id]?.label ?? topic);
    return run({}, ctx);
  };
}

/** What a program does when a setup topic is opened; it returns the line to say, if any. */
export type SetupRun<Ctx> = (values: ActionValues, ctx: Ctx) => Promise<string | void>;

/** The rows the Setup list has besides the topics: pairing the Agent with a GoodVibes host (Devices and network's capabilities). */
export type SetupExtraId = 'pair' | 'unpair';

export interface SetupCommandOptions<Ctx> {
  /** Which program this is: its Setup list says what this program opens for each topic. */
  readonly program: 'tui' | 'agent';
  /**
   * What this program does for each topic. Both programs list the same topics
   * (one description for both); a topic this program does not serve runs
   * `elsewhere`, which says where that topic is set up.
   */
  readonly runs: Partial<Record<SetupTopicId, SetupRun<Ctx>>>;
  /** The line for a topic this program does not serve. */
  readonly elsewhere: (id: SetupTopicId, label: string) => string;
  /** This program pairs with a GoodVibes host (the Agent): the Setup list shows pairing and unpairing. */
  readonly pairsWithHost?: boolean | undefined;
  /** This program's settings, read when the list opens: the checklist's done marks and count. */
  readonly settings?: ((ctx: Ctx) => SetupSettings | undefined) | undefined;
  /** The recommended topics the person chose to skip for now, kept by the program. */
  readonly skipped?: { read(ctx: Ctx): ReadonlySet<string>; skip(ctx: Ctx, id: SetupTopicId): void | Promise<void>; unskip(ctx: Ctx, id: SetupTopicId): void | Promise<void> } | undefined;
  /**
   * First run's "Who decides" step as the checklist reads it: not done while
   * the mode lets a decision model decide and none can be asked (put off at
   * first run, or never answered); done once Ask me is chosen or one answers.
   */
  readonly whoDecides?: ((ctx: Ctx) => Promise<WhoDecidesState>) | undefined;
  /** This program's services: a topic is the capability `setup.<topic>`, run with them (its `setupTopic` runs `runs`). */
  readonly services?: ((ctx: Ctx) => SystemSessionServices) | undefined;
}

/** "Who decides" on the checklist: whether it is settled, and what is in force or missing. */
export interface WhoDecidesState {
  readonly done: boolean;
  readonly note: string;
}

/** The checklist line of "Who decides", which is first run's step rather than a topic of its own. */
export const WHO_DECIDES_LABEL = 'Who decides when GoodVibes would stop and ask';

/** The settings the checklist reads. */
export type SetupSettings = Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>;

/** One checklist line: whether a recommended topic is done, and what is set when it is. */
export interface SetupChecklistItem {
  readonly id: SetupTopicId;
  readonly done: boolean;
  /** What is set (`rt-1`, `Ask me`, `sandbox on`), or what is missing. */
  readonly note: string;
}

/** The topics most people set once, in order: the checklist and its count are these. */
export const RECOMMENDED_SETUP_TOPICS: readonly SetupTopicId[] = ['model', 'how-it-works', 'safety', 'history'];

/**
 * The skipped topics in the daemon's one setup record (capabilities/builtin/system-setup.ts): read from it, changed
 * through `setup.skip` as the person's own press, so a topic skipped in one program is skipped in the other.
 */
export function daemonSetupSkips<Ctx extends CommandActionContext>(
  homeOf: (ctx: Ctx) => string | undefined,
  binding: DaemonCapabilityBinding<Ctx>,
): NonNullable<SetupCommandOptions<Ctx>['skipped']> {
  const change = async (ctx: Ctx, id: SetupTopicId, back: boolean): Promise<void> => {
    await runDaemonCapability('setup.skip', { topic: id, back: back ? 'yes' : 'no' }, ctx, binding);
  };
  return {
    read: (ctx) => { const home = homeOf(ctx); return new Set(home ? readSetupState(home).skipped : []); },
    skip: (ctx, id) => change(ctx, id, false),
    unskip: (ctx, id) => change(ctx, id, true),
  };
}

/** The checklist from the settings in force: a few settings reads, no request. */
export function readSetupChecklist(settings: SetupSettings): SetupChecklistItem[] {
  const text = (key: string): string => { try { return String(settings.get(key as never) ?? '').trim(); } catch { return ''; } };
  const flag = (key: string): boolean => { try { return settings.get(key as never) === true; } catch { return false; } };
  const model = text('provider.model');
  const modeChosen = settings.isExplicitlySet?.('permissions.mode') === true;
  return [
    { id: 'model', done: model.length > 0, note: model || 'no model chosen yet' },
    { id: 'how-it-works', done: modeChosen, note: modeChosen ? `${gatePresetLabel(text('permissions.mode'))}, chosen` : 'when GoodVibes asks: the default, not chosen yet' },
    { id: 'safety', done: flag('sandbox.enabled'), note: flag('sandbox.enabled') ? 'sandbox on' : 'sandbox off' },
    { id: 'history', done: settings.isExplicitlySet?.('behavior.saveHistory') === true,
      note: settings.isExplicitlySet?.('behavior.saveHistory') === true
        ? (flag('behavior.saveHistory') ? 'conversations are saved' : 'conversations are not saved')
        : `not chosen yet (conversations are ${flag('behavior.saveHistory') ? '' : 'not '}saved)` },
  ];
}

// ---------------------------------------------------------------------------
// The System place's Setup list (places/system-place.ts): the checklist with
// "Who decides" first, then every other topic this program sets up, each
// opened by its own capability; read from this program's own settings, the
// daemon's setup record and its "Who decides" record, and read again on every
// settings change.
// ---------------------------------------------------------------------------

/** One row of the Setup list. */
export interface SetupPlaceItem {
  readonly id: SetupTopicId | SetupExtraId | 'who-decides';
  /**
   * `done` / `not-done` / `skipped` for the checklist (`undecided`: "Who decides" not done, which cannot be
   * skipped); `topic` for the rest.
   */
  readonly state: 'done' | 'not-done' | 'undecided' | 'skipped' | 'topic';
  readonly label: string;
  /** What is set, or what is missing. */
  readonly note: string;
  /** What opening it does. */
  readonly sentence: string;
}

/**
 * Every topic the Setup list offers after the checklist, in the topics' order: the list is where each one is set up
 * (a topic of another group is also a key in that group's place). A provider of your own is Models and providers'
 * "add a provider of your own" (`provider.add`), not a form here.
 */
const SYSTEM_SETUP_TOPICS: readonly (SetupTopicId | SetupExtraId)[] = [
  'sign-in', 'store-key', 'local-only', 'browser', 'other-devices', 'connect-daemon', 'webhooks', 'chat-apps', 'cloudflare',
  'who-signs-in', 'memory', 'telemetry', 'automation', 'devices-voice', 'provider-behaviour', 'advanced', 'import-settings',
  'pair', 'unpair', 'first-run',
];

/** The capability a row of the Setup list runs: its topic's, or Devices and network's for pairing with a host. */
function rowCapability(id: SetupTopicId | SetupExtraId): string {
  return id === 'pair' ? 'devices.pair' : id === 'unpair' ? 'devices.unpair-host' : `setup.${id}`;
}

const EXTRA_WORDS: Readonly<Record<SetupExtraId, SetupTopicWords>> = {
  // Short enough to stand whole in the Setup list at 80 columns; the sentence says the rest.
  pair: { label: 'Pair with a host', word: 'pair', sentence: 'Pairs this Agent with your GoodVibes host as your own device, with the sign-in code your own screen shows where you are signed in as yourself.' },
  unpair: { label: 'Unpair from the host', word: 'unpair', sentence: 'This Agent forgets its GoodVibes host credential and stops reaching that host.' },
};

/** What the Setup list does with one program's setup options and its live context. */
export interface SetupPlaceHooks {
  /** The list's source: read now (what was read last, read again behind it), told of every change. */
  readonly source: { read(): unknown; subscribe(onChange: () => void): () => void };
  /** Open a row: "Who decides" itself, or the topic's own capability run as the owner's press; what to say, if anything. */
  open(id: string, runTopic: (capabilityId: string) => Promise<{ readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly reason: string }>): Promise<string | undefined>;
  /** Skip a checklist topic for now, or bring a skipped one back (in the daemon's one setup record). */
  skip(id: string, back: boolean): Promise<string>;
}

export function setupPlaceHooks<Ctx>(options: SetupCommandOptions<Ctx>, ctx: Ctx, program: {
  /** Open "Who decides" alone for the model in use; false when it is not needed. */
  readonly openWhoDecides: () => Promise<boolean>;
  /** Open a place on one list, on top of what is open (the rows of `SETUP_PLACE_TOPICS`); absent where no place can be shown. */
  readonly openPlace?: ((place: string, list: string) => boolean) | undefined;
  /** Told on every change of this program's settings; returns the stop. */
  readonly onSettingsChange?: ((listener: () => void) => () => void) | undefined;
}): SetupPlaceHooks {
  const served = (id: SetupTopicId | SetupExtraId): boolean => (id === 'pair' || id === 'unpair' ? options.pairsWithHost === true : isPlaceTopic(id) || options.runs[id] !== undefined);
  const wordsOf = (id: SetupTopicId | SetupExtraId): SetupTopicWords => (id === 'pair' || id === 'unpair' ? EXTRA_WORDS[id] : SETUP_TOPICS[id]);
  // What this program opens for the topic: its own sentence where the two programs open different things.
  const sentenceOf = (id: SetupTopicId | SetupExtraId): string => wordsOf(id)[options.program] ?? wordsOf(id).sentence;
  const syncItems = (): SetupPlaceItem[] => {
    const settings = options.settings?.(ctx);
    const skipped = options.skipped?.read(ctx) ?? new Set<string>();
    const checklist = (settings ? readSetupChecklist(settings) : []).map((item): SetupPlaceItem => ({
      id: item.id, state: item.done ? 'done' : skipped.has(item.id) ? 'skipped' : 'not-done',
      label: SETUP_TOPICS[item.id].label, note: item.note, sentence: sentenceOf(item.id),
    }));
    const topics = SYSTEM_SETUP_TOPICS.filter(served).map((id): SetupPlaceItem => ({ id, state: 'topic', label: wordsOf(id).label, note: '', sentence: sentenceOf(id) }));
    return [...checklist, ...topics];
  };
  const fullItems = async (): Promise<SetupPlaceItem[]> => {
    const rest = syncItems();
    let decides: WhoDecidesState | undefined;
    try { decides = await options.whoDecides?.(ctx); } catch (error) {
      decides = { done: false, note: `could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!decides) return rest;
    return [{
      // A short row title (it fits beside "not done" at 80 columns); the sentence under it says what is decided.
      id: 'who-decides', state: decides.done ? 'done' : 'undecided', label: 'Who decides', note: decides.note,
      sentence: `${WHO_DECIDES_LABEL}: opens first run's "Who decides" step, where a decision model (Jev) decides or GoodVibes asks you.`,
    }, ...rest];
  };
  // Read when the list is first read, not when the program wires its places.
  let items: readonly SetupPlaceItem[] | undefined;
  let seq = 0;
  const listeners = new Set<() => void>();
  // Read again behind every read; the list is told only when something changed, so a read never starts another.
  const refresh = (): void => {
    const mine = ++seq;
    void fullItems().then((next) => {
      if (mine !== seq || JSON.stringify(next) === JSON.stringify(items)) return;
      items = next;
      for (const listener of [...listeners]) listener();
    }, () => { /* the settings were read above; nothing else to say */ });
  };
  return {
    source: {
      read: () => {
        items ??= syncItems();
        refresh();
        return items;
      },
      subscribe(onChange) {
        listeners.add(onChange);
        // After the change is made: the listener is told as it starts.
        const stop = program.onSettingsChange?.(() => { queueMicrotask(refresh); });
        return () => { listeners.delete(onChange); stop?.(); };
      },
    },
    async open(id, runTopic) {
      if (id === 'who-decides') {
        if (await program.openWhoDecides()) return undefined;
        return 'Nothing to decide here: GoodVibes asks you, or a decision model can answer.';
      }
      if (isPlaceTopic(id)) {
        const { place, list } = SETUP_PLACE_TOPICS[id].opens;
        if (!program.openPlace?.(place, list)) return `${SETUP_PLACE_TOPICS[id].label} cannot be shown here.`;
        return undefined;
      }
      const outcome = await runTopic(rowCapability(id as SetupTopicId | SetupExtraId));
      if (!outcome.ok) throw new Error(outcome.reason);
      return outcome.lines.join(' ') || undefined;
    },
    async skip(id, back) {
      if (!options.skipped) throw new Error('this program keeps no list of skipped topics');
      const known = RECOMMENDED_SETUP_TOPICS.find((topic) => topic === id);
      if (!known) throw new Error('only a topic of the checklist can be skipped');
      if (back) await options.skipped.unskip(ctx, known);
      else await options.skipped.skip(ctx, known);
      refresh();
      return back ? `${SETUP_TOPICS[known].label} is back on the checklist.` : `${SETUP_TOPICS[known].label} is skipped for now; it stays on the list as skipped.`;
    },
  };
}
