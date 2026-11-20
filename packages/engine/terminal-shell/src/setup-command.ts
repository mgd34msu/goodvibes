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
import type { ActionDescription, CommandDescription, FirstScreenGroup } from './command-actions/types.js';
import { doAction } from './described-command-kit.js';

export type SetupTopicId =
  | 'model'
  | 'sign-in'
  | 'add-provider'
  | 'store-key'
  | 'local-only'
  | 'browser'
  | 'other-devices'
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
  'webhooks': { label: 'Receive webhooks', word: 'webhooks', sentence: 'Opens the form for receiving webhooks and events from other tools.' },
  'chat-apps': { label: 'Connect chat apps and services', word: 'chat-apps', sentence: 'Opens the form for connecting Slack, Discord, Telegram and the other chat apps and services.' },
  'cloudflare': { label: 'Use Cloudflare', word: 'cloudflare', sentence: 'Opens the form for using Cloudflare for batch and remote work.' },
  'who-signs-in': { label: 'Who can sign in here', word: 'who-signs-in', sentence: 'Opens the form for the account that signs in to this GoodVibes from other devices.' },
  'how-it-works': { label: 'How GoodVibes works with you', word: 'how-it-works', sentence: 'Opens the form for how much GoodVibes tells you, how much guidance it gives, and when it asks.' },
  'safety': { label: 'Safety and sandboxing', word: 'safety', sentence: 'Opens the form for the sandbox and the other safety features.' },
  'memory': { label: 'Memory and context', word: 'memory', sentence: 'Opens the form for memory and how a long conversation is kept in context.' },
  'telemetry': { label: 'Telemetry', word: 'telemetry', sentence: 'Opens the form for tracing what GoodVibes does.' },
  'automation': { label: 'Automation', word: 'automation', sentence: 'Opens the form for scheduled routines, watchers and triggers.' },
  'devices-voice': { label: 'Paired devices and voice', word: 'devices-voice', sentence: 'Opens the form for paired phones and voice.' },
  'provider-behaviour': { label: 'Provider behaviour', word: 'provider-behaviour', sentence: 'Opens the form for how GoodVibes chooses and talks to providers.' },
  'advanced': { label: 'Advanced switches', word: 'advanced', sentence: 'Opens the form for the advanced runtime switches.' },
  'history': { label: 'History and privacy', word: 'history', sentence: 'Opens the setting for whether conversations are saved on this computer.' },
  'import-settings': { label: 'Bring over settings from the terminal app', word: 'import-settings', sentence: 'Copies the settings the Agent shares with the terminal app into the Agent.' },
  'first-run': { label: 'Run first-run again', word: 'first-run', sentence: 'Opens the three-step first run: choose a provider, sign in, start.' },
};

/** The topics gathered under one row of the first screen, so the list stays short. */
const REACH_GROUP: readonly SetupTopicId[] = ['local-only', 'browser', 'other-devices', 'webhooks', 'cloudflare'];
const FEATURE_GROUP: readonly SetupTopicId[] = ['safety', 'memory', 'telemetry', 'automation', 'devices-voice', 'provider-behaviour', 'advanced'];
/** Topics listed on their own row, in order (the two groups sit after `store-key` and `how-it-works`). */
const SINGLE_ROWS: readonly SetupTopicId[] = ['model', 'sign-in', 'add-provider', 'store-key', 'chat-apps', 'who-signs-in', 'how-it-works', 'history', 'import-settings'];

export interface SetupCommandOptions<Ctx> {
  /**
   * The topics this program opens, each with its form. A topic left out is not
   * listed. The function returns the line to print, or nothing when the form it
   * opened says what happened.
   */
  readonly topics: Partial<Record<SetupTopicId, (ctx: Ctx) => Promise<string | void>>>;
  /** A right-hand dim note for a topic's row (`Agent only`), read when the list opens. */
  readonly topicNotes?: Partial<Record<SetupTopicId, string>> | undefined;
  /** Actions only this program has, after the topics. */
  readonly extraActions?: readonly ActionDescription<Ctx>[] | undefined;
  /** First-screen rows for the extra actions (an action id, or a group of them). */
  readonly extraRows?: readonly (string | FirstScreenGroup)[] | undefined;
}

function topicAction<Ctx>(id: SetupTopicId, open: (ctx: Ctx) => Promise<string | void>, note: string | undefined): ActionDescription<Ctx> {
  const words = SETUP_TOPICS[id];
  return doAction<Ctx>({
    id,
    label: words.label,
    word: words.word,
    sentence: words.sentence,
    run: (_values, ctx) => open(ctx),
    ...(note !== undefined ? { rowValue: async () => note } : {}),
  });
}

/** `/setup`'s description: the topics this program opens, then its own actions. */
export function setupCommandDescription<Ctx>(options: SetupCommandOptions<Ctx>): CommandDescription<Ctx> {
  const has = (id: SetupTopicId): boolean => options.topics[id] !== undefined;
  const actions: ActionDescription<Ctx>[] = [];
  for (const id of Object.keys(SETUP_TOPICS) as SetupTopicId[]) {
    const open = options.topics[id];
    if (open) actions.push(topicAction(id, open, options.topicNotes?.[id]));
  }
  actions.push(...(options.extraActions ?? []));

  const rows: (string | FirstScreenGroup)[] = [];
  const group = (label: string, ids: readonly SetupTopicId[]): void => {
    const present = ids.filter(has);
    if (present.length > 1) rows.push({ label, actions: present });
    else if (present.length === 1) rows.push(present[0]!);
  };
  for (const id of SINGLE_ROWS) {
    if (has(id)) rows.push(id);
    if (id === 'store-key') group('Reach GoodVibes from elsewhere…', REACH_GROUP);
    if (id === 'how-it-works') group('Features and switches…', FEATURE_GROUP);
  }
  rows.push(...(options.extraRows ?? []));
  if (has('first-run')) rows.push('first-run');

  return {
    name: 'setup',
    title: 'Set up GoodVibes',
    summary: 'Choose a topic to set up: models, sign-in, keys, access, chat apps and features.',
    group: 'Settings',
    firstScreenRows: rows,
    actions,
  };
}
