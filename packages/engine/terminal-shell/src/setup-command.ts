/**
 * setup-command.ts, `/setup` in both terminal programs: a guided command whose
 * actions are topics. Bare `/setup` lists them; each topic opens one form for
 * that topic (the terminal app's former wizard pages, the Agent's former Start
 * rows), which applies only its own fields. Every item of the old first-run
 * wizard and of the Agent's Start table lives in one of these topics.
 *
 * The topic list, its words and its order are here, once. A program passes the
 * topics it can open (its own form for each) and any actions only it has; a
 * topic a program does not pass is not listed there.
 */
import type { ActionDescription, ActionValues, CommandActionContext, CommandDescription, CommandReport, FirstScreenGroup, InputDescription } from './command-actions/types.js';
import { doAction, readAction } from './described-command-kit.js';
import {
  DEVICES_PAIR, DEVICES_UNPAIR_HOST, SETUP_TOPIC_CAPABILITIES, SETUP_TOPIC_WORDS, readSetupState, type SystemSessionServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { runDaemonCapability, sessionCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
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
  /** One sentence: what the form lets you do. */
  readonly sentence: string;
}

/** Every topic's words, in list order: the capabilities' own (capabilities/builtin/system-program.ts `setup.<topic>`). */
const { model: MODEL_TOPIC, 'sign-in': SIGN_IN_TOPIC, ...FORM_TOPICS_REST } = SETUP_TOPIC_WORDS;
export const SETUP_TOPICS: Readonly<Record<SetupTopicId, SetupTopicWords>> = {
  'model': MODEL_TOPIC,
  'sign-in': SIGN_IN_TOPIC,
  'add-provider': { label: 'Add a provider of your own', word: 'add-provider', sentence: 'Opens the form for adding an OpenAI-compatible provider of your own.' },
  ...FORM_TOPICS_REST,
};

/** This program's `/setup` topic runs as the capabilities `setup.<topic>` take them (system-session.ts `setupTopic`). */
export function setupTopicOf<Ctx>(options: SetupCommandOptions<Ctx>, ctx: Ctx): (topic: string) => Promise<string | void> {
  return async (topic) => {
    const id = topic as SetupTopicId;
    const run = options.runs[id];
    if (!run) return options.elsewhere(id, SETUP_TOPICS[id]?.label ?? topic);
    return run({}, ctx);
  };
}

/** The topics gathered under one row of the first screen, so the list stays short. */
const REACH_GROUP: readonly SetupTopicId[] = ['local-only', 'browser', 'other-devices', 'connect-daemon', 'webhooks', 'cloudflare'];
const FEATURE_GROUP: readonly SetupTopicId[] = ['safety', 'memory', 'telemetry', 'automation', 'devices-voice', 'provider-behaviour', 'advanced'];

/** What a program does when one of `/setup`'s actions is chosen; it returns the line to print, if any. */
export type SetupRun<Ctx> = (values: ActionValues, ctx: Ctx) => Promise<string | void>;

/** The actions `/setup` has besides the topics: pairing the Agent with a GoodVibes host. */
export type SetupExtraId = 'pair' | 'unpair';

export interface SetupCommandOptions<Ctx> {
  /**
   * What this program does for each topic and action. Both programs list the
   * same topics (one description for both); an id this program does not serve
   * runs `elsewhere`, which says where that topic is set up.
   */
  readonly runs: Partial<Record<SetupTopicId | SetupExtraId, SetupRun<Ctx>>>;
  /** The line for a topic this program does not serve. */
  readonly elsewhere: (id: SetupTopicId | SetupExtraId, label: string) => string;
  /** A right-hand dim note for a row (`Agent only`), read when the list opens. */
  readonly notes?: Partial<Record<SetupTopicId | SetupExtraId, string>> | undefined;
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
  /** This program's services: a topic's action is the capability `setup.<topic>`, run with them (its `setupTopic` runs `runs`). */
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

const PAIR_INPUTS: readonly InputDescription[] = [
  {
    id: 'name', label: 'Name', help: 'What the host calls this Agent', kind: 'text', freeTextReason: 'A name you choose.',
    required: { default: 'GoodVibes Agent', defaultMeans: 'GoodVibes Agent' }, typed: { flag: '--name' },
  },
  {
    id: 'apply', label: 'Pair now', help: 'Pair now, or only see what pairing would do', kind: 'choice',
    choices: [{ value: 'preview', label: 'Only show what it would do' }, { value: 'apply', label: 'Pair now', risk: 'loosens-a-protection' }],
    required: { default: 'preview', defaultMeans: 'only show what it would do' }, typed: { flag: '--apply', switchOn: 'apply' },
  },
];

const ADD_PROVIDER_INPUTS: readonly InputDescription[] = [
  { id: 'name', label: 'Name', help: 'A short name for the provider: letters, numbers, - and _', kind: 'text', freeTextReason: 'A name you choose.', required: true, typed: { position: 1 } },
  { id: 'url', label: 'Address', help: 'Its OpenAI-compatible address, ending in /v1', kind: 'text', freeTextReason: 'The address of a server you run or use.', required: true, typed: { position: 2 } },
];

/** `/setup`'s description, the same in both programs; only what each action runs differs. */
export function setupCommandDescription<Ctx extends CommandActionContext>(options: SetupCommandOptions<Ctx>): CommandDescription<Ctx> {
  const runOf = (id: SetupTopicId | SetupExtraId, label: string): SetupRun<Ctx> =>
    options.runs[id] ?? (async () => options.elsewhere(id, label));
  const checklist = (ctx: Ctx): SetupChecklistItem[] => {
    const settings = options.settings?.(ctx);
    return settings ? readSetupChecklist(settings) : [];
  };
  const skippedOf = (ctx: Ctx): ReadonlySet<string> => options.skipped?.read(ctx) ?? new Set();
  // A recommended topic's row says whether it is done: `✓ rt-1`, `skipped for now`, or what is missing.
  const rowValue = (id: SetupTopicId | SetupExtraId) => async (ctx: Ctx): Promise<string> => {
    const item = checklist(ctx).find((entry) => entry.id === id);
    if (!item) return options.notes?.[id] ?? '';
    if (item.done) return `✓ ${item.note}`;
    return skippedOf(ctx).has(id) ? 'skipped for now' : item.note;
  };
  const progress = (ctx: Ctx): { done: number; total: number; open: SetupChecklistItem[] } => {
    const items = checklist(ctx);
    const skipped = skippedOf(ctx);
    return { done: items.filter((item) => item.done).length, total: items.length, open: items.filter((item) => !item.done && !skipped.has(item.id)) };
  };
  // "Who decides" counts with the recommended topics; it is first run's step, opened from the System place's Setup list.
  const fullProgress = async (ctx: Ctx): Promise<{ done: number; total: number; whoDecides: WhoDecidesState | undefined }> => {
    const p = progress(ctx);
    let whoDecides: WhoDecidesState | undefined;
    try { whoDecides = await options.whoDecides?.(ctx); } catch { whoDecides = undefined; }
    return { done: p.done + (whoDecides?.done ? 1 : 0), total: p.total + (whoDecides ? 1 : 0), whoDecides };
  };
  const actions: ActionDescription<Ctx>[] = [];
  if (options.settings) {
    actions.push(readAction<Ctx>({
      id: 'checklist', label: 'See what is set up', word: 'checklist', readsOnlyThisMachine: true,
      sentence: 'Shows which of the things most people set once are done, and the line that sets each one that is not.',
      rowValue: async (ctx) => { const p = await fullProgress(ctx); return `${p.done} of ${p.total} set up`; },
      async run(_values, ctx): Promise<CommandReport> {
        const p = progress(ctx);
        const full = await fullProgress(ctx);
        const open = [
          ...(full.whoDecides && !full.whoDecides.done ? [{ sentence: `${WHO_DECIDES_LABEL}: ${full.whoDecides.note}. It is on the Setup list in the System place.` }] : []),
          ...p.open.map((item) => ({ sentence: `${SETUP_TOPICS[item.id].label}: ${item.note}.`, fix: { label: SETUP_TOPICS[item.id].label, line: `/setup ${SETUP_TOPICS[item.id].word}` } })),
        ];
        return {
          verdict: open.length === 0 ? 'ok' : 'attention',
          headline: `${full.done} of ${full.total} set up.`,
          items: open,
        };
      },
    }));
  }
  for (const id of Object.keys(SETUP_TOPICS) as SetupTopicId[]) {
    const words = SETUP_TOPICS[id];
    if (id === 'add-provider') {
      actions.push({
        id, label: words.label, word: words.word, inputs: ADD_PROVIDER_INPUTS,
        sentence: 'The provider {name} at {url} is added {lasts}.', done: 'Added the provider {name} {lasts}.',
        touches: 'this-machine', lasts: 'kept', risk: 'none', example: { name: 'my-server', url: 'http://192.168.0.85:8001/v1' },
        run: runOf(id, words.label), rowValue: rowValue(id),
      });
      continue;
    }
    // The topic is the capability setup.<topic> (capabilities/builtin/system-program.ts): find, a model and other places reach it by id.
    const capability = SETUP_TOPIC_CAPABILITIES.find((definition) => definition.capability.id === `setup.${id}`);
    if (capability && options.services) {
      actions.push({ ...sessionCapabilityAction<Ctx, SystemSessionServices>(capability, options.services, { terminalOnly: 'It opens a form of the terminal program you are using.' }), rowValue: rowValue(id) });
      continue;
    }
    actions.push(doAction<Ctx>({ id, label: words.label, word: words.word, sentence: words.sentence, run: runOf(id, words.label), rowValue: rowValue(id) }));
  }
  // Pairing this program with its daemon and forgetting that pairing are the Devices and network place's two session
  // capabilities (platform builtin/devices-session.ts): these rows are the same capabilities, not second ones, so find
  // and run reach one of each (a described action carrying a moved capability's id is never a second catalog entry).
  actions.push(
    {
      ...doAction<Ctx>({
        id: 'pair', label: EXTRA_WORDS.pair.label, word: 'pair', touches: 'another-machine', inputs: PAIR_INPUTS,
        sentence: 'This Agent pairs with your GoodVibes host as {name}, after you confirm in this terminal.', example: {},
        run: runOf('pair', EXTRA_WORDS.pair.label), rowValue: rowValue('pair'),
      }),
      capability: DEVICES_PAIR.capability,
    },
    {
      ...doAction<Ctx>({
        id: 'unpair', label: EXTRA_WORDS.unpair.label, word: 'unpair', touches: 'credential',
        sentence: 'This Agent forgets its GoodVibes host credential and stops reaching that host.',
        ownerOnly: { reason: 'It takes this Agent\'s access to your GoodVibes host away.', instead: 'Forget this terminal\'s daemon pairing, in the Devices and network place.' },
        run: runOf('unpair', EXTRA_WORDS.unpair.label), rowValue: rowValue('unpair'),
      }),
      capability: DEVICES_UNPAIR_HOST.capability,
    },
  );
  const rows: (string | FirstScreenGroup)[] = [
    ...(options.settings ? ['checklist'] : []),
    'model', 'sign-in', 'add-provider', 'store-key',
    { label: 'Reach GoodVibes from elsewhere…', actions: REACH_GROUP },
    'chat-apps', 'who-signs-in', 'how-it-works',
    { label: 'Features and switches…', actions: FEATURE_GROUP },
    'history', 'import-settings',
    'pair', 'unpair',
    'first-run',
  ];
  // On a checklist topic not yet done: `s` skips it for now, and on a skipped one brings it back.
  const skippable = (id: string, ctx: Ctx): 'skip' | 'bring-back' | undefined => {
    if (!options.skipped) return undefined;
    const item = checklist(ctx).find((entry) => entry.id === id);
    if (!item || item.done) return undefined;
    return skippedOf(ctx).has(id) ? 'bring-back' : 'skip';
  };
  return {
    name: 'setup',
    title: 'Set up GoodVibes',
    summary: 'Set GoodVibes up, one topic at a time',
    group: 'Settings',
    firstScreenRows: rows,
    rowKey: {
      key: 's',
      label: (id, ctx) => {
        const state = skippable(id, ctx);
        return state === 'skip' ? 'skip for now' : state === 'bring-back' ? 'bring it back' : undefined;
      },
      press: (id, ctx) => {
        const state = skippable(id, ctx);
        const done = state === 'skip' ? options.skipped!.skip(ctx, id as SetupTopicId) : state === 'bring-back' ? options.skipped!.unskip(ctx, id as SetupTopicId) : undefined;
        // A refusal is the daemon's own words; the list shows the record as it is either way.
        void Promise.resolve(done).catch(() => undefined);
      },
    },
    actions,
  };
}

// ---------------------------------------------------------------------------
// The System place's Setup list (places/system-place.ts): the checklist with
// "Who decides" first, then the topics of System this program sets up, each
// opened by its own action; read from this program's own settings, its skip
// file and its "Who decides" record, and read again on every settings change.
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

/** The topics of System the Setup list offers after the checklist (the others are in their own places). */
const SYSTEM_SETUP_TOPICS: readonly (SetupTopicId | SetupExtraId)[] = [
  'local-only', 'browser', 'connect-daemon', 'webhooks', 'who-signs-in', 'telemetry', 'provider-behaviour', 'advanced', 'import-settings', 'pair', 'unpair', 'first-run',
];

const EXTRA_WORDS: Readonly<Record<SetupExtraId, SetupTopicWords>> = {
  // Short enough to stand whole in the Setup list at 80 columns; the sentence says the rest.
  pair: { label: 'Pair with a host', word: 'pair', sentence: 'Pairs this Agent with your GoodVibes host, after you confirm here.' },
  unpair: { label: 'Unpair from the host', word: 'unpair', sentence: 'This Agent forgets its GoodVibes host credential and stops reaching that host.' },
};

/** What the Setup list does with one program's `/setup` options and its live context. */
export interface SetupPlaceHooks {
  /** The list's source: read now (what was read last, read again behind it), told of every change. */
  readonly source: { read(): unknown; subscribe(onChange: () => void): () => void };
  /** Open a row: "Who decides" itself, or the topic's own action run as the owner's press; what to say, if anything. */
  open(id: string, runTopic: (capabilityId: string) => Promise<{ readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly reason: string }>): Promise<string | undefined>;
  /** Skip a checklist topic for now, or bring a skipped one back (in the daemon's one setup record). */
  skip(id: string, back: boolean): Promise<string>;
}

export function setupPlaceHooks<Ctx>(options: SetupCommandOptions<Ctx>, ctx: Ctx, program: {
  /** Open "Who decides" alone for the model in use; false when it is not needed. */
  readonly openWhoDecides: () => Promise<boolean>;
  /** Told on every change of this program's settings; returns the stop. */
  readonly onSettingsChange?: ((listener: () => void) => () => void) | undefined;
}): SetupPlaceHooks {
  const served = (id: SetupTopicId | SetupExtraId): boolean => options.runs[id] !== undefined;
  const wordsOf = (id: SetupTopicId | SetupExtraId): SetupTopicWords => (id === 'pair' || id === 'unpair' ? EXTRA_WORDS[id] : SETUP_TOPICS[id]);
  const syncItems = (): SetupPlaceItem[] => {
    const settings = options.settings?.(ctx);
    const skipped = options.skipped?.read(ctx) ?? new Set<string>();
    const checklist = (settings ? readSetupChecklist(settings) : []).map((item): SetupPlaceItem => ({
      id: item.id, state: item.done ? 'done' : skipped.has(item.id) ? 'skipped' : 'not-done',
      label: SETUP_TOPICS[item.id].label, note: item.note, sentence: SETUP_TOPICS[item.id].sentence,
    }));
    const topics = SYSTEM_SETUP_TOPICS.filter(served).map((id): SetupPlaceItem => ({ id, state: 'topic', label: wordsOf(id).label, note: '', sentence: wordsOf(id).sentence }));
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
      const outcome = await runTopic(`setup.${id}`);
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
