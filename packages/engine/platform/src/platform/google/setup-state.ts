/**
 * What is already set up.
 *
 * Idempotency here is deliberately not a journal of "steps I previously ran".
 * A journal lies as soon as anything changes outside the flow, a revoked app
 * password, a deleted OAuth client, a project someone removed. Instead every
 * check probes the actual state: is the secret present, is the config written,
 * does the credential still work. Re-running after a partial failure therefore
 * resumes from what is genuinely true rather than from what was once recorded.
 *
 * The one thing that cannot be probed locally is the OAuth publishing status,
 * which lives only in the Cloud Console. It is cached in config after being
 * read; the OAuth path reads it from the console before the client is created.
 */

import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from './setup-plan.js';
import type { GoogleConfigPort, GoogleSecretPort } from './types.js';
import { safeConfigGet, safeConfigString } from './config-access.js';
import { GoogleReadingError } from './browser-readings.js';

/** Whether a secret is stored, not stored, or could not be read. */
export type GoogleSecretState = 'present' | 'absent' | 'unreadable';

/**
 * The one reading of a Google secret's presence, for status, repair and the
 * setup steps alike. A read failure is not an absence: acting on it as one
 * would offer a new setup over a working credential, or create a second
 * credential and overwrite the stored one. Never returns the value.
 */
export async function readGoogleSecretState(secrets: GoogleSecretPort, key: string): Promise<GoogleSecretState> {
  try {
    const value = await secrets.get(key);
    return typeof value === 'string' && value.trim().length > 0 ? 'present' : 'absent';
  } catch (error) {
    // A superseded request is not a store failure; it must keep unwinding.
    if (error instanceof GoogleReadingError) throw error;
    return 'unreadable';
  }
}

/** A snapshot of what already exists, all of it probed rather than remembered. */
export interface GoogleSetupState {
  /** An app password is present in the secret store. */
  readonly hasAppPassword: boolean;
  /** Every Gmail IMAP/SMTP config key needed to connect is populated. */
  readonly hasGmailConfig: boolean;
  /** The mailbox is usable: the Gmail settings are complete and the app password is stored. */
  readonly gmailEnabled: boolean;
  /** The account address Gmail is configured for, or null. Not a secret. */
  readonly gmailUsername: string | null;
  /** A private calendar address is present in the secret store. */
  readonly hasCalendarAddress: boolean;
  /** An OAuth client id is configured. Client ids are not secrets (RFC 8252). */
  readonly oauthClientId: string | null;
  /** An OAuth client secret is present in the secret store. */
  readonly hasOAuthClientSecret: boolean;
  /** A refresh token is present in the secret store. */
  readonly hasRefreshToken: boolean;
  /** The Cloud project id recorded for the OAuth path, or null. */
  readonly projectId: string | null;
  /** Last known publishing status. 'unknown' until the console has been read. */
  readonly publishingStatus: 'testing' | 'in-production' | 'unknown';
  /**
   * True when the secret store could not be read, so the `has*` answers above
   * are unknown rather than "not stored".
   */
  readonly secretStoreUnreadable: boolean;
}

function readPublishingStatus(value: unknown): GoogleSetupState['publishingStatus'] {
  if (value === 'testing' || value === 'in-production') return value;
  return 'unknown';
}

/** Probe everything the Google flows care about. */
export async function detectGoogleSetupState(deps: {
  readonly config: GoogleConfigPort;
  readonly secrets: GoogleSecretPort;
}): Promise<GoogleSetupState> {
  const { config, secrets } = deps;

  const username = safeConfigString(config, GOOGLE_CONFIG_KEYS.emailUsername);
  const imapHost = safeConfigString(config, GOOGLE_CONFIG_KEYS.emailImapHost);
  const smtpHost = safeConfigString(config, GOOGLE_CONFIG_KEYS.emailSmtpHost);
  const passwordRef = safeConfigString(config, GOOGLE_CONFIG_KEYS.emailPassword);

  const secretStates = await Promise.all([
    readGoogleSecretState(secrets, GOOGLE_SECRET_KEYS.appPassword),
    readGoogleSecretState(secrets, GOOGLE_SECRET_KEYS.calendarIcsUrl),
    readGoogleSecretState(secrets, GOOGLE_SECRET_KEYS.oauthClientSecret),
    readGoogleSecretState(secrets, GOOGLE_SECRET_KEYS.oauthRefreshToken),
  ]);
  const [hasAppPassword, hasCalendarAddress, hasOAuthClientSecret, hasRefreshToken] = secretStates.map((state) => state === 'present');

  return {
    hasAppPassword: hasAppPassword === true,
    hasGmailConfig: username !== null && imapHost !== null && smtpHost !== null && passwordRef !== null,
    gmailEnabled: hasAppPassword === true && username !== null && imapHost !== null && smtpHost !== null && passwordRef !== null,
    gmailUsername: username,
    hasCalendarAddress: hasCalendarAddress === true,
    oauthClientId: safeConfigString(config, GOOGLE_CONFIG_KEYS.oauthClientId),
    hasOAuthClientSecret: hasOAuthClientSecret === true,
    hasRefreshToken: hasRefreshToken === true,
    projectId: safeConfigString(config, GOOGLE_CONFIG_KEYS.oauthProjectId),
    publishingStatus: readPublishingStatus(safeConfigGet(config, GOOGLE_CONFIG_KEYS.oauthPublishingStatus)),
    secretStoreUnreadable: secretStates.includes('unreadable'),
  };
}

/**
 * A plain-language description of the current state, for `--check` and for the
 * opening line of a run so the owner can see what will be skipped. Contains no
 * secret values, only whether each one is present.
 */
export function describeGoogleSetupState(state: GoogleSetupState): readonly string[] {
  if (state.secretStoreUnreadable) {
    // Every line below would read "not connected" from a store that answered
    // nothing, and send the reader to set up over a working connection.
    return [
      'The credential store could not be read, so whether Gmail, Calendar and OAuth credentials are stored is unknown.',
      'Unlock or repair the secret store (a locked keyring or a signed-out password manager), then check again.',
      ...(state.oauthClientId === null ? [] : [`OAuth: a client is configured (${state.oauthClientId.slice(-12)}).`]),
    ];
  }
  const lines: string[] = [];

  if (state.hasGmailConfig && state.hasAppPassword) {
    const account = state.gmailUsername ?? 'an account';
    lines.push(`Gmail: configured for ${account} with a stored app password.`);
  } else if (state.hasAppPassword) {
    lines.push('Gmail: an app password is stored but the mail settings are incomplete.');
  } else {
    lines.push('Gmail: not connected.');
  }

  lines.push(
    state.hasCalendarAddress
      ? 'Calendar: a private calendar address is stored (read-only access).'
      : 'Calendar: not connected.',
  );

  if (state.hasRefreshToken) {
    const expiry =
      state.publishingStatus === 'in-production'
        ? 'the app is published, so the credential does not expire'
        : state.publishingStatus === 'testing'
          ? 'WARNING: the app is still in Testing, so this credential expires seven days after it was issued'
          : 'publishing status has not been read yet, so the credential lifetime is unknown';
    lines.push(`OAuth: authorized, ${expiry}.`);
  } else if (state.oauthClientId !== null) {
    lines.push('OAuth: a client exists but the agent has not been authorized yet.');
  } else {
    lines.push('OAuth: not set up.');
  }

  return lines;
}

/**
 * Whether the app-password path has everything it needs. Used to answer
 * "is there anything left to do" without running the flow.
 */
export function appPasswordPathComplete(state: GoogleSetupState): boolean {
  return state.hasAppPassword && state.hasGmailConfig && state.gmailEnabled && state.hasCalendarAddress;
}

/**
 * Whether the OAuth path is complete *and* not known to be on a seven-day fuse.
 * An unread publishing status counts as complete: a client handed over by the
 * owner skips the console, so holding the path open for it could never end.
 */
export function oauthPathComplete(state: GoogleSetupState): boolean {
  return (
    state.oauthClientId !== null &&
    state.hasOAuthClientSecret &&
    state.hasRefreshToken &&
    state.publishingStatus !== 'testing'
  );
}
