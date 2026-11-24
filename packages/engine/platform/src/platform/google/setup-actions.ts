import { isClassicOperation } from '../runtime/decision-policy.js';
import { ownGoogleSetupDeps, ownGoogleSetupRunners } from './setup-reading-scope.js';
/** Binds Google setup steps to their implementations through injected ports.
 * Steps requiring a person report needs-human. Credentials go to the encrypted
 * store; reports and progress messages never include their values.
 */

import {
  APP_PASSWORD_LABEL,
  APP_PASSWORD_URL,
  GMAIL_IMAP_HOST,
  GMAIL_IMAP_PORT,
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  GOOGLE_CONFIG_KEYS,
  GOOGLE_SECRET_KEYS,
} from './setup-plan.js';
import { GoogleReadingError } from './browser-readings.js';
import { GoogleSetupWriteCommittedError } from './setup-effect.js';
import type { GoogleStepRunner, GoogleStepRunnerResult } from './setup-flow.js';
import type { GoogleSecretPort, GoogleSetupPath, GoogleStepId } from './types.js';
import type { GoogleClientIntakeChoice, GoogleSetupActionDeps } from './setup-action-deps.js';
import { buildCloudProjectRunners } from './setup-actions-cloud-project.js';
import { createAppPassword } from './app-password-flow.js';
import { createDesktopOAuthClient } from './console-flow.js';
import {
  clientCredentialsFromInput,
  readClientCredentialsFromJson,
  type GoogleClientCredentials,
  type GoogleClientIntakeResult,
} from './client-intake.js';
import { collectDownloadedClientFile } from './client-download.js';
import { beginGoogleConsent, storeClientCredentials, type GoogleClientRegistrationResult } from './consent-session.js';
import { looksLikeGoogleSignIn, readGoogleTwoStepState } from './browser-elements.js';
import { safeConfigGet, safeConfigString } from './config-access.js';
import { readGoogleSecretState } from './setup-state.js';
import { secretReferenceFor } from '../config/plaintext-credential-sweep.js';

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when a secret exists and is non-empty. Never returns the value. */
async function secretPresent(secrets: GoogleSecretPort, key: string): Promise<boolean> {
  return (await readGoogleSecretState(secrets, key)) === 'present';
}

const secretState = readGoogleSecretState;

/**
 * What to say about the seven-day Testing expiry. Only a status that was read
 * as Testing is a fact; an unread status is reported as unchecked, never as
 * "not published" (an existing client's app is usually already published).
 */
function publishingWarnings(config: GoogleSetupActionDeps['config'], whenTesting: string): readonly string[] {
  const status = safeConfigGet(config, GOOGLE_CONFIG_KEYS.oauthPublishingStatus);
  if (status === 'in-production') return [];
  if (status === 'testing') return [whenTesting];
  return ['Whether the app is published was not checked, so this credential would expire seven days after it was issued only if the app is still in Testing.'];
}

function done(detail: string, warnings?: readonly string[]): GoogleStepRunnerResult {
  return warnings === undefined || warnings.length === 0 ? { outcome: 'done', detail } : { outcome: 'done', detail, warnings };
}

function alreadyDone(detail: string): GoogleStepRunnerResult {
  return { outcome: 'already-done', detail };
}

function needsHuman(detail: string, problem: string, fix: string): GoogleStepRunnerResult {
  return { outcome: 'needs-human', detail, problem, fix };
}

function failed(detail: string, problem: string, fix: string): GoogleStepRunnerResult {
  return { outcome: 'failed', detail, problem, fix };
}

// ---------------------------------------------------------------------------
// Path A, app password
// ---------------------------------------------------------------------------

function browserReadyRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    try {
      await deps.browser();
      return done('A browser is available for the pages Google exposes through no API.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failed(
        'No browser could be opened.',
        `The browser this flow drives could not be started: ${message}`,
        'Reinstall the agent so its browser driver is present, then re-run.',
      );
    }
  };
}

/**
 * Signed-in check. Landing on Google's sign-in wall is the normal first-run
 * outcome and is reported as a clean stop, never as a failure.
 */
function signedInRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async (spec) => {
    const browser = await deps.browser();
    const url = spec.url;
    if (url !== undefined) await browser.navigate(url);
    const current = await browser.currentUrl();
    const elements = await browser.snapshot();
    if (await looksLikeGoogleSignIn(current, elements, { browser })) {
      return needsHuman(
        'Google is asking for a sign-in.',
        `Google showed its sign-in page instead of the account page (currently at ${current}).`,
        'Sign in to the Google account you want the agent to use in the open browser window, complete any 2-Step prompt, then re-run. The sign-in is remembered from then on.',
      );
    }
    return done(isClassicOperation()
      ? 'Signed in to Google in the browser profile this flow uses (read from the page address; no decision model is in use).'
      : 'Signed in to Google in the browser profile this flow uses.');
  };
}

function twoStepRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async (spec) => {
    const browser = await deps.browser();
    if (spec.url !== undefined) await browser.navigate(spec.url);
    const state = await readGoogleTwoStepState(browser, { signal: deps.signal, assertCurrent: deps.assertCurrent });
    if (state === 'on') {
      return alreadyDone('2-Step Verification is already on, which is what makes app passwords available.');
    }
    if (state === 'off') {
      return needsHuman(
        '2-Step Verification is off.',
        'Google only offers app passwords on accounts with 2-Step Verification enabled, and this account has it off.',
        `Open ${spec.url ?? 'the 2-Step Verification settings'}, click "Turn on 2-Step Verification", follow the prompts, then re-run.`,
      );
    }
    // Without a decision model only Google's English status sentence is read. The
    // app-password page states the same block itself, so the run goes on and that
    // step reports it, rather than stopping here on every re-run.
    if (isClassicOperation()) {
      return done('The 2-Step Verification state was not read (no decision model is in use, and the page did not show Google\'s English status sentence); the app-password step reports it if it is off.');
    }
    // An unreadable page is not proof of either state, so it is not claimed as one.
    return needsHuman(
      'Could not read the 2-Step Verification state.',
      'The 2-Step Verification page did not render text this flow could read, so its state is unknown rather than off.',
      `Open ${spec.url ?? 'the 2-Step Verification settings'} yourself and confirm it reads "2-Step Verification is on", then re-run.`,
    );
  };
}

function appPasswordRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const existing = await secretState(deps.secrets, GOOGLE_SECRET_KEYS.appPassword);
    if (existing === 'present') {
      return alreadyDone(`An app password labelled ${APP_PASSWORD_LABEL} is already in the encrypted store.`);
    }
    if (existing === 'unreadable') {
      return failed(
        'The encrypted secret store could not be read.',
        'Whether an app password is already stored is unknown, and creating another could overwrite it.',
        'Unlock or repair the secret store, then re-run.',
      );
    }
    const browser = await deps.browser();
    const result = await createAppPassword(browser, { label: APP_PASSWORD_LABEL });
    if (result.kind === 'needs-human') {
      return needsHuman('Google needs a person for this step.', result.problem, result.fix);
    }
    if (result.kind === 'failed') {
      return failed('The app password was not created.', result.problem, result.fix);
    }
    // The only place the value is touched: straight into the encrypted store.
    try {
      await deps.secrets.set(GOOGLE_SECRET_KEYS.appPassword, result.password);
    } catch (error) {
      // The write committed; "could not be stored" would be untrue, so keep unwinding to the truthful report.
      if (error instanceof GoogleReadingError || error instanceof GoogleSetupWriteCommittedError) throw error;
      // Google shows the password once; say that the entry now exists there so it can be removed.
      return failed(
        'The app password was created but could not be stored.',
        `The encrypted secret store refused the write (${error instanceof Error ? error.message : 'unknown error'}), and Google shows an app password only once.`,
        `Remove the unused "${APP_PASSWORD_LABEL}" app password at https://myaccount.google.com/apppasswords, fix the secret store, then re-run.`,
      );
    }
    deps.config.set(GOOGLE_CONFIG_KEYS.emailPassword, secretReferenceFor(GOOGLE_SECRET_KEYS.appPassword));
    return done('Created a Gmail app password and stored it in the encrypted secret store.');
  };
}

/**
 * Writes the Gmail endpoints. The account address is the one thing this cannot
 * invent: it is taken from config, or from an adopted credential, and asked for
 * when neither knows it.
 */
function gmailConfigRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const configured = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.emailUsername);
    const username = configured;
    if (username === null) {
      return needsHuman(
        'The Gmail address is not known yet.',
        'Gmail needs the account address to connect over IMAP and SMTP, and nothing on this machine records which address to use.',
        'Tell me which Gmail address to connect as and I will set it up.',
      );
    }

    deps.config.set(GOOGLE_CONFIG_KEYS.emailImapHost, GMAIL_IMAP_HOST);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailImapPort, GMAIL_IMAP_PORT);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailSmtpHost, GMAIL_SMTP_HOST);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailSmtpPort, GMAIL_SMTP_PORT);
    // Gmail's submission port 587 upgrades with STARTTLS: not implicit TLS.
    deps.config.set(GOOGLE_CONFIG_KEYS.emailSmtpSecure, false);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailFromAddress, username);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailPassword, secretReferenceFor(GOOGLE_SECRET_KEYS.appPassword));
    return done(`Pointed the mail surface at Gmail for ${username}.`);
  };
}

/**
 * The one next step for a failed mail check, named after what the person saw:
 * a refused app password gets the steps to make a new one, an unreachable
 * server says which server and that the network or the address is the cause.
 */
function gmailVerifyFix(outcome: Awaited<ReturnType<GoogleSetupActionDeps['verifyMail']>>): string {
  const protocol = outcome.stage ?? 'IMAP';
  if (outcome.failure === 'credentials-rejected') {
    return `Gmail refused the stored app password over ${protocol}. Make a new one: open ${APP_PASSWORD_URL}, delete the "${APP_PASSWORD_LABEL}" entry, `
      + `type ${APP_PASSWORD_LABEL} in the "App name" box, click "Create" and copy the 16-character password; then run /mail password, `
      + 'paste it, and run /google setup again to check it.';
  }
  if (outcome.failure === 'unreachable') {
    const server = outcome.server ?? `the ${protocol} server`;
    return `The ${protocol} server ${server} could not be reached, so this machine's network or that address is the cause; `
      + 'the app password was not checked. Run /google setup again once the network is up; /mail settings shows the address.';
  }
  return 'Put right what the line above names (/mail settings shows every mail setting), then run /google setup again.';
}

function gmailVerifyRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const outcome = await deps.verifyMail();
    return outcome.ok
      ? done(outcome.detail)
      : failed('Could not connect to Gmail.', outcome.detail, gmailVerifyFix(outcome));
  };
}

function calendarIcsRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async (spec) => {
    if (await secretPresent(deps.secrets, GOOGLE_SECRET_KEYS.calendarIcsUrl)) {
      return alreadyDone('A private calendar address is already stored.');
    }
    // Google exposes no API for the private iCal address and it is a
    // credential in URL form, so it is collected by the person, not scraped.
    return needsHuman(
      'The private calendar address has not been captured.',
      'Google exposes the private iCal address only in the calendar settings UI, and it is a credential, anyone holding it can read the calendar.',
      `Open ${spec.url ?? 'Google Calendar settings'}, pick the calendar, click "Integrate calendar", copy the address under "Secret address in iCal format", and paste it here, I will store it in the encrypted store.`,
    );
  };
}

function calendarVerifyRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const outcome = await deps.verifyCalendar();
    return outcome.ok
      ? done(outcome.detail)
      : failed('Could not read the calendar feed.', outcome.detail, 'Copy the private address again and paste it here, I will store it.');
  };
}

// ---------------------------------------------------------------------------
// Path B, OAuth
// ---------------------------------------------------------------------------

/** Turn whichever intake route was chosen into client credentials. */
async function obtainClientCredentials(deps: GoogleSetupActionDeps, choice: GoogleClientIntakeChoice): Promise<GoogleClientIntakeResult> {

  if (choice.kind === 'manual-entry') {
    return clientCredentialsFromInput({ clientId: choice.clientId, clientSecret: choice.clientSecret });
  }

  if (choice.kind === 'client-json-file') {
    const raw = deps.files.readText(choice.path);
    if (raw === null) {
      return {
        ok: false,
        problem: `No readable file at ${choice.path}.`,
        fix: 'Tell me the right path and I will read it, or say so and I will walk you through creating a client.',
      };
    }
    return readClientCredentialsFromJson(raw);
  }

  if (choice.kind === 'downloaded-file') {
    const scan = deps.downloadScan;
    if (scan === undefined) {
      return {
        ok: false,
        problem: 'This run cannot scan a downloads directory.',
        fix: 'Tell me where the client JSON is and I will read it from there.',
      };
    }
    const collected = collectDownloadedClientFile(scan, choice.directory, {
      ...(choice.since === undefined ? {} : { since: choice.since }),
    });
    if (!collected.ok) return { ok: false, problem: collected.problem, fix: collected.fix };
    return readClientCredentialsFromJson(collected.file.contents);
  }

  const browser = await deps.browser();
  const created = await createDesktopOAuthClient(browser, { name: 'goodvibes agent' });
  if (created.kind === 'needs-human') return { ok: false, problem: created.problem, fix: created.fix };
  if (created.kind === 'failed') return { ok: false, problem: created.problem, fix: created.fix };
  return clientCredentialsFromInput({ clientId: created.clientId, clientSecret: created.clientSecret });
}

/**
 * Read a client from the chosen intake route and store it, the one way a
 * client the owner hands over (typed values, a client JSON, a downloaded file)
 * or the console walkthrough produced reaches the store. `/google client` and
 * `/google client-file` call this and then run the existing-client path; the
 * OAuth path's client step calls it too.
 */
export async function registerGoogleClientFromIntake(
  deps: GoogleSetupActionDeps,
  choice: GoogleClientIntakeChoice,
): Promise<GoogleClientRegistrationResult & { readonly route?: string }> {
  const intake = await obtainClientCredentials(deps, choice);
  if (!intake.ok) return { ok: false, problem: intake.problem, fix: intake.fix };
  const stored = await storeClientCredentials(deps, intake.credentials);
  return { ...stored, route: intake.route };
}

function oauthClientRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const storedId = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.oauthClientId);
    const storedSecret = await secretState(deps.secrets, GOOGLE_SECRET_KEYS.oauthClientSecret);
    if (storedSecret === 'unreadable') {
      return failed(
        'The encrypted secret store could not be read.',
        'Whether an OAuth client secret is already stored is unknown, and creating a client now could overwrite it.',
        'Unlock or repair the secret store, then re-run.',
      );
    }
    if (storedId !== null && storedSecret === 'present') {
      return alreadyDone('An OAuth client is already configured.');
    }

    const choice: GoogleClientIntakeChoice = deps.clientIntake ?? { kind: 'console-walkthrough' };
    const registered = await registerGoogleClientFromIntake(deps, choice);
    if (!registered.ok) {
      // A console walkthrough that stops at a sign-in or a dialog is a human
      // handoff, not a failure, the other routes are genuine failures.
      return choice.kind === 'console-walkthrough'
        ? needsHuman('The OAuth client was not created.', registered.problem, registered.fix)
        : failed('The OAuth client credentials could not be read.', registered.problem, registered.fix);
    }
    return done(`Stored the Desktop OAuth client ${registered.clientIdTail} (via ${registered.route ?? choice.kind}); the secret went to the encrypted store.`);
  };
}

/**
 * The consent step. The exchange itself is `beginGoogleConsent`, the same one
 * the agent tool uses (listener, PKCE, state check, code exchange, storing the
 * refresh token); this step hands the person the link and waits on it.
 */
function oauthAuthorizeRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async (spec) => {
    const storedToken = await secretState(deps.secrets, GOOGLE_SECRET_KEYS.oauthRefreshToken);
    if (storedToken === 'present') {
      return alreadyDone('The agent is already authorized; a refresh token is in the encrypted store.');
    }
    if (storedToken === 'unreadable') {
      return failed(
        'The encrypted secret store could not be read.',
        'Whether a refresh token is already stored is unknown, and a new consent would overwrite it.',
        'Unlock or repair the secret store, then re-run.',
      );
    }

    let clientId = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.oauthClientId);
    let secret = readString(await deps.secrets.get(GOOGLE_SECRET_KEYS.oauthClientSecret));
    if (clientId === null || secret === null) {
      // Nothing to authorize against yet: setting the client up runs first, as its own step would.
      const client = await oauthClientRunner(deps)(spec);
      if (client.outcome !== 'done' && client.outcome !== 'already-done') return client;
      clientId = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.oauthClientId);
      secret = readString(await deps.secrets.get(GOOGLE_SECRET_KEYS.oauthClientSecret));
      if (clientId === null || secret === null) {
        return failed('No OAuth client is configured.', 'The client step finished, but no client id and secret are stored.', 'Store the client with /google client <client-id> <client-secret>, then run the setup again.');
      }
    }

    const session = beginGoogleConsent({
      clientId,
      clientSecret: secret,
      config: deps.config,
      secrets: deps.secrets,
      loopback: deps.loopback,
      fetchPort: deps.fetchPort,
      signal: deps.signal,
      assertCurrent: deps.assertCurrent,
      ...(deps.loginHint === undefined ? {} : { loginHint: deps.loginHint }),
    });
    try {
      // Printing beats driving. Google's sign-in wall rejects automated
      // browsers, so a printed link is both the most reliable route and the
      // smallest ask, one click, which is the entire budget for this flow.
      if (deps.announceConsentUrl !== undefined) {
        deps.announceConsentUrl(session.consentUrl);
      } else if (deps.openUrl !== undefined) {
        await deps.openUrl(session.consentUrl);
      } else {
        const browser = await deps.browser();
        await browser.navigate(session.consentUrl);
      }
    } catch (error) {
      session.cancel();
      throw error;
    }

    const outcome = await session.completed;
    if (outcome.ok) {
      const warnings = publishingWarnings(deps.config, 'The app is in Testing, so this refresh token expires seven days after it was issued. Publish the app and authorize again.');
      return done('Authorized. The refresh token went straight into the encrypted store.', warnings);
    }
    // A superseded request or a write that committed keeps unwinding to the truthful report.
    if (outcome.cause instanceof GoogleReadingError || outcome.cause instanceof GoogleSetupWriteCommittedError) throw outcome.cause;
    const problem = outcome.problem ?? outcome.detail;
    const fix = outcome.fix ?? 'Say so and I will start a fresh consent and hand you the link.';
    // The person not finishing is a clean stop, not a fault.
    return outcome.reason === 'not-completed'
      ? needsHuman('Consent was not completed.', problem, 'Say so and I will start a fresh consent and hand you the link.')
      : failed(outcome.detail, problem, fix);
  };
}

/**
 * The proving step.
 *
 * "A refresh token is stored" was the old answer and it is not evidence of
 * anything a person cares about, the owner's credential was stored, reported
 * connected, and refused the first calendar call it was asked to make. So this
 * uses the credential: it reads the mailbox and reads the calendar, and says
 * what it read. Both are reads; nothing is sent and nothing is changed.
 */
function oauthVerifyRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    if (!(await secretPresent(deps.secrets, GOOGLE_SECRET_KEYS.oauthRefreshToken))) {
      return failed(
        'There is no refresh token to check.',
        'Authorization did not store a refresh token, so there is nothing to verify.',
        'Run /google reauthorize to start the consent again.',
      );
    }

    const warnings = publishingWarnings(deps.config, 'Publishing status is "Testing", so the stored credential expires seven days after it was issued.');

    // The proof is a step of the setup: it reads the mailbox and the calendar with the stored credential.
    const proof = await deps.proveConnection();
    if (!proof.ok) {
      return failed(
        'The credential is stored but does not work yet.',
        proof.problem ?? proof.detail,
        proof.fix ?? 'Run /google reauthorize to ask for mail and calendar together in one consent.',
      );
    }
    return done(proof.detail, warnings);
  };
}


// ---------------------------------------------------------------------------
// The runner map
// ---------------------------------------------------------------------------

/**
 * Bind every step of one path to the function that performs it.
 *
 * The executor throws on a missing runner, so a path is either completely bound
 * or fails loudly at the first gap, there is no silent skip.
 */
export function buildGoogleSetupRunners(
  path: GoogleSetupPath,
  deps: GoogleSetupActionDeps,
): ReadonlyMap<GoogleStepId, GoogleStepRunner> {
  deps = ownGoogleSetupDeps(deps);
  const runners = new Map<GoogleStepId, GoogleStepRunner>();

  if (path === 'app-password') {
    runners.set('browser-ready', browserReadyRunner(deps));
    runners.set('google-signed-in', signedInRunner(deps));
    runners.set('two-step-verification', twoStepRunner(deps));
    runners.set('app-password', appPasswordRunner(deps));
    runners.set('gmail-config', gmailConfigRunner(deps));
    runners.set('gmail-verify', gmailVerifyRunner(deps));
    runners.set('calendar-ics-address', calendarIcsRunner(deps));
    runners.set('calendar-verify', calendarVerifyRunner(deps));
    return ownGoogleSetupRunners(runners, deps);
  }

  // The existing-client path is two steps and no gcloud state, because a
  // stored client means the project, the APIs, the branding and the audience
  // all already exist, that is what having a client id MEANS. Walking those
  // steps again is exactly the defect this path was added to remove.
  if (path === 'existing-client') {
    runners.set('oauth-authorize', oauthAuthorizeRunner(deps));
    runners.set('oauth-verify', oauthVerifyRunner(deps));
    return ownGoogleSetupRunners(runners, deps);
  }

  // The six project-and-console steps live in setup-actions-cloud-project.ts;
  // they share a gcloud detection between them, which that module owns.
  for (const [id, runner] of buildCloudProjectRunners(deps)) runners.set(id, runner);
  runners.set('oauth-client', oauthClientRunner(deps));
  runners.set('oauth-authorize', oauthAuthorizeRunner(deps));
  runners.set('oauth-verify', oauthVerifyRunner(deps));
  return ownGoogleSetupRunners(runners, deps);
}

export type { GoogleClientCredentials };

// The contracts and the adoption route moved to their own modules when this
// file outgrew the line cap. Re-exported here so every existing importer, and
// the package index, keeps resolving them from the same place.
export type { GoogleClientIntakeChoice, GoogleSetupActionDeps } from './setup-action-deps.js';
export {
  adoptExistingGoogleCredentials,
  type GoogleAdoptionOutcome,
} from './setup-actions-adoption.js';
