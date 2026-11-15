// ---------------------------------------------------------------------------
// Triage tagger, IMAP provider.
//
// A label is an IMAP keyword. It is written through the mail module's client
// (`ImapClient.addKeywords`): one connection, sign in, EXAMINE, SELECT with the
// UIDVALIDITY the message was listed under, every keyword in one `UID STORE`,
// LOGOUT. Credentials are resolved by the caller per write and are never logged
// or returned. A connection that could not be made or opened is retried with a
// bounded backoff; a refusal from the server is not.
// ---------------------------------------------------------------------------

import type { Socket } from 'node:net';
import { ImapClient, ImapOpenError, imapQuoteCredential } from '../../../email/imap-client.js';
import { formatMailboxName } from '../../../email/imap-names.js';
import { createImapTlsSocket } from '../../../email/node.js';

export interface ImapStoreArgs {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  uid: string;
  flag: string;
  /** Every keyword for this message, set in one STORE on one connection; `flag` alone when absent. */
  flags?: readonly string[];
  uidValidity: number;
  signal: AbortSignal;
  assertCurrent(): void;
}

export interface ImapRetryOptions {
  /** Total attempts including the first (default 3). Values < 1 disable retry. */
  maxAttempts?: number;
  /** Base backoff in ms for the first retry (default 250). */
  baseDelayMs?: number;
  /** Cap on any single backoff delay in ms (default 2000). */
  maxDelayMs?: number;
  /** Injectable sleep (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export type ImapStoreFlag = (args: ImapStoreArgs) => Promise<void>;

/** Opens the connected socket the mail client runs on; production is direct TLS. */
export type ImapSocketConnect = (host: string, port: number) => Promise<Socket>;

/**
 * A label write that did not happen, and whether trying again can help (the
 * server could not be reached or opened) or not (the server refused, the
 * target is invalid, or the mailbox changed).
 */
export class ImapStoreError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'ImapStoreError';
    this.transient = transient;
  }
}

const describe = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.length > 0 ? error.message : fallback;

/** Write every keyword for one message through the mail module's IMAP client. */
export function imapStoreFlagWithMailClient(connect: ImapSocketConnect = createImapTlsSocket): ImapStoreFlag {
  return async (args) => {
    const flags = args.flags ?? [args.flag];
    const uid = Number(args.uid);
    // Everything the command lines carry is checked before a socket exists.
    try {
      if (!/^[1-9][0-9]*$/.test(args.uid) || !Number.isSafeInteger(uid)) throw new Error('The mail label target is not one message UID.');
      if (!Number.isSafeInteger(args.uidValidity) || args.uidValidity < 1) throw new Error('The mail label target has no mailbox generation.');
      imapQuoteCredential(args.user, 'username');
      if (!args.password.startsWith('Bearer ')) imapQuoteCredential(args.password, 'password');
      formatMailboxName(args.mailbox);
    } catch (error) {
      throw new ImapStoreError(describe(error, 'The mail label target is invalid.'), false);
    }
    args.signal.throwIfAborted(); args.assertCurrent();
    let socket: Socket;
    try { socket = await connect(args.host, args.port); }
    catch { throw new ImapStoreError(`The mail server ${args.host}:${args.port} could not be reached.`, true); }
    const ignoreSocketError = (): void => {};
    socket.on('error', ignoreSocketError);
    const client = new ImapClient({ socket, username: args.user, password: args.password, mailbox: args.mailbox,
      signal: args.signal, assertCurrent: args.assertCurrent });
    try {
      try { await client.open(); }
      catch (error) {
        throw new ImapStoreError(describe(error, 'The mailbox could not be opened.'), error instanceof ImapOpenError ? !error.terminal : true);
      }
      try { await client.addKeywords(uid, args.uidValidity, flags); }
      catch (error) { throw new ImapStoreError(describe(error, 'The label was not written.'), false); }
      args.assertCurrent();
      // The keywords are on the message; a LOGOUT the server drops changes nothing.
      await client.logout().catch(() => {});
    } finally {
      client.close();
      socket.off('error', ignoreSocketError);
    }
  };
}

/** True when an error is worth retrying (network/connection, not protocol). */
function isTransientImapError(error: unknown): boolean {
  if (error instanceof ImapStoreError) return error.transient;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') {
    return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']
      .includes(code);
  }
  return false;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

/**
 * Wrap an IMAP store function with bounded exponential-backoff retry on
 * transient failures only. Adding a keyword twice is harmless, so a retry
 * after a dropped connection cannot double an effect.
 */
export function makeRetryingImapStoreFlag(
  inner: ImapStoreFlag,
  retry: ImapRetryOptions = {},
): ImapStoreFlag {
  const maxAttempts = Number.isFinite(retry.maxAttempts ?? 3) ? Math.min(5, Math.max(1, Math.floor(retry.maxAttempts ?? 3))) : 3;
  const baseDelayMs = Number.isFinite(retry.baseDelayMs ?? 250) ? Math.min(2_000, Math.max(0, retry.baseDelayMs ?? 250)) : 250;
  const maxDelayMs = Number.isFinite(retry.maxDelayMs ?? 2_000) ? Math.min(2_000, Math.max(baseDelayMs, retry.maxDelayMs ?? 2_000)) : 2_000;
  const sleep = retry.sleep ?? defaultSleep;

  return async (args: ImapStoreArgs): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        args.signal.throwIfAborted(); args.assertCurrent();
        await inner(args);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !isTransientImapError(error)) throw error;
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleep(delay);
      }
    }
    throw lastError;
  };
}
