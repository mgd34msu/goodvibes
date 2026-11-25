/**
 * Repairing a Google connection from the request that found it broken.
 *
 * Three states stop a Google request, and each is repaired here rather than
 * handed to the person as a command to type:
 *
 *   - no connection (no refresh token): a consent asking for every scope the
 *     product needs starts at once and its link is shown to the person;
 *   - a grant that lacks a scope, or that Google no longer accepts: the same
 *     fresh consent starts, and the request that hit it waits on the consent's
 *     own completion (the loopback callback, `oauth-loopback.ts`) and is sent
 *     again with the new grant;
 *   - an API not enabled on the Cloud project: enabling it is decided under the
 *     person's mode (asked under Ask me, decided by the decision model under
 *     Jev decides, `google.enable-apis`), run with the gcloud that is signed in
 *     on this machine, and the request is sent again.
 *
 * One consent at a time: a request that finds a consent already open joins it
 * and opens no second one. The link is the person's one act; approving it in
 * their browser is the real decision and stays theirs.
 *
 * The repair is the daemon's alone (products/daemon google-repair-composition.ts):
 * the person sees the link in the owner inbox, and a tool result tells the
 * model the consent is already open and what the person sees. A terminal
 * program's own process installs none, and a check (`google.status`) reads with
 * a client that has no repair, so neither connects nor waits on a consent.
 */

import { judgmentPort } from '@goodvibes/engine/errors';
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes/judgment';
import { beginGoogleConsent, type GoogleConsentCompletion } from './consent-session.js';
import { checkAuthenticated, detectGcloud, enableServices } from './gcloud.js';
import { safeConfigString } from './config-access.js';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS, REQUIRED_SERVICES } from './setup-plan.js';
import type { GoogleApiFailure } from './api-client.js';
import type { GoogleFetchPort, GoogleLoopbackListenerFactory } from './oauth-loopback.js';
import type { GoogleTokenManager } from './token-manager.js';
import type { GoogleCommandPort, GoogleConfigPort, GoogleSecretPort } from './types.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

/** Why a consent was started, in the person's words. */
export type GoogleConsentReason = 'not-connected' | 'missing-scopes' | 'grant-invalid';

const CONSENT_REASON_WORDS: Readonly<Record<GoogleConsentReason, string>> = {
  'not-connected': 'Google is not connected on this machine.',
  'missing-scopes': 'Google refused a request because the connection lacks a permission this product needs.',
  'grant-invalid': 'Google no longer accepts the stored connection.',
};

/** What a process shows the person about a repair. */
export type GoogleRepairNotice =
  | { readonly phase: 'consent-open'; readonly consentUrl: string; readonly reason: GoogleConsentReason; readonly words: string }
  | { readonly phase: 'consent-closed'; readonly ok: boolean; readonly words: string };

/** How a caller words the one notice a consent it opens shows the person. */
export interface GoogleRepairOptions {
  /** The notice's words, given the consent link; absent: the reason and the link. */
  readonly notice?: ((consentUrl: string) => string) | undefined;
}

/** A consent the request started or joined. */
export interface GoogleConsentStarted {
  readonly started: true;
  /** True when a consent was already open and this request joined it. */
  readonly joined: boolean;
  readonly consentUrl: string;
  /** Resolves when the person approved and the new grant is stored, or when the consent ended without it. Never rejects. */
  readonly completed: Promise<GoogleConsentCompletion>;
}

/** No consent could be started, and why. */
export interface GoogleConsentNotStarted {
  readonly started: false;
  readonly problem: string;
  readonly fix: string;
}

export type GoogleConsentStart = GoogleConsentStarted | GoogleConsentNotStarted;

/** How a repair ended. */
export type GoogleRepairOutcome =
  | { readonly repaired: true }
  | { readonly repaired: false; readonly problem: string; readonly fix: string };

/** The port `GoogleApiClient` repairs a refused request through. */
export interface GoogleRequestRepair {
  /**
   * Repairs the state `failure` names and resolves once the request can be sent
   * again (`repaired`), or with why it cannot. `tokens` is the manager the
   * request used: a new grant is taken into it, so the retry uses it.
   */
  repair(failure: GoogleApiFailure, tokens: GoogleTokenManager): Promise<GoogleRepairOutcome>;
}

/** What enabling an API asks, decides and runs. */
export interface GoogleApiEnableRequest {
  readonly services: readonly string[];
  /** The Cloud project, as Google named it in the refusal or as setup stored it. */
  readonly project: string;
  /** The gcloud account that would run it. */
  readonly account: string;
}

/** Who decides enabling an API: the person's mode, the ask, and the decision model. */
export interface GoogleApiEnableDecider {
  /** The person's mode now: `ask-me`, `jev-decides`, `just-vibes`, `yolo` or `plan`. */
  mode(): string;
  /** The ordinary ask, opening on its normal default; true when the person said yes. */
  ask(request: GoogleApiEnableRequest, signal?: AbortSignal): Promise<boolean>;
}

/**
 * `google.enable-apis`: whether to enable a Google API on the person's Cloud
 * project so a request they made can run. Decided in the person's place under
 * Jev decides and Just vibes; asked under Ask me.
 *
 * Medium bands: a wrong yes turns on an API in a project the person owns
 * (free, and reversible in the console); a wrong no leaves the request refused.
 */
export const enableGoogleApis = defineBattery({
  name: 'google.enable-apis',
  version: 1,
  description: 'Whether to enable a Google API on the person\'s own Cloud project so the Google request they made can run.',
  accuracyFloor: 0.9,
  items: {
    enable: yesNo(
      'Google refused a request this person made because `request.services` is not enabled on the Cloud project `request.project`, which holds the OAuth client this product signs in with. '
      + 'Enabling it runs `gcloud services enable` as `request.account`. Say yes when every service in `request.services` is one this product needs (Gmail or Google Calendar) and the project is the one that holds this product\'s OAuth client; '
      + 'say no when a service is anything else, so nothing is turned on that the request does not need.',
      STAKES_BANDS.medium.yesNo,
    ),
  },
  fixtures: [
    { name: 'gmail on the product project', state: { request: { services: ['gmail.googleapis.com'], project: 'goodvibes-agent-a1b2c3', account: 'owner@example.com', requestedFor: 'reading mail' } }, expect: { enable: 'yes' } },
    { name: 'an unrelated api', state: { request: { services: ['compute.googleapis.com'], project: 'goodvibes-agent-a1b2c3', account: 'owner@example.com', requestedFor: 'reading mail' } }, expect: { enable: 'no' } },
  ],
});

/** Who decided an API enable, and what. */
export interface GoogleApiEnableDecision {
  readonly enable: boolean;
  /** Who decided, for the line the person reads. */
  readonly by: string;
}

/**
 * The decision under the person's mode: YOLO enables as it runs everything;
 * Plan changes nothing; Jev decides and Just vibes let the decision model
 * decide, and without a working one Jev decides asks and Just vibes holds;
 * Ask me asks.
 */
export async function decideGoogleApiEnable(decider: GoogleApiEnableDecider, request: GoogleApiEnableRequest, signal?: AbortSignal): Promise<GoogleApiEnableDecision> {
  const mode = decider.mode();
  if (mode === 'yolo') return { enable: true, by: 'YOLO' };
  if (mode === 'plan') return { enable: false, by: 'Plan mode (it changes nothing)' };
  const ask = async (): Promise<GoogleApiEnableDecision> => ({ enable: await decider.ask(request, signal), by: 'you' });
  if (mode !== 'jev-decides' && mode !== 'just-vibes') return ask();
  try {
    const site = 'google.connection-repair.enable-apis';
    const run = await enableGoogleApis.run(judgmentPort(site), { request: { ...request, services: [...request.services], requestedFor: 'a Google request' } }, { site, ...(signal ? { signal } : {}) });
    const reading = run.readings.enable;
    if (reading.outcome === 'act' && (reading.verdict === 'yes' || reading.verdict === 'no')) {
      run.recordAction(reading.verdict === 'yes' ? 'enable' : 'leave');
      return { enable: reading.verdict === 'yes', by: 'Jev, the decision model,' };
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.warn('Google: the decision model could not decide enabling an API; the mode\'s fallback decides it', { error: summarizeError(error) });
  }
  return mode === 'jev-decides' ? ask() : { enable: false, by: 'Just vibes (it holds what it cannot decide)' };
}

export interface GoogleConnectionRepairDeps {
  readonly config: Pick<GoogleConfigPort, 'get'>;
  /** The process's own secret store: the new grant is written here, as asking for consent again (`google.reauthorize`) writes it. */
  readonly secrets: GoogleSecretPort;
  readonly loopback: GoogleLoopbackListenerFactory;
  readonly fetchPort: GoogleFetchPort;
  /** gcloud, for enabling an API; absent where this process runs no programs. */
  readonly commands?: GoogleCommandPort | undefined;
  readonly homeDirectory: string;
  /** Who decides enabling an API; absent: an API is never enabled from here and the line says so. */
  readonly decider?: GoogleApiEnableDecider | undefined;
}

/** The service a refusal named as disabled, and the project it named, when Google said so. */
export interface GoogleDisabledService {
  readonly service: string | null;
  readonly project: string | null;
}

export class GoogleConnectionRepair {
  readonly #deps: GoogleConnectionRepairDeps;
  readonly #listeners = new Set<(notice: GoogleRepairNotice) => void>();
  #open: GoogleConsentStarted | null = null;
  /** One enable at a time: a second request refused for the same API waits on the first. */
  #enabling: Promise<GoogleRepairOutcome> | null = null;
  /** Owns the decisions and asks this repair makes; aborted by `close()`. */
  readonly #lifetime = new AbortController();

  constructor(deps: GoogleConnectionRepairDeps) {
    this.#deps = deps;
  }

  /** Ends the repair with its process: an open consent is released and a pending decision or ask stops. */
  close(): void {
    this.#lifetime.abort();
  }

  /** Hear every notice; returns the stop. */
  onNotice(listener: (notice: GoogleRepairNotice) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** The consent open now, if any. */
  openConsent(): GoogleConsentStarted | null {
    return this.#open;
  }

  #tell(notice: GoogleRepairNotice): void {
    for (const listener of [...this.#listeners]) {
      try { listener(notice); } catch { /* a listener that fails does not stop the consent */ }
    }
  }

  /**
   * Start a consent asking for every scope the product needs, or join the one
   * that is open. Returns at once with the link; `completed` settles when the
   * person approves (the new grant is then stored) or the consent ends.
   */
  async startConsent(reason: GoogleConsentReason, options: GoogleRepairOptions = {}): Promise<GoogleConsentStart> {
    const open = this.#open;
    if (open !== null) return { ...open, joined: true };
    const clientId = safeConfigString(this.#deps.config, GOOGLE_CONFIG_KEYS.oauthClientId);
    const clientSecret = await this.#deps.secrets.get(GOOGLE_SECRET_KEYS.oauthClientSecret);
    // Another request may have opened one while the secret was read.
    const raced = this.#open;
    if (raced !== null) return { ...raced, joined: true };
    if (clientId === null || clientSecret === null || clientSecret.trim().length === 0) {
      return {
        started: false,
        problem: `${CONSENT_REASON_WORDS[reason]} No Google OAuth client is stored on this machine, so no consent link can be made.`,
        fix: 'Creating an OAuth client is the one step Google offers only in its console: "connect" on the Google tab of Mail, calendar and channels walks through it and then shows the consent link.',
      };
    }
    const loginHint = safeConfigString(this.#deps.config, GOOGLE_CONFIG_KEYS.emailUsername)
      ?? safeConfigString(this.#deps.config, GOOGLE_CONFIG_KEYS.oauthAccount) ?? undefined;
    let session: ReturnType<typeof beginGoogleConsent>;
    try {
      session = beginGoogleConsent({
        clientId,
        clientSecret,
        config: { get: (key) => this.#deps.config.get(key), set: () => undefined },
        secrets: this.#deps.secrets,
        loopback: this.#deps.loopback,
        fetchPort: this.#deps.fetchPort,
        signal: this.#lifetime.signal,
        ...(loginHint === undefined ? {} : { loginHint }),
      });
    } catch (error) {
      return {
        started: false,
        problem: `${CONSENT_REASON_WORDS[reason]} The consent could not be started: ${summarizeError(error)}`,
        fix: 'The local port Google redirects back to may be in use by another program; the next request that needs Google tries again.',
      };
    }
    const completed = session.completed.then((outcome) => {
      if (this.#open?.consentUrl === session.consentUrl) this.#open = null;
      this.#tell({ phase: 'consent-closed', ok: outcome.ok, words: outcome.ok
        ? 'Google approved. The connection is stored and the request that needed it continues.'
        : [outcome.detail, outcome.problem, outcome.fix].filter((part) => part !== undefined && part.length > 0).join(' ') });
      return outcome;
    });
    const started: GoogleConsentStarted = { started: true, joined: false, consentUrl: session.consentUrl, completed };
    this.#open = started;
    this.#tell({
      phase: 'consent-open',
      consentUrl: session.consentUrl,
      reason,
      words: options.notice?.(session.consentUrl)
        ?? `${CONSENT_REASON_WORDS[reason]} Approve this link in your browser: ${session.consentUrl} It asks for mail and calendar together, and the request that needed it continues by itself once you approve.`,
    });
    return started;
  }

  /** The port `GoogleApiClient` uses. */
  readonly requestRepair: GoogleRequestRepair = {
    repair: (failure, tokens) => this.repair(failure, tokens),
  };

  async repair(failure: GoogleApiFailure, tokens: GoogleTokenManager, options: GoogleRepairOptions = {}): Promise<GoogleRepairOutcome> {
    if (failure.reason === 'api-disabled') return this.#enableOnce(failure);
    if (failure.reason !== 'missing-scopes' && failure.reason !== 'grant-invalid') {
      return { repaired: false, problem: failure.problem, fix: failure.fix };
    }
    const start = await this.startConsent(failure.reason, options);
    if (!start.started) return { repaired: false, problem: start.problem, fix: start.fix };
    const outcome = await start.completed;
    if (!outcome.ok) {
      return { repaired: false, problem: [outcome.detail, outcome.problem].filter(Boolean).join(' '), fix: outcome.fix ?? 'The next request that needs Google starts a new consent.' };
    }
    // Read back what the consent stored: the retry runs only on a grant that is durable.
    const stored = await this.#deps.secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken);
    if (stored === null || stored.trim().length === 0) {
      return { repaired: false, problem: 'Google approved, but the new grant could not be read back from the credential store.', fix: 'Check that the credential store is writable; the next request that needs Google starts a new consent.' };
    }
    tokens.adoptGrant(stored);
    return { repaired: true };
  }

  #enableOnce(failure: GoogleApiFailure): Promise<GoogleRepairOutcome> {
    const running = this.#enabling;
    if (running !== null) return running;
    const attempt = this.#enable(failure).finally(() => { if (this.#enabling === attempt) this.#enabling = null; });
    this.#enabling = attempt;
    return attempt;
  }

  async #enable(failure: GoogleApiFailure): Promise<GoogleRepairOutcome> {
    const named = failure.disabledService;
    const services = named?.service ? [named.service] : [...REQUIRED_SERVICES];
    const project = named?.project ?? safeConfigString(this.#deps.config, GOOGLE_CONFIG_KEYS.oauthProjectId);
    const what = services.join(' and ');
    if (project === null) {
      return {
        repaired: false,
        problem: `${failure.problem} Google did not say which Cloud project, and none is stored, so ${what} cannot be enabled from here.`,
        fix: 'Open https://console.cloud.google.com/apis/library, choose the project that holds this product\'s OAuth client, and enable it there.',
      };
    }
    const commands = this.#deps.commands;
    const gcloud = commands ? await detectGcloud(commands, this.#deps.homeDirectory) : null;
    if (commands === undefined || gcloud === null || !gcloud.ok) {
      return {
        repaired: false,
        problem: `${failure.problem} gcloud is not installed on this machine, so GoodVibes cannot enable ${what} on project ${project}.`,
        fix: `Install the Google Cloud CLI and sign it in, or run it where gcloud is: gcloud services enable ${services.join(' ')} --project=${project}`,
      };
    }
    const signedIn = await checkAuthenticated(commands, gcloud.path);
    if (!signedIn.ok) {
      return {
        repaired: false,
        problem: `${failure.problem} gcloud is installed but signed in to no account, so ${what} cannot be enabled on project ${project}.`,
        fix: 'Signing gcloud in (gcloud auth login) is a browser sign-in only the account holder can do; the next request that needs this API enables it then.',
      };
    }
    const request: GoogleApiEnableRequest = { services, project, account: signedIn.account };
    const decider = this.#deps.decider;
    if (decider === undefined) {
      return { repaired: false, problem: `${failure.problem} Nothing was changed.`, fix: '"enable it" on the Google tab of Mail, calendar and channels turns it on.' };
    }
    // The decision's owning signal: the repair's lifetime (closed with the process's composition).
    const decision = await decideGoogleApiEnable(decider, request, this.#lifetime.signal);
    if (!decision.enable) {
      return { repaired: false, problem: `${failure.problem} ${decision.by === 'you' ? 'You chose' : `${decision.by} chose`} not to enable ${what} on project ${project}, so the request was not sent again.`, fix: 'The next request that needs it asks again.' };
    }
    const enabled = await enableServices(commands, gcloud.path, project, services);
    if (!enabled.ok) return { repaired: false, problem: `Enabling ${what} on project ${project} failed: ${enabled.problem}`, fix: enabled.fix };
    return { repaired: true };
  }
}

const repairs = new WeakMap<object, GoogleConnectionRepair>();

/** Installs the repair of one scope (a process's secret store), so every connection of that scope repairs through it. */
export function installGoogleConnectionRepair(scope: object, repair: GoogleConnectionRepair): void {
  repairs.set(scope, repair);
}

/** The repair installed for a scope, or undefined. */
export function googleConnectionRepairOf(scope: object): GoogleConnectionRepair | undefined {
  return repairs.get(scope);
}

/**
 * The words a tool result gives the model when a request found Google not
 * connected: the consent is already open, what the person sees, and that
 * nothing is to be asked of them.
 */
export function describeConsentForModel(start: GoogleConsentStart, request: string): string {
  if (!start.started) return `${start.problem} ${start.fix}`;
  return [
    `Google is not connected, so connecting it has already started${start.joined ? ' (a consent was already open; this request joined it)' : ''}.`,
    `The person is shown this consent link now and only has to approve it in their browser: ${start.consentUrl}`,
    'Do not ask them to run anything. Give them the link if they have not seen it.',
    `Once they approve, the connection is stored; ${request} can then be made again.`,
  ].join(' ');
}
