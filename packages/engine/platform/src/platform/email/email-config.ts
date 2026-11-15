/**
 * Reading the email config, and resolving the one secret it points at.
 *
 * Split out of `email-service.ts` to keep that file under the repository's
 * per-file line cap. Nothing here opens a socket: every function takes plain
 * values and a secret store, which is what lets the validation rules and the
 * credential-scope rule be exercised without a mail server.
 */

import { ownerMessageForFailure } from './imap-open.js';
import { isLoopbackHost } from '../utils/reachable-base-url.js';
import type { EmailCapabilityFailureNotice } from './imap-open.js';
// Type-only, so this is erased at build time and no runtime cycle exists
// between the two halves of what used to be one file.
import type {
  EmailConfig,
  EmailSocketFactory,
  EmailTransportPort,
  ImapSecurityMode,
  SmtpSecurityMode,
} from './email-service.js';

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return isFinite(n) ? n : fallback;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readSmtpSecurity(value: unknown): SmtpSecurityMode {
  if (value === 'tls' || value === 'starttls' || value === 'auto') return value;
  return 'auto';
}

/**
 * `email.imapSecurity`, defaulting to TLS.
 *
 * Anything unrecognised, including an absent value, which is what a config that
 * predates the key produces, reads as 'tls'. The safe direction for a value
 * nobody can interpret is the encrypted connection, so the only way to get a
 * plaintext IMAP connection is to ask for one.
 */
function readImapSecurity(value: unknown): ImapSecurityMode {
  return value === 'plaintext' ? 'plaintext' : 'tls';
}

/**
 * Which transport member opens the IMAP connection.
 *
 * A transport with no `connectImapPlain` cannot honour a plaintext request, and
 * is refused by name: silently handing back the TLS factory would open a TLS
 * handshake against a plain listener and report a protocol error from a port the
 * operator never asked to be encrypted. `setting` is the key the caller read the
 * security choice from, so the refusal names the setting the operator actually
 * has: `email.imapSecurity` for the mail tools, `surfaces.email.imap.secure`
 * for the inbound watcher.
 */
export function imapSocketFactoryFor(
  transport: Pick<EmailTransportPort, 'connectImapTls' | 'connectImapPlain'>,
  security: ImapSecurityMode | undefined,
  setting: 'email.imapSecurity' | 'surfaces.email.imap.secure' = 'email.imapSecurity',
): EmailSocketFactory {
  if (security !== 'plaintext') return transport.connectImapTls;
  const plain = transport.connectImapPlain;
  if (!plain) {
    throw new Error(
      `${setting} asks for a plaintext IMAP connection, and this email transport provides no `
      + 'connectImapPlain to open one. Use TLS, or run with a transport that can open a plaintext connection.',
    );
  }
  return plain;
}

export function readEmailConfig(getConfig: (key: string) => unknown): EmailConfig {
  return {
    enabled: readBoolean(getConfig('email.enabled'), false),
    imapHost: readString(getConfig('email.imapHost')),
    imapPort: readNumber(getConfig('email.imapPort'), 993),
    imapSecurity: readImapSecurity(getConfig('email.imapSecurity')),
    smtpHost: readString(getConfig('email.smtpHost')),
    smtpPort: readNumber(getConfig('email.smtpPort'), 587),
    smtpSecurity: readSmtpSecurity(getConfig('email.smtpSecurity')),
    username: readString(getConfig('email.username')),
    passwordRef: readString(getConfig('email.passwordRef')),
    smtpPasswordRef: readString(getConfig('email.smtpPasswordRef')),
    fromAddress: readString(getConfig('email.fromAddress')),
    mailbox: readString(getConfig('email.mailbox')),
    draftsMailbox: readString(getConfig('email.draftsMailbox')),
  };
}

/**
 * Which secret submission authenticates with: the SMTP-specific one when the
 * operator set it, otherwise the mailbox password. Resolved through one helper
 * so `sendMail` and `testConnection` cannot disagree about which credential a
 * send would actually use, a test that passes with the wrong password is worse
 * than no test.
 */
export function smtpPasswordRefFor(config: EmailConfig): string {
  return config.smtpPasswordRef.length > 0 ? config.smtpPasswordRef : config.passwordRef;
}

/**
 * The only secret reference form the resolver below can read: a key in this
 * process's own secret store. Other `goodvibes://secrets/...` forms (env, file)
 * name stores the manager does not look up by reference here, so they are
 * refused up front instead of failing later as a missing secret.
 */
const GOODVIBES_SECRET_PREFIX = 'goodvibes://secrets/goodvibes/';

/**
 * A mail secret reference may only name a key that is about mail: `EMAIL`,
 * `MAIL`, `IMAP` or `SMTP` as an underscore-delimited word of the key. The
 * password is sent as the LOGIN password to whatever host `email.imapHost`
 * names, so a reference to an unrelated secret (a provider API key) would hand
 * that secret to any host a config points at.
 */
const MAIL_KEY_WORD = /(^|_)(EMAIL|MAIL|IMAP|SMTP)(_|$)/i;

function isMailSecretKey(key: string): boolean {
  return MAIL_KEY_WORD.test(key);
}

function notMailKeyMessage(setting: string, key: string): string {
  return `${setting} names '${key}', which is not a mail credential: the key must contain EMAIL, MAIL, IMAP or SMTP as a word (for example GOODVIBES_EMAIL_PASSWORD), so an unrelated secret is never sent to a mail server.`;
}

/**
 * The one reading of a mail secret reference: the store key it names, or the
 * problem with it. Validation reports the problem; `resolveEmailPassword`
 * refuses with it. One function, so the two can never disagree about which
 * references are readable.
 */
export function parseEmailSecretRef(setting: string, ref: string): { readonly key: string } | { readonly problem: string } {
  if (!ref.startsWith('goodvibes://secrets/')) {
    return { problem: `${setting} must be a goodvibes secret reference (goodvibes://secrets/...)` };
  }
  if (!ref.startsWith(GOODVIBES_SECRET_PREFIX) || ref.length === GOODVIBES_SECRET_PREFIX.length) {
    return { problem: `${setting} must name a key in the goodvibes secret store (${GOODVIBES_SECRET_PREFIX}<key>); other secret reference types are not resolved for email` };
  }
  let key: string;
  try { key = decodeURIComponent(ref.slice(GOODVIBES_SECRET_PREFIX.length)); }
  catch { return { problem: `${setting} is not a valid secret reference: the key after ${GOODVIBES_SECRET_PREFIX} has a malformed % escape` }; }
  if (!isMailSecretKey(key)) return { problem: notMailKeyMessage(setting, key) };
  return { key };
}

/** A secret ref problem as a one-line message, or null when the ref can be resolved. */
function secretRefProblem(setting: string, ref: string): string | null {
  const parsed = parseEmailSecretRef(setting, ref);
  return 'problem' in parsed ? parsed.problem : null;
}

function isLoopbackMailHost(host: string): boolean {
  return isLoopbackHost(host);
}

function validateConfiguration(config: EmailConfig, submission: boolean): string[] {
  const errors: string[] = [];
  if (!config.imapHost) errors.push('email.imapHost is required');
  if (config.imapHost && config.imapSecurity === 'plaintext' && !isLoopbackMailHost(config.imapHost)) {
    // The mailbox password is sent as typed; off this machine that is a password on the wire.
    errors.push('email.imapSecurity is plaintext, which is only allowed for a loopback host (localhost, 127.x, ::1); use tls for a remote mail server');
  }
  if (submission && !config.smtpHost) errors.push('email.smtpHost is required');
  if (!config.username) errors.push('email.username is required');
  if (!config.passwordRef) {
    errors.push('email.passwordRef is required (must be a secret reference, not a raw password)');
  } else {
    const problem = secretRefProblem('email.passwordRef', config.passwordRef);
    if (problem) errors.push(problem);
  }
  // Optional: an empty value means "same password as IMAP", which is the common
  // case. A non-empty one is held to the same rule as passwordRef, a raw
  // password here would be a raw password in a settings file.
  if (submission && config.smtpPasswordRef.length > 0) {
    const problem = secretRefProblem('email.smtpPasswordRef', config.smtpPasswordRef);
    if (problem) errors.push(problem);
  }
  if (submission && !config.fromAddress) errors.push('email.fromAddress is required');
  return errors;
}

/** Existing read/send configuration validation remains submission-complete. */
export function validateEmailConfig(config: EmailConfig): string[] {
  return validateConfiguration(config, true);
}

/** Owned read-only inbox acquisition never needs SMTP or an outbound From identity. */
export function validateEmailInboxConfig(config: EmailConfig): string[] {
  return validateConfiguration(config, false);
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/**
 * A mail password that is not where this process reads secrets.
 *
 * Carries the same routable `notice` an `ImapOpenError` does, so a supervisor
 * delivers a missing credential to the owner by the same path it delivers a
 * rejected one. Terminal: nothing about waiting makes a secret appear.
 */
export class EmailCredentialUnavailableError extends Error {
  readonly notice: EmailCapabilityFailureNotice;

  constructor(detail: string) {
    const ownerMessage = ownerMessageForFailure('credential-unavailable', '');
    super(`${ownerMessage} ${detail}`);
    this.name = 'EmailCredentialUnavailableError';
    this.notice = {
      reason: 'credential-unavailable',
      terminal: true,
      mailbox: '',
      ownerMessage,
      serverMessage: detail,
    };
  }
}

/**
 * Resolve the mail password from the secret store this process was given.
 *
 * ONE store is consulted: the one the composition root handed in, which for
 * the daemon is the daemon's own. There is deliberately no fallback to a
 * surface-local store. A credential captured by another surface is not visible
 * here, and reaching for it would produce a capability that works on the
 * machine where it happened to be captured and fails on every other one,
 * which is a far harder failure to diagnose than a missing secret. A secret
 * that is not here is reported as missing, by name, with the step that fixes
 * it.
 */
export async function resolveEmailPassword(
  passwordRef: string,
  secretsManager: { readonly get: (key: string) => Promise<string | null> },
  setting = 'email.passwordRef',
): Promise<string> {
  // The store is asked for a KEY; it never parses references, so a reference of
  // any other form could only ever be reported as a missing secret.
  const parsed = parseEmailSecretRef(setting, passwordRef);
  if ('problem' in parsed) throw new EmailCredentialUnavailableError(`${parsed.problem}.`);
  const key = parsed.key;
  const value = await secretsManager.get(key);
  if (!value) {
    throw new EmailCredentialUnavailableError(
      `${setting} names '${key}', and no secret by that name was found.`,
    );
  }
  return value;
}

