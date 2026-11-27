/**
 * Google: the one Gmail and Google Calendar connection, the daemon's.
 *
 * Every Google setting is the daemon's and every Google credential is filed in
 * its secret store, so connecting, asking for consent again, handing over an
 * OAuth client, checking, adopting the credentials found on the daemon's
 * machine and disconnecting all run in the daemon (google/daemon-work.ts),
 * whichever program, page, script or model asked. A run goes on in the daemon
 * after the capability answers: it answers once the run has its consent link
 * (handed to the person who asked, as the capability's reveal), needs the
 * person for something else, or ended; each step after that is announced as
 * the `google` list changing, which the Google tab of Mail, calendar and
 * channels follows.
 *
 * The two answers on a send the Agent's content check refused (send it as
 * shown, drop it) are answers to that send's item in the owner inbox, where the
 * Agent posted it: the same act as the answer pressed in Waiting for you.
 */
import { listEveryOwnerItem, type OwnerInboxPort, type OwnerItem } from '../../control-plane/owner-inbox.js';
import { renderGoogleSetupRunbook } from '../../google/setup-runbook.js';
import type { DaemonGoogleWork, GoogleWorkBusy, GoogleWorkStarted, GoogleWorkState } from '../../google/daemon-work.js';
import { serviceWords, type GoogleApiOff } from '../../google/connection-proof.js';
import type { GoogleCredentialItem } from '../../google/credential-removal.js';
import type { GoogleSetupState } from '../../google/setup-state.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type CapabilityResult, type InputDescription } from '../types.js';
import { callerPathOf } from '../path-inputs.js';
import { isHeldSend, plainInboxText } from './waiting.js';
import type { CalendarHereCapabilityServices } from './calendar.js';

/** The feed the private calendar address is subscribed as, in the daemon's calendar (the name 3.5.0's Agent gave it). */
export const GOOGLE_CALENDAR_FEED = 'Google calendar';

/** The private address as the daemon calendar's "Google calendar" feed, replacing the one there; what came of it in words. */
async function subscribeGoogleFeed(services: GoogleCapabilityServices, url: string, privateNetwork: boolean): Promise<string> {
  const calendar = services.calendarHere;
  if (!calendar) return 'The daemon keeps no calendar of its own here, so it was not subscribed as a feed.';
  const feeds = calendar.local().feeds;
  const replaced = await feeds.unsubscribe(GOOGLE_CALENDAR_FEED);
  const added = await feeds.subscribe(url, { name: GOOGLE_CALENDAR_FEED, privateNetwork });
  calendar.changed();
  if (!added.ok) return `It was not subscribed as the "${GOOGLE_CALENDAR_FEED}" feed${replaced.removed ? ', and the feed of that name was removed' : ''}: ${plainInboxText(added.detail)} "calendar by private address" tries again.`;
  return `Its events show in your calendar as the "${GOOGLE_CALENDAR_FEED}" feed${replaced.removed ? ', in place of the earlier one' : ''} (${added.eventCount} event${added.eventCount === 1 ? '' : 's'}).`;
}

/** The daemon's Google connection (google/daemon-work.ts), as the capabilities use it. */
export interface GoogleCapabilityServices {
  readonly google?: Pick<DaemonGoogleWork, 'current' | 'openConsentUrl' | 'stored' | 'describeStored' | 'account' | 'calendarOnly' | 'prove'
    | 'connect' | 'setup' | 'client' | 'reauthorize' | 'stop' | 'adopt' | 'forget' | 'setAccount' | 'setCalendarAddress' | 'privateHostApproved'
    | 'apiOff' | 'enableApis'> | undefined;
  /** The daemon's calendar kept on this computer (builtin/calendar.ts): the private address is its "Google calendar" feed. */
  readonly calendarHere?: Pick<CalendarHereCapabilityServices['calendarHere'], 'local' | 'changed'> | undefined;
  /** The daemon's one owner inbox, where the Agent posts each send its content check refused. */
  readonly ownerInbox?: Pick<OwnerInboxPort, 'list' | 'find'> | undefined;
}

const PLACE = 'the Google tab of Mail, calendar and channels';
/** The control that connects, by its name on the tab (its key can be rebound, so it is not named). */
const CONNECT_KEY = '"connect"';
const READ = { done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none' } as const;
/** Storing, replacing or removing a Google credential is the owner's to decide for a model: put to him, opening on No. */
const CREDENTIAL_EFFECTS = ['control-plane.write', 'secret.write'] as const;
/** What a consent link is, as the pane that shows it says it. */
const CONSENT_REVEAL = {
  label: 'Consent link',
  note: 'Open it in a browser signed in to the Google account to connect and approve it; it asks for mail and calendar together. It works once, for ten minutes; the steps show on the Google tab.',
} as const;

function googleOf(services: GoogleCapabilityServices): NonNullable<GoogleCapabilityServices['google']> {
  if (!services.google) throw new CapabilityRefusal('This daemon was started without its Google connection; nothing was read or changed.', undefined, 'UNAVAILABLE');
  return services.google;
}

/** Whether the person asked himself (a key, a form, a typed line), so a consent link may be handed back. */
function person(caller: CapabilityCaller): boolean {
  return caller.personAsked === true;
}

/** The connection's one state, read from what is stored (no call to Google). */
export type GoogleConnectionState = 'connected' | 'consent-needed' | 'mail-only' | 'not-connected' | 'unreadable';

export function googleConnectionStateOf(state: GoogleSetupState): GoogleConnectionState {
  if (state.secretStoreUnreadable) return 'unreadable';
  if (state.hasRefreshToken) return 'connected';
  if (state.oauthClientId !== null && state.hasOAuthClientSecret) return 'consent-needed';
  if (state.gmailEnabled || state.hasCalendarAddress) return 'mail-only';
  return 'not-connected';
}

/** A run as a screen or a script reads it (never the consent link). */
function workData(work: GoogleWorkState | null): Readonly<Record<string, unknown>> | null {
  if (!work) return null;
  return {
    id: work.id, kind: work.kind, label: work.label, state: work.state, startedAt: work.startedAt,
    ...(work.finishedAt !== undefined ? { finishedAt: work.finishedAt } : {}),
    steps: work.steps.map((step) => ({ id: step.id, title: step.title, state: step.state,
      ...(step.detail ? { detail: step.detail } : {}), ...(step.problem ? { problem: step.problem } : {}), ...(step.fix ? { fix: step.fix } : {}) })),
    notes: work.notes,
    ...(work.needs ? { needs: work.needs } : {}),
    ...(work.summary ? { summary: work.summary } : {}),
  };
}

/** What a started run answers: its link to the person, its end, or what it waits on. */
function startedResult(started: GoogleWorkStarted | GoogleWorkBusy, caller: CapabilityCaller, openConsentUrl: string | null = null): CapabilityResult {
  if ('busy' in started) {
    // Asked again while its link waits: the person who asks is shown the same link again; nothing new is started.
    if (started.busy.state === 'consent' && openConsentUrl && person(caller)) {
      return { text: `${started.busy.label} is waiting for the consent link to be approved; here it is again.`, data: { work: workData(started.busy) }, reveal: { value: openConsentUrl } };
    }
    throw new CapabilityRefusal(`${started.busy.label} is already under way; nothing new was started.`, `Its progress is on ${PLACE}, where "stop connecting" stops it.`, 'BUSY');
  }
  const { work } = started;
  const steps = work.steps.filter((step) => step.state !== 'running').map((step) => `${step.title}: ${step.detail ?? step.state}`);
  if (started.ended) {
    if (!started.ended.ok && work.state !== 'needs-you') throw new CapabilityRefusal(started.ended.text, `Its steps are on ${PLACE}.`, 'GOOGLE_NOT_CONNECTED');
    return { text: [started.ended.text, ...(work.state === 'needs-you' && work.needs ? [`Needs you: ${work.needs}`] : [])].join('\n'), data: { work: workData(work) } };
  }
  if (started.consentUrl) {
    const lines = [
      `${work.label}: ${steps.length > 0 ? `${steps.length} step${steps.length === 1 ? '' : 's'} done, ` : ''}one thing needs you, the consent link.`,
      person(caller)
        ? 'Open the consent link and approve it; the connection finishes by itself and its progress shows on the Google tab.'
        : 'The consent link is waiting for the owner in Waiting for you; the connection finishes by itself once he approves it.',
    ];
    return { text: lines.join('\n'), data: { work: workData(work) }, ...(person(caller) ? { reveal: { value: started.consentUrl } } : {}) };
  }
  return { text: [`${work.label} needs you: ${work.needs ?? 'see its steps'}`, `It carries on when you run it again; its steps are on ${PLACE}.`].join('\n'), data: { work: workData(work) } };
}

// ── Seeing the connection ───────────────────────────────────────────────────

const CHECK: InputDescription = {
  id: 'check', label: 'Check by use', help: 'Read the mailbox and the calendar once to prove the connection works', kind: 'choice',
  choices: [{ value: 'yes', label: 'Yes, read mail and calendar once' }, { value: 'no', label: 'No, only what is stored' }],
  required: { default: 'yes', defaultMeans: 'read mail and calendar once' }, typed: { flag: '--check' },
};

export const GOOGLE_STATUS: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.status', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'status', word: 'status', label: 'See whether Gmail and Google Calendar are connected', inputs: [CHECK], ...READ,
  sentence: 'Shows what is connected for Gmail and Google Calendar, proven by reading them, and what to do for what failed.', example: { check: 'yes' },
  async run(values, services) {
    const google = googleOf(services);
    const stored = await google.stored();
    const state = googleConnectionStateOf(stored);
    let account = state === 'unreadable' ? null : await google.account();
    const lines = [...google.describeStored(stored).map((line) => `  ${line}`)];
    let proof: { readonly ok: boolean; readonly account: string | null } | null = null;
    // A calendar sign-in's grant (Calendar accounts): the calendar alone, no mail; nothing reads the mailbox with it.
    const calendarOnly = state === 'connected' && await google.calendarOnly();
    if (calendarOnly) {
      lines.unshift('Connected for the calendar only: a calendar sign-in granted it, without mail.',
        `  "ask for consent again" on ${PLACE} asks for mail and calendar together.`, '');
    } else if (state === 'connected' && values.check !== 'no') {
      const proved = await google.prove();
      if (proved === null) {
        lines.push('', `A credential is stored but does not make a working connection: ask Google for consent again (${PLACE}).`);
      } else {
        proof = { ok: proved.ok, account: proved.account };
        // The account Google itself names, when the grant carries no recorded label.
        account ??= proved.account;
        // What the check found comes first (a part that failed and what to do), then what is stored.
        lines.unshift('Proven by use', ...proved.lines.map((line) => `  ${line}`), '');
      }
    } else if (state === 'not-connected' || state === 'mail-only') {
      lines.push('', `Connect it with ${CONNECT_KEY} on ${PLACE}.`);
    } else if (state === 'consent-needed') {
      lines.push('', `Only your consent is missing: ${CONNECT_KEY} on ${PLACE} shows the link.`);
    }
    const work = google.current;
    if (work && (work.state === 'running' || work.state === 'consent' || work.state === 'needs-you')) {
      lines.push('', `${work.label}: ${work.state === 'consent' ? 'waiting for the consent link to be approved' : work.state === 'needs-you' ? `needs you: ${work.needs ?? ''}` : 'under way'}.`);
    }
    const apiOff = google.apiOff;
    if (apiOff) lines.push('', `${apiOffWords(apiOff)} "enable it" on ${PLACE} turns it on.`);
    lines.unshift(`Google connection${account ? ` (${account})` : ''}`);
    return {
      text: lines.join('\n'),
      data: {
        state, account, gmail: stored.gmailEnabled, calendarAddress: stored.hasCalendarAddress, oauthClient: stored.oauthClientId !== null,
        ...(calendarOnly ? { calendarOnly: true } : {}),
        lines: google.describeStored(stored), work: workData(work),
        consentOpen: google.openConsentUrl !== null,
        ...(proof ? { proven: proof.ok } : {}),
        // An API Google said is switched off, in words: the Google tab offers "enable it" while it is.
        ...(apiOff ? { apiOff: apiOffWords(apiOff) } : {}),
      },
    };
  },
};

/** "The Gmail API is switched off on project p-1." */
function apiOffWords(apiOff: GoogleApiOff): string {
  const what = apiOff.services.map(serviceWords).join(' and ');
  return `${what.replace(/^./, (first) => first.toUpperCase())} ${apiOff.services.length === 1 ? 'is' : 'are'} switched off${apiOff.project ? ` on project ${apiOff.project}` : ''}, so Google refuses those requests.`;
}

export const GOOGLE_ENABLE_API: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.enable-api', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'enable-api', word: 'enable-api', label: 'Turn on the Gmail and Google Calendar APIs', inputs: [],
  sentence: 'Turns on the Google APIs this connection needs (Gmail, Google Calendar) that Google said are switched off, on the Cloud project that holds its OAuth client, with the gcloud signed in on the daemon\'s machine; they stay on until you turn them off in the Google Cloud console.',
  done: '', touches: 'another-machine', lasts: 'kept', risk: 'none', example: {},
  async run(_values, services) {
    const outcome = await googleOf(services).enableApis();
    if (!outcome.ok) throw new CapabilityRefusal(outcome.text, `"check it" on ${PLACE} reads mail and calendar again.`);
    return { text: outcome.text };
  },
};

export const GOOGLE_RUNBOOK: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.runbook', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'runbook', word: 'runbook', label: 'See the written steps for connecting Google by hand', inputs: [], ...READ,
  sentence: 'Shows the step-by-step instructions for connecting Gmail and Google Calendar by hand.', example: {},
  async run() {
    return { text: renderGoogleSetupRunbook() };
  },
};

// ── Connecting ──────────────────────────────────────────────────────────────

export const GOOGLE_CONNECT: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.connect', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'connect', word: 'connect', label: 'Connect Gmail and Google Calendar', inputs: [],
  sentence: 'Works out the shortest route and connects mail and calendar: what it needs (the Google Cloud SDK, about 500 MB, into your home folder) is installed as it goes; at most you approve one consent link; the credential is kept until you change it.',
  done: '', touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'forget',
  effects: [...CREDENTIAL_EFFECTS], reveals: CONSENT_REVEAL, example: {},
  async run(_values, services, caller) {
    const google = googleOf(services);
    return startedResult(await google.connect({ personAsked: person(caller) }), caller, google.openConsentUrl);
  },
};

export const GOOGLE_REAUTHORIZE: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.reauthorize', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'reauthorize', word: 'reauthorize', label: 'Ask Google for consent again', inputs: [],
  sentence: 'Asks for a fresh consent covering mail and calendar together, kept until you change it; the current connection stays in use until Google returns a new one. Use it when a scope is missing or the credential is dead.',
  done: '', touches: 'credential', lasts: 'kept', risk: 'none',
  effects: [...CREDENTIAL_EFFECTS], reveals: CONSENT_REVEAL, example: {},
  async run(_values, services, caller) {
    const google = googleOf(services);
    const started = await google.reauthorize({ personAsked: person(caller) });
    if ('refused' in started) throw new CapabilityRefusal(started.refused, `${CONNECT_KEY} on ${PLACE} starts from what is there.`);
    return startedResult(started, caller, google.openConsentUrl);
  },
};

export const GOOGLE_STOP: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.stop', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'stop', word: 'stop', label: 'Stop connecting Google', inputs: [],
  sentence: 'Stops the Google connection under way: the step running ends, its consent link stops working and nothing more is set up; what was already set up is kept, and it says which.',
  done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const outcome = await googleOf(services).stop();
    if (!outcome.stopped) throw new CapabilityRefusal(outcome.text, undefined, 'NOT_FOUND');
    return { text: outcome.text, data: { work: workData(outcome.work) } };
  },
};

const ROUTES = [
  { value: 'app-password', label: 'An app password', help: 'Mail only, with the calendar read by its private address; no Cloud project' },
  { value: 'oauth', label: 'A new OAuth client', help: 'Creates one in a Cloud project' },
  { value: 'existing-client', label: 'An OAuth client you have' },
] as const;

export const GOOGLE_SETUP: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.setup', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'setup', word: 'setup', label: 'Connect Google by one chosen route',
  inputs: [{
    id: 'path', label: 'Route', help: 'Which way to connect; "Connect Gmail and Google Calendar" picks for you', kind: 'choice', choices: ROUTES,
    required: { default: 'app-password', defaultMeans: 'an app password' }, typed: { flag: '--path' },
  }],
  sentence: 'Runs the chosen route step by step, each step shown as it goes; what it stores is kept until you change it.',
  done: '', touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'forget',
  effects: [...CREDENTIAL_EFFECTS], reveals: CONSENT_REVEAL, example: { path: 'oauth' },
  async run(values, services, caller) {
    const path = values.path === 'oauth' || values.path === 'existing-client' ? values.path : 'app-password';
    const google = googleOf(services);
    return startedResult(await google.setup(path, { personAsked: person(caller) }), caller, google.openConsentUrl);
  },
};

export const GOOGLE_CLIENT: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.client', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'client', word: 'client', label: 'Connect Google with an OAuth client id and secret you have',
  inputs: [
    { id: 'clientId', label: 'Client id', help: 'Copied from the Google Cloud console', kind: 'text', freeTextReason: 'an id Google gave you', required: true, typed: { position: 1 } },
    { id: 'clientSecret', label: 'Client secret', help: 'Copied from the Google Cloud console; hidden as you type, kept only in the secret store', kind: 'secret', required: true, typed: { position: 2 } },
  ],
  sentence: 'Client {clientId} and its secret are stored and a consent link is asked for; no Cloud project step is run, and it is kept until you change it.',
  done: '', touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'forget',
  effects: [...CREDENTIAL_EFFECTS], reveals: CONSENT_REVEAL, example: { clientId: '1234.apps.googleusercontent.com' },
  async run(values, services, caller) {
    const clientId = (values.clientId ?? '').trim();
    const clientSecret = (values.clientSecret ?? '').trim();
    if (!clientId || !clientSecret) throw new CapabilityRefusal('Both the client id and its secret are needed; nothing was stored.');
    const google = googleOf(services);
    return startedResult(await google.client({ kind: 'manual-entry', clientId, clientSecret }, { personAsked: person(caller) }), caller, google.openConsentUrl);
  },
};

export const GOOGLE_CLIENT_FILE: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.client-file', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'client-file', word: 'client-file', label: 'Connect Google with an OAuth client file you downloaded',
  inputs: [{ id: 'path', label: 'Client file', help: 'The client JSON downloaded from the Google Cloud console, on the daemon\'s machine', kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 } }],
  sentence: 'The client in {path} is stored and a consent link is asked for; it is kept until you change it.',
  done: '', touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'forget',
  effects: [...CREDENTIAL_EFFECTS], reveals: CONSENT_REVEAL, example: { path: 'client_secret.json' },
  async run(values, services, caller) {
    const raw = (values.path ?? '').trim();
    if (!raw) throw new CapabilityRefusal('No client file was named; nothing was stored.');
    // A path is the asking program's, placed by the one rule for every capability's path (capabilities/path-inputs.ts).
    const path = callerPathOf(caller, raw);
    const google = googleOf(services);
    return startedResult(await google.client({ kind: 'client-json-file', path }, { personAsked: person(caller) }), caller, google.openConsentUrl);
  },
};

export const GOOGLE_ADOPT: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.adopt', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'adopt', word: 'adopt', label: 'Take up the Google credentials another tool keeps on this machine',
  inputs: [{
    id: 'replace', label: 'If some are stored', help: 'Google credentials already in the secret store', kind: 'choice',
    choices: [{ value: 'no', label: 'Keep them and stop' }, { value: 'yes', label: 'Replace them', risk: 'cannot-be-undone', riskDone: 'The refresh token that was stored is replaced; it cannot be brought back.' }],
    required: { default: 'no', defaultMeans: 'keep them and stop' }, typed: { flag: '--replace', switchOn: 'yes' },
  }],
  sentence: 'The Google credentials in ~/.gmail-mcp on the daemon\'s machine are taken up into the secret store and kept until you change it; the files are read and left as they are.',
  done: '', touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'forget',
  effects: [...CREDENTIAL_EFFECTS], example: { replace: 'no' },
  async run(values, services) {
    const outcome = await googleOf(services).adopt(values.replace === 'yes');
    if (outcome.needsReplace) throw new CapabilityRefusal(outcome.text, 'Run it again with "Replace them" to take them up instead.', 'TARGET_EXISTS');
    if (!outcome.adopted) throw new CapabilityRefusal(outcome.text, `${CONNECT_KEY} on ${PLACE} connects an account instead.`, 'NOT_FOUND');
    return { text: outcome.text, data: { adopted: true } };
  },
};

// ── What mail is sent as, and the calendar's private address ────────────────

export const GOOGLE_ACCOUNT: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.account', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'account', word: 'account', label: 'Set the Gmail address mail is sent as',
  inputs: [{ id: 'address', label: 'Address', help: 'The Gmail address to connect and send as', kind: 'text', freeTextReason: 'your own address', required: true, typed: { position: 1 } }],
  sentence: 'Mail is signed in and sent as {address} until you change it.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection',
  riskDone: 'Mail is now signed in and sent as {address}; connecting asks Google for that account.', example: { address: 'you@gmail.com' },
  async run(values, services) {
    const address = (values.address ?? '').trim();
    if (!address.includes('@') || /\s/.test(address)) throw new CapabilityRefusal(`"${plainInboxText(address)}" is not an email address; nothing was set.`);
    googleOf(services).setAccount(address);
    return { text: `Gmail address set to ${address}. ${CONNECT_KEY} on ${PLACE} connects it.`, data: { address } };
  },
};

export const GOOGLE_CALENDAR_ADDRESS: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.calendar-address', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'calendar-address', word: 'calendar-address', label: 'Read the Google calendar by its private address',
  inputs: [{ id: 'url', label: 'Private address', help: 'The calendar\'s "Secret address in iCal format"; hidden as you type, kept only in the secret store', kind: 'secret', required: true, typed: { position: 1 } }],
  sentence: 'The private calendar address is read once, then kept in the secret store in place of the one there, and its events show in your calendar as the "Google calendar" feed, until you change it.',
  done: '', touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'forget',
  effects: [...CREDENTIAL_EFFECTS], example: {},
  async run(values, services) {
    const url = (values.url ?? '').trim();
    if (!/^(https|webcals?):\/\//i.test(url)) throw new CapabilityRefusal('The private calendar address starts with https://; nothing was stored.', 'Copy it from Google Calendar: Settings, your calendar, "Secret address in iCal format".');
    const google = googleOf(services);
    const read = await google.setCalendarAddress(url);
    if (!read.ok) throw new CapabilityRefusal(`Nothing was stored: the calendar address could not be read. ${read.detail}`, 'The address stored before, if any, is kept.');
    const feed = await subscribeGoogleFeed(services, url, google.privateHostApproved(url));
    return { text: `Stored the private calendar address in the daemon's secret store; it was read once: ${read.name ? `"${plainInboxText(read.name)}", ` : ''}${read.events} event${read.events === 1 ? '' : 's'}. ${feed}`, data: { events: read.events } };
  },
};

// ── Disconnecting ───────────────────────────────────────────────────────────

const ITEMS: readonly GoogleCredentialItem[] = ['refresh-token', 'client-secret', 'app-password', 'calendar-address'];

export const GOOGLE_FORGET: CapabilityDefinition<GoogleCapabilityServices> = {
  capability: { id: 'google.forget', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'forget', word: 'forget', label: 'Disconnect Google: remove its stored credentials', inputs: [],
  sentence: 'Removes the Google credentials stored for the daemon (the refresh token, the OAuth client secret, the app password and the private calendar address, those that are there), so mail and calendar stop until Google is connected again.',
  done: '', touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
  riskDone: 'Connecting again asks Google for a new consent.', example: {},
  async run(_values, services) {
    const outcome = await googleOf(services).forget(ITEMS);
    if (outcome.unreadable) throw new CapabilityRefusal(outcome.text, undefined, 'SECRET_STORE_UNREADABLE');
    // The private address also lives as the calendar's "Google calendar" feed: forgetting it leaves no live copy.
    let feed = '';
    if (services.calendarHere) {
      const gone = await services.calendarHere.local().feeds.unsubscribe(GOOGLE_CALENDAR_FEED);
      if (gone.removed) {
        services.calendarHere.changed();
        feed = gone.addressDeleted ? ` Removed the "${GOOGLE_CALENDAR_FEED}" feed and its stored address.` : ` Removed the "${GOOGLE_CALENDAR_FEED}" feed; its stored address could not be deleted.`;
      }
    }
    return { text: `${outcome.text}${feed}`, data: { removed: outcome.removed } };
  },
};

// ── A send the content check refused ────────────────────────────────────────

const SEND: InputDescription = {
  id: 'send', label: 'Send', help: 'The refused send, by its id in Waiting for you (Sends)', kind: 'text',
  freeTextReason: 'the id Waiting for you shows', required: { default: '', defaultMeans: 'the one send waiting, when only one is' }, typed: { position: 1 },
};

async function heldSend(services: GoogleCapabilityServices, raw: string): Promise<OwnerItem> {
  if (!services.ownerInbox) throw new CapabilityRefusal('This daemon keeps no owner inbox, so no refused send is held here.');
  const sends = (await listEveryOwnerItem(services.ownerInbox, { status: 'open', kinds: ['queued-action'] })).filter(isHeldSend);
  const wanted = raw.trim();
  if (sends.length === 0) throw new CapabilityRefusal('No send is waiting for your approval; nothing was sent or dropped.', 'A refused send waits five minutes.', 'NOT_FOUND');
  if (!wanted) {
    if (sends.length === 1) return sends[0]!;
    throw new CapabilityRefusal(`${sends.length} sends are waiting; nothing was done.`, 'Name one by its id in Waiting for you, under Sends.');
  }
  const found = sends.filter((send) => send.id === wanted || send.id.startsWith(wanted));
  if (found.length !== 1) throw new CapabilityRefusal(found.length === 0 ? `No waiting send is ${plainInboxText(wanted)}; nothing was done.` : `"${plainInboxText(wanted)}" names ${found.length} sends; give more of its id.`, undefined, 'NOT_FOUND');
  return found[0]!;
}

function heldAnswer(option: 'approve' | 'drop'): CapabilityDefinition<GoogleCapabilityServices> {
  const approve = option === 'approve';
  return {
    capability: { id: `google.${option}`, group: 'messages', home: 'daemon', repeat: 'safe' },
    actionId: option, word: option, label: approve ? 'Send a refused mail or invitation as shown' : 'Drop a refused mail or invitation',
    inputs: [SEND],
    sentence: approve
      ? 'The mail or invitation the content check refused goes out exactly as it is shown in Waiting for you.'
      : 'The mail or invitation the content check refused is dropped and never goes out.',
    done: '', touches: approve ? 'another-machine' : 'this-machine', lasts: approve ? 'not-a-change' : 'kept',
    risk: approve ? 'loosens-a-protection' : 'cannot-be-undone',
    ...(approve ? { riskDone: 'It goes out as shown; a sent mail cannot be called back.' } : {}),
    example: { send: '' },
    async run(values, services, caller) {
      const send = await heldSend(services, values.send ?? '');
      if (!caller.method) throw new CapabilityRefusal('This runs only in the daemon, through capabilities.run; nothing was done.');
      // The answer on the send's own item: the Agent that holds the send sends or drops it when it reads the answer.
      const outcome = await caller.method('inbox.answer', { itemId: send.id, option }) as { readonly applied?: boolean; readonly refusal?: { readonly message?: string } } | null;
      if (!outcome || outcome.applied !== true) throw new CapabilityRefusal(`Not ${approve ? 'sent' : 'dropped'}: ${outcome?.refusal?.message ?? 'the inbox did not record the answer'}.`);
      const title = plainInboxText(send.title.replace(/^Refused send: /, ''));
      return {
        text: approve ? `Approved "${title}": the Agent that holds it sends it exactly as shown.` : `Dropped "${title}"; nothing was sent.`,
        data: { item: send.id, answer: option },
      };
    },
  };
}

export const GOOGLE_APPROVE = heldAnswer('approve');
export const GOOGLE_DROP = heldAnswer('drop');

/** Every Google capability but `google.waiting` (Waiting for you, builtin/waiting.ts). */
export const GOOGLE_CAPABILITIES: readonly CapabilityDefinition<GoogleCapabilityServices>[] = [
  GOOGLE_STATUS, GOOGLE_CONNECT, GOOGLE_REAUTHORIZE, GOOGLE_STOP, GOOGLE_FORGET, GOOGLE_ADOPT, GOOGLE_SETUP, GOOGLE_RUNBOOK, GOOGLE_ENABLE_API,
  GOOGLE_CLIENT_FILE, GOOGLE_CLIENT, GOOGLE_ACCOUNT, GOOGLE_CALENDAR_ADDRESS, GOOGLE_APPROVE, GOOGLE_DROP,
];
