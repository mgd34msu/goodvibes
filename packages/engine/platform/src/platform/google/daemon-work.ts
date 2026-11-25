/**
 * daemon-work.ts, the Google connection as the daemon's work: connecting,
 * asking for consent again, handing over a client, checking, adopting the
 * credentials found on the daemon's machine and disconnecting all run here,
 * on the daemon's own settings and secret store (every Google setting is the
 * daemon's, every Google secret is filed in its tier), so Google is connected
 * the same way from the terminal app, the Agent, the web UI, a script or a
 * model's call.
 *
 * One connection at a time. A run's progress (each step as it starts and
 * ends, what it installs, the one thing it needs of the person) is kept here
 * and announced as the `google` list changing (runtime/list-changes.ts), so a
 * screen showing the connection reads it again on the event: no poll, no
 * timer. The consent link is the run's one ask; it is handed back to the
 * person who asked (the capability's reveal) and, for anyone else's run, put
 * in the owner inbox, and it is never written to a log or a list.
 *
 * Imports the node ports (the loopback listener, the process runner, the file
 * reader), so it is not re-exported from the module index; the daemon's
 * capability services build it (capabilities/daemon-services.ts).
 */
import { randomUUID } from 'node:crypto';
import { BrowserEngine, BrowserSessionManager, browserProfileRoot, browserScreenshotRoot } from '../browser/index.js';
import { createUntrustedContentPort } from '../security/untrusted-content.js';
import { revealOrNull, type Secret } from '../security/secret.js';
import { postToPublicWebhook } from '../utils/url-safety.js';
import { PRIVATE_DELIVERY_HOSTS_SETTING, parseApprovedHosts } from '../runtime/network/destination.js';
import { parseIcs } from '../calendar/ics-parser.js';
import { googleGrantIsCalendarOnly } from '../calendar/oauth-token-store.js';
import { secretReferenceFor } from '../config/plaintext-credential-sweep.js';
import { EmailService } from '../email/email-service.js';
import { withSurfaceEmailConfig } from '../email/surface-config.js';
import { describeSenderClaimNeutrally } from '../email/sender-claim.js';
import { nodeEmailTransport } from '../email/node.js';
import { createGoogleBrowserPort } from './browser-port.js';
import { carryAgentGoogleProfile, GOOGLE_BROWSER_PROFILE } from './browser-profile-carry.js';
import { daemonGoogleConnectionOwner } from './daemon-connection.js';
import { describeGoogleConnectionPlan, planGoogleConnection, type GoogleConnectionPlan } from './discovery.js';
import { describeGoogleConnectionProof, proveGoogleConnection, serviceWords, type GoogleApiOff } from './connection-proof.js';
import { detectGoogleSetupState, describeGoogleSetupState, type GoogleSetupState } from './setup-state.js';
import { buildGoogleSetupRunners, registerGoogleClientFromIntake } from './setup-actions.js';
import { adoptExistingGoogleCredentials } from './setup-actions-adoption.js';
import { describeGrantedScopes } from './credential-adoption.js';
import { removeGoogleCredentials, type GoogleCredentialItem } from './credential-removal.js';
import { runGoogleSetupFlow } from './setup-flow.js';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS, REQUIRED_SERVICES, stepsForPath } from './setup-plan.js';
import { checkAuthenticated, detectGcloud, enableServices } from './gcloud.js';
import { createProcessCommandPort, nodeGoogleFilePort, startLoopbackListener } from './node.js';
import type { GoogleSetupActionDeps, GoogleClientIntakeChoice } from './setup-action-deps.js';
import type { GoogleBrowserPort, GoogleConfigPort, GoogleProgressPort, GoogleSecretPort, GoogleSetupPath, GoogleSetupReport, GoogleStepId, GoogleStepOutcome } from './types.js';

/** What a run is doing, in the words a screen shows. */
export type GoogleWorkKind = 'connect' | 'reauthorize' | 'client' | 'client-file' | 'setup';

/** One step of a run as a screen shows it. */
export interface GoogleWorkStep {
  readonly id: string;
  readonly title: string;
  /** `stopped`: the person stopped the run while this step was under way. */
  readonly state: 'running' | 'stopped' | GoogleStepOutcome;
  readonly detail?: string | undefined;
  readonly problem?: string | undefined;
  readonly fix?: string | undefined;
}

/** The run under way, or the last one; nothing in it is a credential or the consent link. */
export interface GoogleWorkState {
  readonly id: string;
  readonly kind: GoogleWorkKind;
  /** What was asked, as a person says it: "Connecting Gmail and Calendar". */
  readonly label: string;
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  /** running; waiting for the consent link to be approved; waiting on something else the person does; done; stopped. */
  readonly state: 'running' | 'consent' | 'needs-you' | 'done' | 'stopped';
  readonly steps: readonly GoogleWorkStep[];
  /** What it said as it went (the plan, what it installs), oldest first. */
  readonly notes: readonly string[];
  /** The one thing the person does now, when it waits on him. */
  readonly needs?: string | undefined;
  /** How it ended. */
  readonly summary?: string | undefined;
}

/** What `start` answers once the run has its link, needs the person, or ended: whichever comes first. */
export interface GoogleWorkStarted {
  readonly work: GoogleWorkState;
  /** The consent link the person opens; only for the person who asked. */
  readonly consentUrl?: string | undefined;
  /** The run ended before it needed anyone: its words. */
  readonly ended?: { readonly ok: boolean; readonly text: string } | undefined;
}

/** A run is already under way: nothing new was started. */
export interface GoogleWorkBusy {
  readonly busy: GoogleWorkState;
}

/** The daemon's own stores and what it announces with. */
export interface DaemonGoogleWorkSources {
  readonly config: {
    get(key: string): unknown;
    setDynamic(key: string, value: unknown): void;
  };
  readonly secrets: {
    get(key: string): Promise<Secret | null>;
    /** Throws when the store this machine holds cannot be read. */
    getStored?(key: string): Promise<Secret | null>;
    set(key: string, value: string): Promise<void>;
    delete?(key: string): Promise<void>;
  };
  readonly homeDirectory: string;
  /** The `google` list changed (a step, the link, the connection). */
  readonly changed: () => void;
  /** Puts the consent link in the owner inbox for a run nobody is sitting at; returns its withdrawal. */
  readonly postConsent?: ((link: string) => (() => void)) | undefined;
}

/** The daemon's own segment under `~/.goodvibes/` (the browser profile Google's pages are read in), as the daemon's browser names it. */
const DAEMON_SURFACE_ROOT = 'goodvibes';
const FEED_MAX_BYTES = 5 * 1024 * 1024;
const FEED_MAX_REDIRECTS = 5;
const NOTES_KEPT = 12;

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}


/** The daemon's Google work: one per secret store, made on first use. */
const WORKS = new WeakMap<object, DaemonGoogleWork>();

export function daemonGoogleWork(sources: DaemonGoogleWorkSources): DaemonGoogleWork {
  let work = WORKS.get(sources.secrets);
  if (!work) {
    work = new DaemonGoogleWork(sources);
    WORKS.set(sources.secrets, work);
  }
  return work;
}

export class DaemonGoogleWork {
  readonly #sources: DaemonGoogleWorkSources;
  #current: GoogleWorkState | null = null;
  /** The run under way: what stops it and when it has ended. */
  #run: { readonly id: string; readonly controller: AbortController; readonly ended: Promise<void> } | null = null;
  #consentUrl: string | null = null;
  #browser: Promise<GoogleBrowserPort> | null = null;

  constructor(sources: DaemonGoogleWorkSources) {
    this.#sources = sources;
  }

  /** The run under way, or the last one. */
  get current(): GoogleWorkState | null { return this.#current; }

  /** The consent link the run under way waits on, for the person who asks to see it again. */
  get openConsentUrl(): string | null { return this.#current?.state === 'consent' ? this.#consentUrl : null; }

  /** The daemon's settings as the connector reads and writes them (every Google setting is the daemon's). */
  config(): GoogleConfigPort {
    const config = this.#sources.config;
    return {
      get: (key) => { try { return config.get(key); } catch { return undefined; } },
      set: (key, value, ownership) => {
        ownership?.assertCurrent();
        ownership?.consumeObservation();
        config.setDynamic(key, value);
        ownership?.committed();
      },
    };
  }

  /** The daemon's secret store: a store that cannot be read throws, so it is said, never taken for "not connected". */
  secrets(): GoogleSecretPort {
    const secrets = this.#sources.secrets;
    return {
      get: async (key) => {
        const value = revealOrNull(await secrets.get(key), 'dispatch');
        if (value === null) await secrets.getStored?.(key);
        return value;
      },
      set: async (key, value, ownership) => {
        ownership?.assertCurrent();
        ownership?.consumeObservation();
        await secrets.set(key, value);
        ownership?.committed();
      },
      ...(secrets.delete ? { delete: (key: string) => secrets.delete!(key) } : {}),
    };
  }

  /** What is stored, read without reaching Google. */
  async stored(): Promise<GoogleSetupState> {
    return detectGoogleSetupState({ config: this.config(), secrets: this.secrets() });
  }

  /** The stored state in words (no secret), and the account the refresh token was granted by, when recorded. */
  describeStored(state: GoogleSetupState): readonly string[] {
    return describeGoogleSetupState(state);
  }

  /** The account the stored grant belongs to (its label only), when recorded; null when not, or unreadable. */
  async account(): Promise<string | null> {
    try {
      const raw = await this.secrets().get(GOOGLE_SECRET_KEYS.oauthAccount);
      if (!raw) return this.#provenAccount;
      const parsed = JSON.parse(raw) as { readonly label?: unknown; readonly account?: unknown };
      // A calendar sign-in's record keeps the account as an object ({ account: { label } }, calendar/oauth-token-store.ts).
      const nested = parsed.account && typeof parsed.account === 'object' ? asText((parsed.account as { readonly label?: unknown }).label) : null;
      return asText(parsed.label) ?? asText(parsed.account) ?? nested ?? this.#provenAccount;
    } catch {
      return this.#provenAccount;
    }
  }

  /** Whether the stored grant is a calendar sign-in's, for the calendar alone (calendar oauth-token-store.ts). */
  async calendarOnly(): Promise<boolean> {
    try {
      return await googleGrantIsCalendarOnly((key) => this.secrets().get(key));
    } catch {
      return false;
    }
  }

  /** The address Google named the last time this daemon read the mailbox with the stored grant (none is recorded). */
  #provenAccount: string | null = null;

  /**
   * Reads mail and calendar with the stored grant: the check, said with what to do for what failed. It waits on no
   * one: a refusal for a missing scope or a dead grant ends it at once, naming the part that needs consent again
   * ("ask for consent again" is the control that follows), instead of opening the repair's consent and waiting on it.
   */
  async prove(): Promise<{ readonly ok: boolean; readonly lines: readonly string[]; readonly account: string | null; readonly apiOff: GoogleApiOff | null } | null> {
    const connection = await this.#owner().connection();
    if (connection === null) return null;
    const proof = await proveGoogleConnection(connection.client.withoutRepair());
    if (proof.account) this.#provenAccount = proof.account;
    // An API Google said is switched off is kept for the Google tab ("enable it"); a check where both answer clears it.
    const services: string[] = [];
    let project: string | null = null;
    for (const [part, unnamed] of [[proof.mail, 'gmail.googleapis.com'], [proof.calendar, 'calendar-json.googleapis.com']] as const) {
      if (!part.apiOff) continue;
      services.push(part.apiOff.service ?? unnamed);
      project ??= part.apiOff.project;
    }
    const before = JSON.stringify(this.#apiOff);
    this.#apiOff = services.length === 0 ? null : { services: [...new Set(services)], project };
    if (JSON.stringify(this.#apiOff) !== before) this.#sources.changed();
    return { ok: proof.ok, lines: describeGoogleConnectionProof(proof), account: proof.account, apiOff: this.#apiOff };
  }

  /** The Google APIs the last check found switched off (Gmail, Calendar), and the project Google named; null when none. */
  get apiOff(): GoogleApiOff | null { return this.#apiOff; }

  #apiOff: GoogleApiOff | null = null;

  /**
   * Turns on the Google APIs this product needs (the ones a check found off, else Gmail and Calendar) on the Cloud
   * project that holds its OAuth client, with the gcloud signed in on the daemon's machine. The person asked for it
   * (the "enable it" control, or connecting): nothing is asked. Says what was turned on, or why nothing was.
   */
  async enableApis(signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly text: string }> {
    const services = this.#apiOff?.services.length ? [...this.#apiOff.services] : [...REQUIRED_SERVICES];
    const project = this.#apiOff?.project ?? asText(this.config().get(GOOGLE_CONFIG_KEYS.oauthProjectId));
    const what = services.map(serviceWords).join(' and ');
    if (project === null) {
      return { ok: false, text: `Google did not say which Cloud project, and none is stored, so ${what} was not turned on. Turn it on in the Google Cloud console (APIs and services, Library) for the project that holds this product's OAuth client.` };
    }
    const commands = createProcessCommandPort(signal);
    const gcloud = await detectGcloud(commands, this.#sources.homeDirectory);
    if (!gcloud.ok) {
      return { ok: false, text: `gcloud is not installed on the daemon's machine, so ${what} was not turned on for project ${project}. Install the Google Cloud CLI and sign it in, then "enable it" again; or turn it on in the Google Cloud console.` };
    }
    const signedIn = await checkAuthenticated(commands, gcloud.path);
    if (!signedIn.ok) {
      return { ok: false, text: `gcloud is signed in to no account on the daemon's machine, so ${what} was not turned on for project ${project}. Sign gcloud in (a browser sign-in only you can do), then "enable it" again.` };
    }
    const enabled = await enableServices(commands, gcloud.path, project, services);
    if (!enabled.ok) return { ok: false, text: `Turning on ${what} for project ${project} failed: ${enabled.problem} ${enabled.fix}` };
    this.#apiOff = null;
    this.#sources.changed();
    return {
      ok: true,
      text: enabled.enabled.length === 0
        ? `${what} ${services.length === 1 ? 'was' : 'were'} already on for project ${project}; nothing was changed.`
        : `Turned on ${enabled.enabled.map(serviceWords).join(' and ')} for project ${project} as ${signedIn.account}.`,
    };
  }

  #owner() {
    const sources = this.#sources;
    return daemonGoogleConnectionOwner({
      configManager: sources.config as { get(key: never): unknown },
      secretsManager: sources.secrets,
      homeDirectory: sources.homeDirectory,
      files: nodeGoogleFilePort,
    });
  }

  /**
   * A browser on the daemon's machine, built only when a step needs one (the console, the app password page). The
   * first time, the Agent's Google profile (where the person signed in through a 3.5.0 Agent) is carried into the
   * daemon's once (browser-profile-carry.ts); `note` says what came of it as a note of the run.
   */
  #browserPort(note?: (message: string) => void): () => Promise<GoogleBrowserPort> {
    return async () => {
      this.#browser ??= (async () => {
        const home = this.#sources.homeDirectory;
        const carry = carryAgentGoogleProfile(home, DAEMON_SURFACE_ROOT);
        if (carry.note) note?.(carry.note);
        const engine = new BrowserEngine(
          new BrowserSessionManager({
            profileRoot: browserProfileRoot(home, DAEMON_SURFACE_ROOT), homeDirectory: home, surfaceRoot: DAEMON_SURFACE_ROOT,
            host: { missingScriptFix: 'Reinstall the daemon so its files are complete, then connect Google again.' },
          }),
          {
            screenshotDirectory: browserScreenshotRoot(home, DAEMON_SURFACE_ROOT),
            untrusted: createUntrustedContentPort({ surface: 'web-page', toolName: 'browser' }),
            destinationConfig: { get: (key: string) => this.config().get(key) },
          },
        );
        // Google stops automated browsers at its sign-in page: the person signs in once in this window, which is kept.
        return createGoogleBrowserPort(engine, { launch: { profileName: GOOGLE_BROWSER_PROFILE, headless: false } });
      })();
      return this.#browser;
    };
  }

  /** The `gmail-verify` step: signs in over IMAP and SMTP with what setup stored; nothing is read or sent. */
  #verifyMail(): GoogleSetupActionDeps['verifyMail'] {
    return async () => {
      const config = this.config();
      const service = new EmailService(withSurfaceEmailConfig({
        getConfig: (key: string) => config.get(key),
        secretsManager: { get: (key: string) => this.#sources.secrets.get(key) },
        transport: nodeEmailTransport,
        describeSenderClaim: describeSenderClaimNeutrally,
      }));
      const result = await service.testConnection();
      const who = asText(config.get(GOOGLE_CONFIG_KEYS.emailUsername));
      if (result.ok) {
        return {
          ok: true,
          detail: result.smtp === 'verified'
            ? `Signed in to Gmail${who ? ` as ${who}` : ''} over IMAP and SMTP; nothing was read or sent.`
            : `Signed in to Gmail${who ? ` as ${who}` : ''} over IMAP; no SMTP server is set, so sending was not checked.`,
        };
      }
      const protocol = result.stage === 'smtp' ? 'SMTP' as const : result.stage === 'imap' ? 'IMAP' as const : undefined;
      return {
        ok: false,
        detail: `${protocol ?? 'The mail settings'}: ${result.error ?? 'no reason was given'}`,
        ...(protocol === undefined ? {} : { stage: protocol }),
        ...(result.failure === undefined ? {} : { failure: result.failure }),
        ...(result.server === undefined ? {} : { server: result.server }),
      };
    };
  }

  /** Whether an address's host is one the owner approved on his own network (`network.privateDeliveryHosts`). */
  privateHostApproved(raw: string): boolean {
    try {
      const host = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://')).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return parseApprovedHosts(this.config().get(PRIVATE_DELIVERY_HOSTS_SETTING)).some((entry) => entry.toLowerCase() === host);
    } catch {
      return false;
    }
  }

  /** Reads a private calendar address once (https only, a public host or one the owner approved, a size cap): its events counted. */
  async readCalendarAddress(raw: string): Promise<{ readonly ok: true; readonly events: number; readonly name?: string | undefined } | { readonly ok: false; readonly detail: string }> {
    const approved = parseApprovedHosts(this.config().get(PRIVATE_DELIVERY_HOSTS_SETTING));
    let target: string;
    try {
      const parsed = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
      if (parsed.protocol !== 'https:') return { ok: false, detail: 'The private calendar address starts with https://.' };
      target = parsed.toString();
    } catch {
      return { ok: false, detail: 'That is not an address.' };
    }
    try {
      let response: Response | undefined;
      for (let hop = 0; hop <= FEED_MAX_REDIRECTS; hop += 1) {
        response = await postToPublicWebhook(target, { method: 'GET', headers: { Accept: 'text/calendar, text/plain, */*' }, redirect: 'manual' },
          { approvedPrivateHosts: approved });
        const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
        if (location === null) break;
        await response.body?.cancel();
        const next = new URL(location, target);
        if (next.protocol !== 'https:') return { ok: false, detail: 'The calendar address sent the request on to an address that is not https.' };
        target = next.toString();
        response = undefined;
      }
      if (!response) return { ok: false, detail: `The calendar address redirected more than ${FEED_MAX_REDIRECTS} times.` };
      if (!response.ok) return { ok: false, detail: `Google answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: check that the whole "Secret address in iCal format" was copied.` };
      const body = await response.text();
      if (body.length > FEED_MAX_BYTES) return { ok: false, detail: 'The calendar is larger than 5 MiB.' };
      if (!/BEGIN:VCALENDAR/i.test(body)) return { ok: false, detail: 'The address answered with something that is not a calendar.' };
      const parsed = parseIcs(body, { source: 'google-ics' });
      return { ok: true, events: parsed.events.length, ...(parsed.calendarName ? { name: parsed.calendarName } : {}) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The `calendar-verify` step: reads the stored private address once. */
  #verifyCalendar(): GoogleSetupActionDeps['verifyCalendar'] {
    return async () => {
      const url = await this.secrets().get(GOOGLE_SECRET_KEYS.calendarIcsUrl);
      if (url === null || url.trim().length === 0) return { ok: false, detail: 'No private calendar address is stored.' };
      const read = await this.readCalendarAddress(url);
      return read.ok
        ? { ok: true, detail: `Read ${read.name ? `the calendar "${read.name}"` : 'the calendar feed'}: ${read.events} event${read.events === 1 ? '' : 's'}.` }
        : { ok: false, detail: read.detail };
    };
  }

  /** Everything a run's steps need, from the daemon's own stores and machine. */
  deps(extras: Partial<GoogleSetupActionDeps> = {}): GoogleSetupActionDeps {
    return {
      config: this.config(),
      secrets: this.secrets(),
      browser: this.#browserPort(extras.installProgress),
      // A run's stop ends the command under way and starts no other.
      commands: createProcessCommandPort(extras.signal),
      fetchPort: { fetch: (url, init) => fetch(url, init) },
      files: nodeGoogleFilePort,
      loopback: startLoopbackListener,
      homeDirectory: this.#sources.homeDirectory,
      verifyMail: this.#verifyMail(),
      verifyCalendar: this.#verifyCalendar(),
      proveConnection: async () => {
        let proved = await this.prove();
        // Connecting is the person's request: an API Google says is off is turned on here and the proof is read again.
        if (proved !== null && !proved.ok && proved.apiOff !== null) {
          const enabled = await this.enableApis(extras.signal);
          extras.installProgress?.(enabled.text);
          if (enabled.ok) proved = await this.prove();
        }
        if (proved === null) {
          return {
            ok: false, detail: 'The credential was stored but does not make a working connection.',
            problem: 'The stored client id, client secret and refresh token did not combine into a usable credential.',
            fix: 'Check it on the Google tab of Mail, calendar and channels to see which half is missing.',
          };
        }
        return proved.ok ? { ok: true, detail: proved.lines[0] ?? 'Connected.' } : { ok: false, detail: proved.lines.join(' '), problem: proved.lines.slice(1).join(' ') };
      },
      ...extras,
    };
  }

  /** Works out how to connect, changing nothing. */
  async plan(): Promise<GoogleConnectionPlan> {
    return planGoogleConnection({ config: this.config(), secrets: this.secrets(), commands: createProcessCommandPort(), homeDirectory: this.#sources.homeDirectory });
  }

  /**
   * Starts a run unless one is under way, and answers when it has its consent link, needs the person for something
   * else, or ended. The run goes on in the daemon; each change is announced.
   */
  start(kind: GoogleWorkKind, label: string, body: (run: GoogleWorkRun) => Promise<{ readonly ok: boolean; readonly text: string }>,
    options: { readonly personAsked: boolean }): Promise<GoogleWorkStarted | GoogleWorkBusy> {
    const running = this.#current;
    if (running && (running.state === 'running' || running.state === 'consent')) return Promise.resolve({ busy: running });
    let state: GoogleWorkState = { id: randomUUID(), kind, label, startedAt: Date.now(), state: 'running', steps: [], notes: [] };
    this.#consentUrl = null;
    // The person's stop (google.stop): the step under way ends on it, no later step starts, nothing is handed to him.
    const controller = new AbortController();
    const stopped = (): boolean => controller.signal.aborted;
    let endRun: () => void = () => undefined;
    this.#run = { id: state.id, controller, ended: new Promise<void>((resolve) => { endRun = resolve; }) };
    let answered = false;
    let answer: (value: GoogleWorkStarted) => void = () => undefined;
    const first = new Promise<GoogleWorkStarted>((resolve) => { answer = resolve; });
    let withdraw: (() => void) | null = null;
    const set = (next: GoogleWorkState): void => {
      state = next;
      // A run that ended is no longer the one shown once a newer one started.
      if (this.#current?.id === next.id) this.#current = next;
      this.#sources.changed();
    };
    this.#current = state;
    const reply = (value: Omit<GoogleWorkStarted, 'work'>): void => {
      if (answered) return;
      answered = true;
      answer({ work: state, ...value });
    };
    const run: GoogleWorkRun = {
      signal: controller.signal,
      progress: {
        stepStarted: (spec) => {
          set({ ...state, steps: [...state.steps.filter((step) => step.id !== spec.id), { id: spec.id, title: spec.title, state: 'running' }] });
        },
        stepFinished: (spec, result) => {
          // A step the stop ended before it finished is said as stopped, never as something the person must do.
          const cut = stopped() && result.outcome !== 'done' && result.outcome !== 'already-done';
          set({
            ...state,
            steps: state.steps.map((step) => step.id !== spec.id ? step : cut
              ? { id: spec.id, title: spec.title, state: 'stopped', detail: 'Stopped before it finished.' }
              : {
                id: spec.id, title: spec.title, state: result.outcome, detail: result.detail,
                ...(result.problem ? { problem: result.problem } : {}), ...(result.fix ? { fix: result.fix } : {}),
              }),
            ...(state.state === 'consent' ? { state: 'running' as const, needs: undefined } : {}),
          });
          if (withdraw) { withdraw(); withdraw = null; }
        },
        humanActionNeeded: (_spec, instruction) => {
          if (stopped()) return;
          set({ ...state, state: 'needs-you', needs: instruction });
          reply({});
        },
        note: (message) => {
          set({ ...state, notes: [...state.notes, ...message.split('\n').map((line) => line.trim()).filter(Boolean)].slice(-NOTES_KEPT) });
        },
      },
      announceConsentUrl: (url) => {
        if (stopped()) return;
        this.#consentUrl = url;
        set({ ...state, state: 'consent', needs: 'Open the consent link and approve it: it asks for mail and calendar together.' });
        if (!options.personAsked && this.#sources.postConsent) withdraw = this.#sources.postConsent(url);
        reply({ consentUrl: url });
      },
    };
    void (async () => {
      let ended: { ok: boolean; text: string };
      try {
        ended = await body(run);
      } catch (error) {
        ended = { ok: false, text: `Connecting Google stopped: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (withdraw) { withdraw(); withdraw = null; }
      this.#consentUrl = null;
      const waiting = state.state === 'needs-you' && !stopped();
      set({
        ...state, finishedAt: Date.now(), summary: ended.text,
        state: ended.ok && !stopped() ? 'done' : waiting ? 'needs-you' : 'stopped',
        ...(ended.ok || stopped() ? { needs: undefined } : {}),
      });
      reply({ ended });
      if (this.#run?.id === state.id) this.#run = null;
      endRun();
    })();
    this.#sources.changed();
    return first;
  }

  /**
   * Stops the run under way (the person's "stop connecting"): the step running ends (a waiting consent closes its
   * listener, a command or a download is ended), no later step starts, and the run says what was and was not set up.
   * Answers once the run has ended. Nothing set up before the stop is undone.
   */
  async stop(): Promise<{ readonly stopped: false; readonly text: string } | { readonly stopped: true; readonly text: string; readonly work: GoogleWorkState | null }> {
    const run = this.#run;
    const current = this.#current;
    if (run === null || current === null || current.id !== run.id || (current.state !== 'running' && current.state !== 'consent')) {
      return { stopped: false, text: 'Nothing is connecting Google now; nothing was stopped.' };
    }
    run.controller.abort();
    await run.ended;
    const work = this.#current?.id === run.id ? this.#current : null;
    return { stopped: true, text: work?.summary ?? 'Stopped connecting Google.', work };
  }

  /** Connect: the shortest route from what is already true, installing what it needs as it goes, then the proof. */
  connect(options: { readonly personAsked: boolean }): Promise<GoogleWorkStarted | GoogleWorkBusy> {
    return this.start('connect', 'Connecting Gmail and Calendar', async (run) => {
      const plan = await this.plan();
      run.progress.note(describeGoogleConnectionPlan(plan).join('\n'));
      if (plan.route === 'stored-credential') {
        const proved = await this.prove();
        if (run.signal.aborted) return { ok: false, text: 'Stopped connecting Google; the stored credential was kept as it was.' };
        if (proved === null) return { ok: false, text: 'The stored credential does not make a working connection: ask Google for consent again.' };
        return { ok: proved.ok, text: proved.lines.join('\n') };
      }
      const path: GoogleSetupPath = plan.setupPath ?? 'oauth';
      const report = await runGoogleSetupFlow(path, {
        progress: run.progress,
        signal: run.signal,
        runners: buildGoogleSetupRunners(path, this.deps({
          signal: run.signal,
          announceConsentUrl: run.announceConsentUrl,
          // What it installs is said as it goes: the request to connect is the consent to install it.
          installProgress: (message) => run.progress.note(message),
          ...(plan.intendedAccount === null ? {} : { loginHint: plan.intendedAccount }),
        })),
      });
      return run.signal.aborted ? stoppedEnd(path, report) : endOf(report);
    }, options);
  }

  /** A run of one chosen route. */
  setup(path: GoogleSetupPath, options: { readonly personAsked: boolean }): Promise<GoogleWorkStarted | GoogleWorkBusy> {
    return this.start('setup', path === 'app-password' ? 'Connecting with an app password' : path === 'oauth' ? 'Connecting with a new OAuth client' : 'Connecting with the OAuth client you have', async (run) => {
      const report = await runGoogleSetupFlow(path, {
        progress: run.progress,
        signal: run.signal,
        runners: buildGoogleSetupRunners(path, this.deps({ signal: run.signal, announceConsentUrl: run.announceConsentUrl, installProgress: (message) => run.progress.note(message) })),
      });
      return run.signal.aborted ? stoppedEnd(path, report) : endOf(report);
    }, options);
  }

  /** A client the owner handed over (its id and secret, or its file): stored, then consent and the proof. */
  client(intake: Extract<GoogleClientIntakeChoice, { kind: 'manual-entry' | 'client-json-file' }>, options: { readonly personAsked: boolean }): Promise<GoogleWorkStarted | GoogleWorkBusy> {
    return this.start(intake.kind === 'manual-entry' ? 'client' : 'client-file', 'Connecting with your OAuth client', async (run) => {
      const base = this.deps({ signal: run.signal, announceConsentUrl: run.announceConsentUrl });
      const registered = await registerGoogleClientFromIntake(base, intake);
      if (!registered.ok) return { ok: false, text: `Nothing was stored: ${registered.problem} ${registered.fix}` };
      run.progress.note(`Stored the OAuth client ${registered.clientIdTail}; its secret is in the daemon's secret store and is not shown again.${registered.consentRequired === true
        ? ' It replaces a different client, so the refresh token of the old one was removed and a new consent is needed.' : ''}`);
      const account = asText(base.config.get(GOOGLE_CONFIG_KEYS.emailUsername));
      const report = await runGoogleSetupFlow('existing-client', {
        progress: run.progress,
        signal: run.signal,
        runners: buildGoogleSetupRunners('existing-client', { ...base, ...(account ? { loginHint: account } : {}) }),
      });
      return run.signal.aborted ? stoppedEnd('existing-client', report, `the OAuth client ${registered.clientIdTail} (stored)`) : endOf(report);
    }, options);
  }

  /** A fresh consent for mail and calendar together; the stored grant stays in use until Google returns a new one. */
  async reauthorize(options: { readonly personAsked: boolean }): Promise<GoogleWorkStarted | GoogleWorkBusy | { readonly refused: string }> {
    const state = await this.stored();
    if (state.secretStoreUnreadable) return { refused: 'The secret store could not be read, so it is not known whether an OAuth client is stored; nothing was asked of Google.' };
    if (state.oauthClientId === null || !state.hasOAuthClientSecret) return { refused: 'There is no OAuth client to ask consent for yet: connect Google first.' };
    return this.start('reauthorize', 'Asking Google for consent again', async (run) => {
      const plan = await this.plan();
      const base = this.deps({ signal: run.signal, announceConsentUrl: run.announceConsentUrl, ...(plan.intendedAccount === null ? {} : { loginHint: plan.intendedAccount }) });
      // The consent step skips when it sees a stored refresh token: it is shown none until it stores the new one.
      let replaced = false;
      const secrets: GoogleSecretPort = {
        ...base.secrets,
        get: async (key) => (key === GOOGLE_SECRET_KEYS.oauthRefreshToken && !replaced ? null : base.secrets.get(key)),
        set: async (key, value, ownership) => {
          await base.secrets.set(key, value, ownership);
          if (key === GOOGLE_SECRET_KEYS.oauthRefreshToken) replaced = true;
        },
      };
      const report = await runGoogleSetupFlow('existing-client', { progress: run.progress, signal: run.signal, runners: buildGoogleSetupRunners('existing-client', { ...base, secrets }) });
      if (run.signal.aborted) return { ok: false, text: `Stopped asking Google for consent again; ${replaced ? 'the new grant Google returned is kept.' : 'the stored grant was kept and nothing was disconnected.'}` };
      const ended = endOf(report);
      return replaced ? ended : { ok: ended.ok, text: `${ended.text}\nGoogle returned no new refresh token, so the stored one was kept and nothing was disconnected.` };
    }, options);
  }

  /** Takes up the credentials another tool keeps on the daemon's machine (`~/.gmail-mcp`); the files are read and left as they are. */
  async adopt(replace: boolean): Promise<{ readonly adopted: boolean; readonly text: string; readonly needsReplace?: true | undefined }> {
    const outcome = await adoptExistingGoogleCredentials({
      files: nodeGoogleFilePort, config: this.config(), secrets: this.secrets(), homeDirectory: this.#sources.homeDirectory, confirmReplace: replace,
    });
    this.#sources.changed();
    if (outcome.needsConfirmation === true) return { adopted: false, needsReplace: true, text: [outcome.detail, outcome.prompt ?? ''].filter(Boolean).join(' ') };
    if (!outcome.adopted) return { adopted: false, text: outcome.detail };
    return {
      adopted: true,
      // What the grant allows, in words (never the scope addresses).
      text: [outcome.detail, outcome.scopes.length > 0 ? `Granted: ${describeGrantedScopes(outcome.scopes)}.` : 'The credential says nothing of what was granted.'].join(' '),
    };
  }

  /** Removes the stored Google credentials the request names (the account record goes with the refresh token). */
  async forget(items: readonly GoogleCredentialItem[]): Promise<{ readonly removed: readonly string[]; readonly text: string; readonly unreadable?: true | undefined }> {
    const result = await removeGoogleCredentials({ secrets: this.secrets(), config: this.config() }, { items, confirmed: true });
    if ('refused' in result) return { removed: [], text: result.prompt, unreadable: true };
    if (!result.confirmed) return { removed: [], text: result.prompt };
    // A run that has ended spoke of the connection now removed ("Connected and proven ..."): it is not shown after it.
    if (result.removed.length > 0 && this.#current && this.#current.state !== 'running' && this.#current.state !== 'consent') this.#current = null;
    if (result.removed.length > 0 && items.includes('refresh-token')) {
      this.#provenAccount = null;
      try { await this.#sources.secrets.delete?.(GOOGLE_SECRET_KEYS.oauthAccount); } catch { /* the label of a grant that is gone names nothing */ }
    }
    this.#sources.changed();
    return { removed: result.removed, text: result.detail };
  }

  /** The address mail is signed in and sent as. */
  setAccount(address: string): void {
    const config = this.config();
    config.set(GOOGLE_CONFIG_KEYS.emailUsername, address);
    config.set(GOOGLE_CONFIG_KEYS.emailFromAddress, address);
    this.#sources.changed();
  }

  /** The private calendar address, read once first: an address that cannot be read changes nothing. */
  async setCalendarAddress(url: string): Promise<{ readonly ok: true; readonly events: number; readonly name?: string | undefined } | { readonly ok: false; readonly detail: string }> {
    const read = await this.readCalendarAddress(url);
    if (!read.ok) return read;
    await this.secrets().set(GOOGLE_SECRET_KEYS.calendarIcsUrl, url.trim());
    this.config().set(GOOGLE_CONFIG_KEYS.calendarIcsUrl, secretReferenceFor(GOOGLE_SECRET_KEYS.calendarIcsUrl));
    this.#sources.changed();
    return read;
  }
}

/** What a run's body gets: where its progress goes and where its consent link goes. */
export interface GoogleWorkRun {
  readonly progress: GoogleProgressPort;
  readonly announceConsentUrl: (url: string) => void;
  /** Aborted when the person stops the run (`stop`). */
  readonly signal: AbortSignal;
}

/**
 * A stopped run's end in words: what was set up (kept) and what was not, by the steps' own titles. `alsoSetUp` names
 * what the run stored before its steps (a client handed over).
 */
function stoppedEnd(path: GoogleSetupPath, report: GoogleSetupReport, alsoSetUp?: string): { readonly ok: false; readonly text: string } {
  const titles = new Map<GoogleStepId, string>(stepsForPath(path).map((spec) => [spec.id, spec.title]));
  const title = (id: GoogleStepId): string => titles.get(id) ?? id;
  const setUp = [...(alsoSetUp ? [alsoSetUp] : []),
    ...report.steps.filter((step) => step.outcome === 'done' || step.outcome === 'already-done').map((step) => title(step.id))];
  const notSetUp = report.steps.filter((step) => step.outcome !== 'done' && step.outcome !== 'already-done').map((step) => title(step.id));
  return {
    ok: false,
    text: [
      'Stopped connecting Google; nothing more was set up.',
      setUp.length > 0 ? `Set up and kept: ${setUp.join(', ')}.` : 'Nothing was set up.',
      ...(notSetUp.length > 0 ? [`Not set up: ${notSetUp.join(', ')}.`] : []),
      ...(setUp.length > 0 ? ['Connecting again picks up from there.'] : []),
    ].join('\n'),
  };
}

/** A run's end in words: its summary, then each step that did not go through, with what to do. */
function endOf(report: GoogleSetupReport): { readonly ok: boolean; readonly text: string } {
  const lines = [report.summary];
  for (const step of report.steps) {
    if (step.outcome !== 'failed' && step.outcome !== 'needs-human') continue;
    if (step.problem) lines.push(step.problem);
    if (step.fix) lines.push(`Do this: ${step.fix}`);
  }
  for (const warning of new Set(report.warnings)) lines.push(`Note: ${warning}`);
  return { ok: report.ok, text: lines.join('\n') };
}
