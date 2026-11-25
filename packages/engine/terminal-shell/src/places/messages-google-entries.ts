/**
 * messages-google-entries.ts, the Google tab of Mail, calendar and channels
 * (messages-place.ts holds the place; this is its Google list and actions).
 *
 * The one Gmail and Google Calendar connection is the daemon's: the tab reads
 * what is stored through `google.status` with no call to Google, and follows
 * LIST_CHANGED `google`, which the daemon announces at each step of a run
 * (connecting, asking for consent again, a client handed over), when its
 * consent link opens and closes, and when the connection is adopted, set or
 * removed. So a run started anywhere (here, the other terminal program, the
 * web UI, a script, a model's call) shows its steps here as they go, with no
 * key and no timer. The consent link is the run's reveal, shown to the person
 * who pressed the key in its own pane (with the copy key), never in a row.
 *
 * The connection is one item; the steps of the run under way (or the last
 * one) are the rows under it. Every action is a capability of the group
 * (platform capabilities/builtin/google.ts), on the connection, in the states
 * where it applies. This file holds no terminal code: the web UI draws these
 * entries too.
 */
import type { PlaceAction, PlaceDetailLine, PlaceItem, PlaceList } from './place-types.js';

const plain = (value: string): string => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g, ' ');
const text = (value: unknown): string => typeof value === 'string' ? plain(value) : '';
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map(plain) : [];

/** The connection's one state: what is stored, or the run under way. */
export type GoogleState = 'connected' | 'calendar-only' | 'api-off' | 'consent-needed' | 'mail-only' | 'not-connected' | 'unreadable' | 'connecting' | 'consent' | 'needs-you';

export interface GoogleConnectionItem extends PlaceItem {
  readonly kind: 'google';
  readonly state: GoogleState;
  readonly account: string;
  /** What is stored, in the daemon's words (no secret). */
  readonly lines: readonly string[];
  /** A Google API the last check found switched off, in the daemon's words ("enable it" turns it on); empty when none. */
  readonly apiOff: string;
  readonly run?: { readonly label: string; readonly state: string; readonly notes: readonly string[]; readonly needs: string; readonly summary: string } | undefined;
}

export interface GoogleStepItem extends PlaceItem {
  readonly kind: 'google-step';
  /** `stopped`: the person stopped the run while this step was under way. */
  readonly state: 'running' | 'done' | 'already-done' | 'needs-human' | 'failed' | 'skipped' | 'stopped';
  readonly title: string;
  readonly detail: string;
  readonly problem: string;
  readonly fix: string;
}

export type GoogleItem = GoogleConnectionItem | GoogleStepItem;

const STORED: readonly string[] = ['connected', 'consent-needed', 'mail-only', 'not-connected', 'unreadable'];
const STEP_STATES: readonly string[] = ['running', 'done', 'already-done', 'needs-human', 'failed', 'skipped', 'stopped'];

/** `google.status` (as `capabilities.run` answers it) as the connection and the steps of its run. */
export function googleItems(output: unknown): readonly GoogleItem[] {
  const data = isRecord(output) && isRecord(output['data']) ? output['data'] : undefined;
  if (!data) return [];
  const stored = typeof data['state'] === 'string' && STORED.includes(data['state']) ? data['state'] as GoogleState : 'not-connected';
  const work = isRecord(data['work']) ? data['work'] : undefined;
  const runState = text(work?.['state']);
  const apiOff = text(data['apiOff']);
  // Connected by a calendar sign-in, for the calendar alone (no mail); connected, with an API Google said is off: the
  // state "enable it" applies to.
  const settled: GoogleState = stored === 'connected' && data['calendarOnly'] === true ? 'calendar-only'
    : stored === 'connected' && apiOff ? 'api-off' : stored;
  const state: GoogleState = runState === 'running' ? 'connecting' : runState === 'consent' ? 'consent' : runState === 'needs-you' ? 'needs-you' : settled;
  const connection: GoogleConnectionItem = {
    id: 'google', kind: 'google', state, account: text(data['account']), lines: strings(data['lines']), apiOff,
    // Not set up is not something on the tab to count, as with mail's and the channels' own (PlaceItem.uncounted).
    ...(state === 'not-connected' ? { uncounted: true as const } : {}),
    ...(work ? { run: { label: text(work['label']), state: runState, notes: strings(work['notes']), needs: text(work['needs']), summary: text(work['summary']) } } : {}),
  };
  const steps = work && Array.isArray(work['steps']) ? work['steps'].filter(isRecord) : [];
  return [connection, ...steps.flatMap((step): GoogleStepItem[] => {
    const id = text(step['id']);
    if (!id) return [];
    const stepState = text(step['state']);
    return [{
      id: `step-${id}`, kind: 'google-step', state: (STEP_STATES.includes(stepState) ? stepState : 'skipped') as GoogleStepItem['state'],
      title: text(step['title']) || id, detail: text(step['detail']), problem: text(step['problem']), fix: text(step['fix']),
    }];
  })];
}

// A row's state word is a few words, so it is shown whole beside the account at 80 columns (the detail says the rest).
const STATE_WORDS: Readonly<Record<GoogleState, string>> = {
  connected: 'connected', 'calendar-only': 'calendar only', 'api-off': 'API off', 'consent-needed': 'needs consent', 'mail-only': 'app password',
  'not-connected': 'not connected', unreadable: 'could not be read', connecting: 'connecting', consent: 'link waiting', 'needs-you': 'needs you',
};
/** The detail's words for the state, whole. */
const STATE_DETAIL: Readonly<Record<GoogleState, string>> = {
  ...STATE_WORDS, 'api-off': 'connected, but Google refuses part of it: an API is switched off',
  'calendar-only': 'connected for the calendar only: a calendar sign-in granted it, without mail; "ask for consent again" asks for mail and calendar together',
  'consent-needed': 'needs your consent', 'mail-only': 'mail by app password', consent: 'waiting for your consent to the link',
};
const STATE_MARK: Readonly<Record<GoogleState, 'ok' | 'paused' | 'attention' | 'running' | 'waiting'>> = {
  connected: 'ok', 'calendar-only': 'ok', 'api-off': 'attention', 'consent-needed': 'waiting', 'mail-only': 'ok', 'not-connected': 'paused', unreadable: 'attention',
  connecting: 'running', consent: 'waiting', 'needs-you': 'waiting',
};
/** A connection whose grant names no account until a check reads the mailbox (credentials taken up from another tool). */
const ADDRESS_NOT_CHECKED = 'address not checked yet';
const hasGrant = (state: GoogleState): boolean => state === 'connected' || state === 'api-off';
const STEP_WORDS: Readonly<Record<GoogleStepItem['state'], string>> = {
  running: 'under way', done: 'done', 'already-done': 'already done', 'needs-human': 'needs you', failed: 'did not go through', skipped: 'not reached',
  stopped: 'stopped',
};
const STEP_MARK: Readonly<Record<GoogleStepItem['state'], 'ok' | 'paused' | 'attention' | 'running' | 'waiting'>> = {
  running: 'running', done: 'ok', 'already-done': 'ok', 'needs-human': 'waiting', failed: 'attention', skipped: 'paused', stopped: 'paused',
};

function connectionDetail(item: GoogleConnectionItem): readonly PlaceDetailLine[] {
  // The reason the row is in the state shown comes first, so it stands above the fold on a small screen.
  const refused: PlaceDetailLine[] = item.apiOff ? [{ label: 'Refused', text: `${item.apiOff} "enable it" turns it on.`, tone: 'warning' }] : [];
  const lines: PlaceDetailLine[] = [
    ...(item.state === 'api-off' ? refused : []),
    { label: 'State', text: STATE_DETAIL[item.state] },
    ...(item.account ? [{ label: 'Account', text: item.account }]
      : hasGrant(item.state) ? [{ label: 'Account', text: `${ADDRESS_NOT_CHECKED}: "check it" reads the mailbox once and names it`, tone: 'muted' as const }] : []),
    ...(item.state === 'api-off' ? [] : refused),
    ...item.lines.map((line) => ({ text: line, tone: item.state === 'unreadable' ? 'warning' as const : 'plain' as const })),
  ];
  const run = item.run;
  if (run) {
    lines.push({ text: '' }, { label: run.state === 'done' || run.state === 'stopped' ? 'Last run' : 'Under way', text: run.label });
    for (const note of run.notes) lines.push({ text: note, tone: 'muted' });
    if (run.needs && (run.state === 'consent' || run.state === 'needs-you')) lines.push({ label: 'Needs you', text: run.needs, tone: 'warning' });
    // "Ended", whatever the end: the summary says itself how ("Stopped asking ...", "Stopped at ...", "Connected ...").
    if (run.summary) lines.push({ label: 'Ended', text: run.summary, tone: run.state === 'done' ? 'plain' : 'warning' });
  }
  return lines;
}

const FOLLOWS = { domains: [], events: [], lists: ['google'] } as const;

export const MESSAGES_GOOGLE_LISTS: readonly PlaceList<GoogleItem>[] = [
  {
    id: 'google',
    label: 'Google',
    noun: 'your Google connection',
    // What is stored, read without a call to Google; the check that reads mail and calendar is a key.
    source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'google.status', inputs: { check: 'no' } }, items: googleItems },
    follows: FOLLOWS,
    empty: 'The daemon did not say what is stored for Google.',
    row: (item) => item.kind === 'google'
      // The tab is Google's: the row is the account itself, so its state word fits beside it at 80 columns.
      // With a grant and no address yet (taken up from another tool), the row says the address is not checked yet.
      ? { title: item.account || (hasGrant(item.state) ? `Google, ${ADDRESS_NOT_CHECKED}` : 'Google account'), right: STATE_WORDS[item.state], mark: STATE_MARK[item.state] }
      : { title: `  ${item.title}`, right: STEP_WORDS[item.state], mark: STEP_MARK[item.state] },
    detail: (item) => item.kind === 'google' ? connectionDetail(item) : [
      { label: 'Step', text: item.title },
      { label: 'State', text: STEP_WORDS[item.state] },
      ...(item.detail ? [{ text: item.detail }] : []),
      ...(item.problem ? [{ label: 'Why', text: item.problem, tone: 'warning' as const }] : []),
      ...(item.fix ? [{ label: 'Do this', text: item.fix }] : []),
    ],
  },
];

/** The states in which nothing is under way and the store could be read. */
const SETTLED: readonly GoogleState[] = ['connected', 'calendar-only', 'api-off', 'consent-needed', 'mail-only', 'not-connected', 'needs-you'];

export const MESSAGES_GOOGLE_ACTIONS: readonly PlaceAction<GoogleItem>[] = [
  // Connecting: the shortest route from what is there (it installs what it needs as it goes); its consent link opens in
  // its own pane. The run goes on after the press answers, so its outcome line goes once the connection moves on.
  { key: 'c', id: 'google-connect', list: 'google', states: SETTLED, capability: 'google.connect', label: 'connect', outcomeFollowsItem: true },
  // Asked again while the link waits: the same link, shown again.
  { key: 'c', id: 'google-consent-link', list: 'google', states: ['consent'], capability: 'google.connect', label: 'show the consent link again', outcomeFollowsItem: true },
  // A run under way stops: the step running ends and the run says what was and was not set up.
  { key: 's', id: 'google-stop', list: 'google', states: ['connecting', 'consent'], capability: 'google.stop', label: 'stop connecting' },
  // The same on the step under way (the selection is on it after the press that started the run).
  { key: 's', id: 'google-stop-step', list: 'google', states: ['running'], capability: 'google.stop', label: 'stop connecting' },
  { key: 'k', id: 'google-check', list: 'google', states: ['connected', 'api-off'], capability: 'google.status', label: 'check it', fill: { check: () => 'yes' } },
  // An API Google said is switched off (a check found it): turned on with the gcloud on the daemon's machine.
  { key: 'e', id: 'google-enable-api', list: 'google', states: ['api-off'], capability: 'google.enable-api', label: 'enable it' },
  // A calendar-only grant gains mail the same way: one consent asks for mail and calendar together.
  { key: 'a', id: 'google-consent-again', list: 'google', states: ['connected', 'calendar-only', 'api-off', 'consent-needed'], capability: 'google.reauthorize', label: 'ask for consent again', outcomeFollowsItem: true },
  { key: 'x', id: 'google-disconnect', list: 'google', states: ['connected', 'calendar-only', 'api-off', 'consent-needed', 'mail-only', 'needs-you'], capability: 'google.forget', label: 'disconnect' },
  // Other ways to connect, and the settings a connection uses.
  { key: 'o', id: 'google-route', list: 'google', states: SETTLED, capability: 'google.setup', label: 'connect by one route', form: true, outcomeFollowsItem: true },
  { key: 'i', id: 'google-client', list: 'google', states: SETTLED, capability: 'google.client', label: 'use your client id and secret', outcomeFollowsItem: true },
  { key: 'f', id: 'google-client-file', list: 'google', states: SETTLED, capability: 'google.client-file', label: 'use your client file', outcomeFollowsItem: true },
  { key: 'u', id: 'google-adopt', list: 'google', states: SETTLED, capability: 'google.adopt', label: 'take up credentials on this machine', form: true },
  { key: 'm', id: 'google-account', list: 'google', states: [...SETTLED, 'unreadable'], capability: 'google.account', label: 'the Gmail address' },
  { key: 'l', id: 'google-calendar-address', list: 'google', states: SETTLED, capability: 'google.calendar-address', label: 'calendar by private address' },
  { key: 'w', id: 'google-written-steps', list: 'google', whole: true, capability: 'google.runbook', label: 'the written steps' },
];
