/**
 * system-place.ts, the System place: setting GoodVibes up and the state of
 * this computer and the daemon, with the keys (keys-place.ts) as its last tab.
 *
 *  - Setup: the checklist, "Who decides" first (first run's step, not done
 *    while it was put off and no decision model can be asked), then the
 *    topics of System this program sets up. A program source: the program's
 *    own settings, skip file and "Who decides" record, read again on every
 *    settings change. Enter opens the row; `s` skips a checklist topic for
 *    now, or brings a skipped one back.
 *  - Sleep: keep-awake and the work that holds this computer awake
 *    (`power.status.get`), followed on the daemon's `ops` events; `k` keeps
 *    it awake or lets it sleep again.
 *  - Updates: whether the daemon keeps itself up to date (`update.status`);
 *    `c` checks for a newer release now.
 *  - Voice: the local voice runtime that speaks and listens
 *    (`voice.local.status`); `i` installs it.
 *  - Sign-in: the first-run sign-in file (`local_auth.status`); `x` removes it.
 *  - Keys: every key, rebindable (the foundation's Keys place, as built).
 *
 * Every action but opening a row and changing a key is a capability
 * (capabilities/builtin/system.ts), the same the model and a script run.
 */
// The words from their own module (no handler reaches a Node module): the web UI draws this declaration too (places/browser.ts).
import { daemonUpdateWords, keepAwakeWords, voiceRuntimeWords } from '@goodvibes/engine/platform/platform/capabilities/system';
import type { SystemSessionServices } from '@goodvibes/engine/platform/platform/capabilities';
import type { SetupPlaceHooks, SetupPlaceItem } from '../setup-command.js';
import type { PlacePrograms } from './place-host.js';
import { KEYS_PLACE } from './keys-place.js';
import { definePlace, type PlaceAction, type PlaceDetailLine, type PlaceItem, type PlaceList } from './place-types.js';

interface SetupItem extends PlaceItem {
  readonly kind: 'setup';
  readonly state: SetupPlaceItem['state'];
  readonly label: string;
  readonly note: string;
  readonly sentence: string;
}

interface StateItem extends PlaceItem {
  readonly kind: 'state';
  readonly title: string;
  /** The word on the row's right, when the state needs one. */
  readonly right?: string | undefined;
  readonly mark: 'ok' | 'paused' | 'attention' | 'running';
  readonly lines: readonly string[];
  readonly facts?: readonly PlaceDetailLine[] | undefined;
}

type Item = SetupItem | StateItem;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const SETUP_STATE_WORDS: Readonly<Record<SetupItem['state'], string | undefined>> = {
  done: undefined, 'not-done': 'not done', undecided: 'not done', skipped: 'skipped for now', topic: undefined,
};

function setupItems(raw: unknown): readonly SetupItem[] {
  if (!Array.isArray(raw)) return [];
  return (raw as SetupPlaceItem[]).map((item): SetupItem => ({ kind: 'setup', id: item.id, state: item.state, label: item.label, note: item.note, sentence: item.sentence }));
}

function sleepItems(output: unknown): readonly StateItem[] {
  const state = record(output);
  if (Object.keys(state).length === 0) return [];
  const words = keepAwakeWords(state);
  return [{
    // Not "keep-awake": the place names an item by its title wherever its id is a word of a line, and that one is.
    kind: 'state', id: 'sleep-hold', state: words.state, title: 'Keep this computer awake',
    // One short word: a long one squeezes the title at 80 columns; the detail says why.
    right: words.state === 'off' ? 'off' : words.state === 'refused' ? 'refused' : 'on',
    mark: words.state === 'refused' ? 'attention' : words.state === 'off' ? 'paused' : 'ok',
    lines: words.lines,
  }];
}

function updateItems(output: unknown): readonly StateItem[] {
  const status = record(output);
  if (Object.keys(status).length === 0) return [];
  const failed = typeof status.failedCheckCount === 'number' && status.failedCheckCount > 0;
  const recovery = status.recoveryRequired === true || Object.keys(record(status.transactionRecovery)).length > 0;
  const installing = Object.keys(record(status.installing)).length > 0;
  const state = recovery ? 'recovery' : installing ? 'installing' : failed ? 'failing' : text(status.pendingVersion) ? 'pending' : status.armed === true ? 'on' : 'off';
  const right: Readonly<Record<string, string>> = {
    recovery: 'stopped', installing: 'installing', failing: 'checks failing', pending: `${text(status.pendingVersion)} waiting`, on: 'on', off: 'off',
  };
  return [{
    kind: 'state', id: 'daemon-updates', state, title: 'The daemon keeps itself up to date', right: right[state],
    mark: recovery || failed ? 'attention' : installing ? 'running' : state === 'off' ? 'paused' : 'ok',
    lines: daemonUpdateWords(status),
    facts: text(status.currentVersion) ? [{ label: 'Version now', text: text(status.currentVersion) }] : [],
  }];
}

const VOICE_RIGHT: Readonly<Record<string, string>> = {
  'not-provisioned': 'not installed', partial: 'partly installed', provisioned: 'installed', 'unsupported-platform': 'not available here', installing: 'installing',
};

function voiceItems(output: unknown): readonly StateItem[] {
  const status = record(output);
  if (Object.keys(status).length === 0) return [];
  const installing = Object.keys(record(status.installInProgress)).length > 0;
  const state = installing ? 'installing' : text(status.state) || 'not-provisioned';
  return [{
    kind: 'state', id: 'voice-runtime', state, title: 'The voice runtime (speaking and listening)', right: VOICE_RIGHT[state],
    mark: state === 'provisioned' ? 'ok' : installing ? 'running' : state === 'partial' ? 'attention' : 'paused',
    lines: voiceRuntimeWords(status),
  }];
}

function signInItems(output: unknown): readonly StateItem[] {
  const status = record(output);
  if (typeof status.bootstrapCredentialPresent !== 'boolean') return [];
  const present = status.bootstrapCredentialPresent;
  const users = typeof status.userCount === 'number' ? status.userCount : 0;
  return [{
    kind: 'state', id: 'first-run-file', state: present ? 'present' : 'removed', title: 'The first-run sign-in file', right: present ? 'still here' : 'removed',
    mark: present ? 'attention' : 'ok',
    lines: present
      ? [`It still holds the first sign-in to the web app${users === 0 ? '; no user has been added yet, so removing it leaves nobody who can sign in' : ''}.`]
      : ['It was removed; people sign in with their own accounts.'],
    facts: [
      ...(present && text(status.bootstrapCredentialPath) ? [{ label: 'Where', text: text(status.bootstrapCredentialPath), tone: 'muted' as const }] : []),
      { label: 'People who may sign in', text: String(users) },
    ],
  }];
}

function stateList(id: string, label: string, noun: string, method: string, items: (output: unknown) => readonly StateItem[], empty: string,
  follows?: PlaceList<Item>['follows']): PlaceList<Item> {
  return {
    id, label, noun,
    source: { kind: 'daemon', method, input: {}, items },
    ...(follows ? { follows } : {}),
    empty,
    row: (item) => {
      const state = item as StateItem;
      return { title: state.title, ...(state.right ? { right: state.right } : {}), mark: state.mark };
    },
    detail: (item) => {
      const state = item as StateItem;
      return [...state.lines.map((line) => ({ text: line })), ...(state.facts && state.facts.length > 0 ? [{ text: '' }, ...state.facts] : [])];
    },
  };
}

const SETUP_LIST: PlaceList<Item> = {
  id: 'setup',
  label: 'Setup',
  noun: 'what is set up',
  source: { kind: 'program', name: 'setup', items: setupItems },
  empty: 'Nothing to set up here.',
  row: (item) => {
    const setup = item as SetupItem;
    const right = SETUP_STATE_WORDS[setup.state];
    return {
      title: setup.label,
      ...(right ? { right } : {}),
      ...(setup.state === 'topic' ? {} : { mark: setup.state === 'done' ? 'ok' as const : setup.state === 'skipped' ? 'paused' as const : 'attention' as const }),
    };
  },
  detail: (item) => {
    const setup = item as SetupItem;
    return [
      ...(setup.note ? [{ label: setup.state === 'done' ? 'Set' : setup.state === 'topic' ? 'Now' : 'Missing', text: setup.note, ...(setup.state === 'not-done' || setup.state === 'undecided' ? { tone: 'warning' as const } : {}) }] : []),
      { text: setup.sentence },
    ];
  },
};

/** This program, as the "This session" list reads it (capabilities/builtin/system-session.ts). */
export type SystemSessionReader = () => SystemSessionServices['systemSession'];

/** The "This session" list's program source: the session at a glance, and how much the program prints. */
export function systemSessionSource(read: SystemSessionReader): { read(): unknown; subscribe(onChange: () => void): () => void } {
  return {
    read: () => {
      const system = read();
      if (!system) return [];
      let status: string;
      try { status = system.status(); } catch (error) { status = `The status could not be read: ${error instanceof Error ? error.message : String(error)}`; }
      const lines = status.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
      const items: StateItem[] = [{
        kind: 'state', id: 'this-session', state: 'open', title: 'This session', mark: 'ok',
        // The report's own heading ("Status") is the row's title here.
        lines: lines[0]?.trim() === 'Status' ? lines.slice(1).map((line) => line.trim()) : lines.map((line) => line.trim()),
      }];
      const level = system.printLevel;
      if (level) {
        const preset = level.getHITLPreset();
        const overrides = Object.entries(level.getDomainOverrides());
        items.push({
          kind: 'state', id: 'print-level', state: level.getHITLMode(), title: 'How much the app prints', right: level.getHITLMode(), mark: 'ok',
          lines: [preset.description],
          facts: overrides.length > 0 ? overrides.map(([domain, verbosity]) => ({ label: domain, text: `${verbosity}, for this session` })) : [{ text: 'No kind of notification is set on its own.', tone: 'muted' }],
        });
      }
      const speech = system.speech;
      if (speech) {
        const on = speech.alwaysSpeaks();
        items.push({
          kind: 'state', id: 'speaking', state: on ? 'speaking' : 'silent', title: 'Speak every answer aloud', right: on ? 'on' : 'off', mark: on ? 'ok' : 'paused',
          lines: [on ? 'Every answer is played aloud on this computer.' : 'Answers are not played aloud.', 'The voice runtime that speaks is on the Voice tab.'],
        });
      }
      if (system.viewLinks) {
        const links = system.viewLinks();
        items.push({
          kind: 'state', id: 'view-links', state: 'links', title: 'Links to this program\'s views', right: `${links.length}`, mark: 'ok',
          lines: ['A goodvibes://open link opens one view of this program.', ...links],
        });
      }
      if (system.help) {
        items.push({
          kind: 'state', id: 'help', state: 'help', title: 'Every command and every key', mark: 'ok',
          lines: ['One searchable list of every command and every key of this program.', 'Every key can be changed on the Keys tab.'],
        });
      }
      // Closing the program is a row the person selects and presses Enter on, never a letter of the place.
      items.push({
        kind: 'state', id: 'close-program', state: 'close', title: 'Close this program', mark: 'paused',
        lines: ['This program closes; work the daemon runs goes on without it.', 'Select this row and press Enter to close it.'],
      });
      return items;
    },
    // Read again on every read of the place (after each action); nothing here changes by itself.
    subscribe: () => () => {},
  };
}

const linesOf = (text: string): string[] => text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
const failed = (what: string, error: unknown): string => `${what} could not be read: ${error instanceof Error ? error.message : String(error)}`;

/**
 * The Health list's program source (capabilities/builtin/system-program.ts `health.*`, `startup.*`): what needs
 * attention now, this session's failure reports, and what this program started with. Read when the place opens,
 * after each action and on `r`.
 */
export function systemHealthSource(read: SystemSessionReader): { read(): Promise<unknown>; subscribe(onChange: () => void): () => void } {
  return {
    read: async () => {
      const system = read();
      if (!system) return [];
      const items: StateItem[] = [];
      const health = system.health;
      if (health) {
        let report: string;
        try { report = await health.report(); } catch (error) { report = failed('What needs attention', error); }
        const lines = linesOf(report);
        const ok = lines[0]?.startsWith('✓') === true && lines.length === 1;
        items.push({
          kind: 'state', id: 'health-report', state: ok ? 'working' : 'attention', title: 'Whether everything is working',
          right: ok ? 'working' : 'needs a look', mark: ok ? 'ok' : 'attention', lines,
        });
        if (health.failures) {
          items.push({
            kind: 'state', id: 'failure-reports', state: 'failures', title: 'Failure reports of this session', mark: 'ok',
            lines: ['What failed in this session, why, and the evidence; see one, save one as a file, or keep one in memory.'],
          });
        }
      }
      const startup = system.startup;
      if (startup) {
        let review: string;
        try { review = await startup.review(); } catch (error) { review = failed('What this program started with', error); }
        items.push({ kind: 'state', id: 'start', state: 'started', title: 'What this program started with', mark: 'ok', lines: linesOf(review) });
      }
      return items;
    },
    subscribe: () => () => {},
  };
}

/** The Release list's program source (`release.*`): this project's release readiness, from this session. */
export function systemReleaseSource(read: SystemSessionReader): { read(): unknown; subscribe(onChange: () => void): () => void } {
  return {
    read: () => {
      const release = read()?.release;
      if (!release) return [];
      let review: string;
      try { review = release.review(); } catch (error) { review = failed('Release readiness', error); }
      return [{ kind: 'state', id: 'release', state: 'release', title: 'Release readiness of this project', mark: 'ok', lines: linesOf(review) } satisfies StateItem];
    },
    subscribe: () => () => {},
  };
}

/** Text from outside the program (a notification's title and body) without control characters. */
const plain = (value: string): string => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

/** The Notices list's program source: every notice and notification this program collected, newest first, followed as they arrive. */
export function systemNoticesSource(read: SystemSessionReader): { read(): unknown; subscribe(onChange: () => void): () => void } {
  return {
    read: () => {
      const notices = read()?.notices;
      if (!notices) return [];
      return [...notices.list()].sort((a, b) => b.timestamp - a.timestamp).map((entry): StateItem => ({
        kind: 'state', id: entry.key, state: entry.level ?? 'info', title: plain(entry.title),
        right: `${entry.collapsedCount > 1 ? `×${entry.collapsedCount} · ` : ''}${new Date(entry.timestamp).toLocaleTimeString()}`,
        mark: entry.level === 'critical' || entry.level === 'warning' ? 'attention' : 'ok',
        lines: entry.body ? linesOf(plain(entry.body)) : [],
        facts: [{ label: 'Kind', text: entry.domain, tone: 'muted' }, { label: 'When', text: new Date(entry.timestamp).toLocaleString(), tone: 'muted' }],
      }));
    },
    subscribe: (onChange) => read()?.notices?.subscribe(onChange) ?? (() => {}),
  };
}

const programList = (id: string, label: string, noun: string, name: string, empty: string): PlaceList<Item> => ({
  id, label, noun,
  source: { kind: 'program', name, items: (raw) => (Array.isArray(raw) ? raw as StateItem[] : []) },
  empty,
  row: (item) => {
    const state = item as StateItem;
    return { title: state.title, ...(state.right ? { right: state.right } : {}), mark: state.mark };
  },
  detail: (item) => {
    const state = item as StateItem;
    return [...state.lines.map((line) => ({ text: line })), ...(state.facts && state.facts.length > 0 ? [{ text: '' }, ...state.facts] : [])];
  },
});

const HEALTH_LIST = programList('health', 'Health', 'whether this program is working', 'system-health', 'This program does not check its own health.');
const RELEASE_LIST = programList('release', 'Release', 'release readiness', 'system-release', 'Release readiness is read in the terminal app.');
const NOTICES_LIST = programList('notices', 'Notices', 'the notices and notifications', 'system-notices', 'No notice or notification yet.');

const SESSION_LIST: PlaceList<Item> = {
  id: 'session',
  label: 'This session',
  noun: 'this session',
  source: { kind: 'program', name: 'system-session', items: (raw) => (Array.isArray(raw) ? raw as StateItem[] : []) },
  empty: 'This program says nothing about this session.',
  row: (item) => {
    const state = item as StateItem;
    return { title: state.title, ...(state.right ? { right: state.right } : {}), mark: state.mark };
  },
  detail: (item) => {
    const state = item as StateItem;
    return [...state.lines.map((line) => ({ text: line })), ...(state.facts && state.facts.length > 0 ? [{ text: '' }, ...state.facts] : [])];
  },
};

const KEYS_ACTIONS: readonly PlaceAction<Item>[] = (KEYS_PLACE.actions as unknown as readonly PlaceAction<Item>[])
  // In the System place the Keys tab's actions apply on that tab only.
  .map((action) => ({ ...action, list: action.list ?? 'keys' }));

export const SYSTEM_PLACE = definePlace<Item>({
  id: 'system',
  group: 'system',
  title: 'System',
  lists: [
    SESSION_LIST,
    SETUP_LIST,
    HEALTH_LIST,
    NOTICES_LIST,
    stateList('sleep', 'Sleep', 'whether this computer may sleep', 'power.status.get', sleepItems, 'The daemon did not say whether this computer may sleep.',
      { domains: ['ops'], events: [] }),
    stateList('updates', 'Updates', 'the daemon\'s updates', 'update.status', updateItems, 'The daemon did not say how it updates itself.'),
    stateList('voice', 'Voice', 'the voice runtime', 'voice.local.status', voiceItems, 'The daemon did not say whether the voice runtime is installed.'),
    stateList('sign-in', 'Sign-in', 'the first-run sign-in file', 'local_auth.status', signInItems, 'The daemon did not say whether the first-run sign-in file is there.'),
    RELEASE_LIST,
    ...(KEYS_PLACE.lists as unknown as readonly PlaceList<Item>[]),
  ],
  actions: [
    { key: 'enter', id: 'close-program', list: 'session', states: ['close'], capability: 'system.quit', label: 'close this program' },
    { key: 'v', id: 'print-level', list: 'session', states: ['quiet', 'balanced', 'operator'], capability: 'verbosity.set', label: 'change' },
    { key: 'n', id: 'one-kind', list: 'session', states: ['quiet', 'balanced', 'operator'], capability: 'verbosity.set-domain', label: 'one kind of notification' },
    { key: 'a', id: 'speak-answers', list: 'session', states: ['silent'], capability: 'voice.on', label: 'speak answers' },
    { key: 'a', id: 'stop-speaking', list: 'session', states: ['speaking'], capability: 'voice.off', label: 'stop speaking them' },
    { key: 'p', id: 'ask-spoken', list: 'session', states: ['speaking', 'silent'], capability: 'voice.speak', label: 'ask and hear it' },
    { key: 'w', id: 'wake-again', list: 'session', states: ['speaking', 'silent'], capability: 'voice.wake-again', label: 'listen for the wake word again' },
    { kind: 'program', key: 'enter', id: 'open', list: 'setup', label: 'open', run: 'setup.open' },
    { kind: 'program', key: 's', id: 'skip', list: 'setup', states: ['not-done'], label: 'skip for now', run: 'setup.skip' },
    { kind: 'program', key: 's', id: 'bring-back', list: 'setup', states: ['skipped'], label: 'bring it back', run: 'setup.bring-back' },
    { key: 'k', id: 'keep-awake', list: 'sleep', states: ['off'], capability: 'power.on', label: 'keep awake' },
    { key: 'k', id: 'let-sleep', list: 'sleep', states: ['held', 'held-partial', 'refused'], capability: 'power.off', label: 'let it sleep' },
    { key: 'c', id: 'check-now', list: 'updates', states: ['on', 'off', 'failing', 'pending'], capability: 'update.daemon', label: 'check now', fill: { now: () => 'yes' } },
    { key: 'i', id: 'install', list: 'voice', states: ['not-provisioned', 'partial'], capability: 'voice.setup', label: 'install' },
    { key: 'x', id: 'remove-file', list: 'sign-in', states: ['present'], capability: 'local-auth.remove-first-run-file', label: 'remove it' },
    // This session: links to this program's views, and its help (capabilities/builtin/system-program.ts).
    { key: 'l', id: 'make-link', list: 'session', states: ['links'], capability: 'startup.link', label: 'make a link' },
    { key: 'g', id: 'open-link', list: 'session', states: ['links'], capability: 'startup.open-link', label: 'open a link' },
    { key: 'enter', id: 'help', list: 'session', states: ['help'], capability: 'system.help', label: 'open the list', fill: { about: () => '' } },
    // Health: whether this program is working, its failure reports, and what it started with.
    { key: 'a', id: 'check-area', list: 'health', states: ['working', 'attention'], capability: 'health.check', label: 'check one area' },
    { key: 'd', id: 'describe-problem', list: 'health', states: ['working', 'attention'], capability: 'health.diagnose', label: 'describe a problem' },
    { key: 't', id: 'runtime-store', list: 'health', states: ['working', 'attention'], capability: 'health.state', label: 'the runtime store' },
    { key: 'h', id: 'host-compat', list: 'health', states: ['working', 'attention'], capability: 'health.compat', label: 'the host\'s compatibility' },
    { key: 'enter', id: 'see-failure', list: 'health', states: ['failures'], capability: 'health.failure', label: 'see one' },
    { key: 's', id: 'save-failure', list: 'health', states: ['failures'], capability: 'health.save-failure', label: 'save one as a file' },
    { key: 'm', id: 'keep-failure', list: 'health', states: ['failures'], capability: 'health.keep-failure', label: 'keep one in memory' },
    { key: 'o', id: 'setup-problems', list: 'health', states: ['started'], capability: 'startup.doctor', label: 'check for problems' },
    { key: 'e', id: 'setup-services', list: 'health', states: ['started'], capability: 'startup.services', label: 'services and sign-ins' },
    { key: 's', id: 'save-setup-review', list: 'health', states: ['started'], capability: 'startup.export', label: 'save as a file' },
    // Voice: what is being spoken now, and the wake word on this terminal's microphone.
    { key: 't', id: 'stop-spoken', list: 'voice', capability: 'voice.stop', label: 'stop speaking' },
    { key: 'v', id: 'wake-status', list: 'voice', capability: 'voice.wake-status', label: 'the wake word' },
    { key: 'w', id: 'wake-setup', list: 'voice', capability: 'voice.wake-setup', label: 'set up the wake word' },
    // Release: this project's release readiness.
    { key: 'l', id: 'release-checklist', list: 'release', states: ['release'], capability: 'release.checklist', label: 'the checklist' },
    { key: 's', id: 'save-release', list: 'release', states: ['release'], capability: 'release.save', label: 'save the evidence' },
    { key: 'o', id: 'read-release', list: 'release', states: ['release'], capability: 'release.read', label: 'read saved evidence' },
    ...KEYS_ACTIONS,
  ],
  count: (lists) => {
    const open = (lists.setup ?? []).filter((item) => item.state === 'not-done' || item.state === 'undecided').length;
    const wrong = [...(lists.sleep ?? []), ...(lists.updates ?? []), ...(lists.health ?? [])].filter((item) => ['refused', 'failing', 'recovery', 'attention'].includes(item.state)).length;
    const conflicts = (lists.keys ?? []).filter((item) => item.state === 'conflict').length;
    if (wrong > 0) return { count: wrong, words: `${wrong} need${wrong === 1 ? 's' : ''} a look`, tone: 'wrong' };
    if (conflicts > 0) return { count: conflicts, words: `${conflicts} actions share ${conflicts > 2 ? 'keys' : 'a key'}`, tone: 'wrong' };
    return open > 0 ? { count: open, words: `${open} to set up`, tone: 'waiting' } : undefined;
  },
});

/** The Setup list's program actions: open a row, skip a checklist topic for now, bring it back. */
export function setupProgramActions(setup: SetupPlaceHooks): Readonly<Record<string, (itemId: string, place: PlacePrograms) => Promise<string | undefined>>> {
  return {
    'setup.open': (itemId, place) => setup.open(itemId, (capabilityId) => place.run(capabilityId, {})),
    'setup.skip': async (itemId) => setup.skip(itemId, false),
    'setup.bring-back': async (itemId) => setup.skip(itemId, true),
  };
}
