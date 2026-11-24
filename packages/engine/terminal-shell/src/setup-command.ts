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
import type { ActionDescription, ActionValues, CommandDescription, CommandReport, FirstScreenGroup, InputDescription } from './command-actions/types.js';
import { doAction, readAction } from './described-command-kit.js';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { gatePresetLabel } from '@goodvibes/engine/platform/platform/gate/presets';
import { writeFileAtomic } from '@goodvibes/engine/platform/platform/utils';
import { readFileSync } from 'node:fs';

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

/** Every topic's words, in list order. */
export const SETUP_TOPICS: Readonly<Record<SetupTopicId, SetupTopicWords>> = {
  'model': { label: 'Choose a model', word: 'model', sentence: 'Opens the form for the model new turns use and how hard it thinks.' },
  'sign-in': { label: 'Sign in or out of a provider', word: 'sign-in', sentence: 'Opens the form for signing in to a provider with your browser, finishing a sign-in, or signing out.' },
  'add-provider': { label: 'Add a provider of your own', word: 'add-provider', sentence: 'Opens the form for adding an OpenAI-compatible provider of your own.' },
  'store-key': { label: 'Store a password or key', word: 'store-key', sentence: 'Opens the form for storing a provider or channel key, and how keys are stored.' },
  'local-only': { label: 'Keep everything on this computer', word: 'local-only', sentence: 'Opens the form that turns off the browser, network and webhook access.' },
  'browser': { label: 'Open GoodVibes in a browser', word: 'browser', sentence: 'Opens the form for using GoodVibes from a web browser on this computer or your network.' },
  'other-devices': { label: 'Use it from other devices', word: 'other-devices', sentence: 'Opens the form for letting your other devices reach GoodVibes: addresses and ports.' },
  'connect-daemon': { label: 'Use a daemon on another computer', word: 'connect-daemon', sentence: 'Opens the form for pointing this program at a GoodVibes daemon already running on another computer; nothing on this computer is opened to the network.' },
  'webhooks': { label: 'Receive webhooks', word: 'webhooks', sentence: 'Opens the form for receiving webhooks and events from other tools.' },
  'chat-apps': { label: 'Connect chat apps and services', word: 'chat-apps', sentence: 'Opens the form for connecting Slack, Discord, Telegram and the other chat apps and services.' },
  'cloudflare': { label: 'Use Cloudflare', word: 'cloudflare', sentence: 'Opens the form for using Cloudflare for batch and remote work.' },
  'who-signs-in': { label: 'Who can sign in here', word: 'who-signs-in', sentence: 'Opens the form for the account that signs in to this GoodVibes from other devices.' },
  'how-it-works': { label: 'How GoodVibes works with you', word: 'how-it-works', sentence: 'Opens the form for how much GoodVibes tells you, how much guidance it gives, and when it asks.' },
  'safety': { label: 'Safety and sandboxing', word: 'safety', sentence: 'Opens the form for the sandbox and the other safety features.' },
  'memory': { label: 'Memory and context', word: 'memory', sentence: 'Opens the form for memory and how a long conversation is kept in context.' },
  'telemetry': { label: 'Record traces of what GoodVibes does', word: 'telemetry', sentence: 'Opens the form for tracing what GoodVibes does.' },
  'automation': { label: 'Scheduled routines, watchers and triggers', word: 'automation', sentence: 'Opens the form for scheduled routines, watchers and triggers.' },
  'devices-voice': { label: 'Paired devices and voice', word: 'devices-voice', sentence: 'Opens the form for paired phones and voice.' },
  'provider-behaviour': { label: 'Provider behaviour', word: 'provider-behaviour', sentence: 'Opens the form for how GoodVibes chooses and talks to providers.' },
  'advanced': { label: 'Advanced switches', word: 'advanced', sentence: 'Opens the form for the advanced runtime switches.' },
  'history': { label: 'History and privacy', word: 'history', sentence: 'Opens the setting for whether conversations are saved on this computer.' },
  'import-settings': { label: 'Bring over settings from the terminal app', word: 'import-settings', sentence: 'Copies the settings the Agent shares with the terminal app into the Agent.' },
  'first-run': { label: 'Run first-run again', word: 'first-run', sentence: 'Opens the three-step first run: choose a provider, sign in, start.' },
};

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
  readonly skipped?: { read(ctx: Ctx): ReadonlySet<string>; skip(ctx: Ctx, id: SetupTopicId): void } | undefined;
}

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
 * The skipped topics kept in one small JSON file (`setup-skipped.json` beside
 * the program's input history): read when `/setup` opens, written on a skip.
 */
export function setupSkipFile<Ctx>(pathOf: (ctx: Ctx) => string | undefined): NonNullable<SetupCommandOptions<Ctx>['skipped']> {
  const read = (ctx: Ctx): ReadonlySet<string> => {
    const path = pathOf(ctx);
    if (!path) return new Set();
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
    } catch { return new Set(); }
  };
  return {
    read,
    skip(ctx, id) {
      const path = pathOf(ctx);
      if (!path) return;
      writeFileAtomic(path, `${JSON.stringify([...new Set([...read(ctx), id])])}\n`, { mkdirp: true });
    },
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
    { id: 'history', done: settings.isExplicitlySet?.('behavior.saveHistory') === true, note: flag('behavior.saveHistory') ? 'conversations are saved' : 'conversations are not saved' },
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
export function setupCommandDescription<Ctx>(options: SetupCommandOptions<Ctx>): CommandDescription<Ctx> {
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
  const actions: ActionDescription<Ctx>[] = [];
  if (options.settings) {
    actions.push(readAction<Ctx>({
      id: 'checklist', label: 'See what is set up', word: 'checklist', readsOnlyThisMachine: true,
      sentence: 'Shows which of the things most people set once are done, and the line that sets each one that is not.',
      rowValue: async (ctx) => { const p = progress(ctx); return `${p.done} of ${p.total} set up`; },
      async run(_values, ctx): Promise<CommandReport> {
        const p = progress(ctx);
        return {
          verdict: p.open.length === 0 ? 'ok' : 'attention',
          headline: `${p.done} of ${p.total} set up.`,
          items: p.open.map((item) => ({ sentence: `${SETUP_TOPICS[item.id].label}: ${item.note}.`, fix: { label: SETUP_TOPICS[item.id].label, line: `/setup ${SETUP_TOPICS[item.id].word}` } })),
        };
      },
    }));
    if (options.skipped) {
      const skippable = RECOMMENDED_SETUP_TOPICS.map((id) => ({ value: id, label: SETUP_TOPICS[id].label }));
      actions.push(doAction<Ctx>({
        id: 'skip', label: 'Skip a topic for now', word: 'skip',
        inputs: [{ id: 'topic', label: 'Topic', help: 'The topic to leave off the list of what is left', kind: 'choice', choices: skippable, required: true, typed: { position: 1 } }],
        sentence: '{topic} is left off the list of what is left to set up; it stays in /setup.', example: { topic: 'safety' },
        async run(values, ctx) {
          options.skipped!.skip(ctx, values.topic as SetupTopicId);
          return `${SETUP_TOPICS[values.topic as SetupTopicId]?.label ?? values.topic} is skipped for now; /setup ${values.topic} still opens it.`;
        },
      }));
    }
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
    actions.push(doAction<Ctx>({ id, label: words.label, word: words.word, sentence: words.sentence, run: runOf(id, words.label), rowValue: rowValue(id) }));
  }
  actions.push(
    doAction<Ctx>({
      id: 'pair', label: 'Pair the Agent with a GoodVibes host', word: 'pair', touches: 'another-machine', inputs: PAIR_INPUTS,
      sentence: 'This Agent pairs with your GoodVibes host as {name}, after you confirm in this terminal.', example: {},
      run: runOf('pair', 'Pair the Agent with a GoodVibes host'), rowValue: rowValue('pair'),
    }),
    doAction<Ctx>({
      id: 'unpair', label: 'Unpair the Agent from the GoodVibes host', word: 'unpair', touches: 'credential',
      sentence: 'This Agent forgets its GoodVibes host credential and stops reaching that host.',
      ownerOnly: { reason: 'It takes this Agent\'s access to your GoodVibes host away.', instead: 'The owner types /setup unpair in the live Agent terminal.' },
      run: runOf('unpair', 'Unpair the Agent from the GoodVibes host'), rowValue: rowValue('unpair'),
    }),
  );
  const rows: (string | FirstScreenGroup)[] = [
    ...(options.settings ? ['checklist'] : []),
    'model', 'sign-in', 'add-provider', 'store-key',
    { label: 'Reach GoodVibes from elsewhere…', actions: REACH_GROUP },
    'chat-apps', 'who-signs-in', 'how-it-works',
    { label: 'Features and switches…', actions: FEATURE_GROUP },
    'history', 'import-settings',
    'pair', 'unpair',
    ...(options.settings && options.skipped ? ['skip'] : []),
    'first-run',
  ];
  return {
    name: 'setup',
    title: 'Set up GoodVibes',
    summary: 'Set GoodVibes up, one topic at a time',
    group: 'Settings',
    firstScreenRows: rows,
    actions,
  };
}
