/**
 * The one owned IMAP session: sign in, EXAMINE the configured mailbox, run the
 * caller's commands, and LOGOUT only after they succeeded. Listing, reading,
 * saving a draft and the connection test all go through it, so every path
 * closes its socket the same way and none sends LOGOUT onto a failed command.
 */
import { ImapClient } from './imap-client.js';
import { imapSocketFactoryFor, resolveEmailPassword } from './email-config.js';
import type { EmailConfig, EmailServiceDeps } from './email-service.js';
import type { EmailReplySubjectRead } from './reply-subject-source.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export async function withEmailReadConnection<T>(
  deps: EmailServiceDeps,
  config: EmailConfig,
  sourceRead: EmailReplySubjectRead | undefined,
  signal: AbortSignal | undefined,
  read: (client: ImapClient, assertCurrent: () => void) => Promise<T>,
  options: {
    readonly maxLiteralBytes?: number;
    /**
     * The commands change the mailbox (save a draft, move a message). Once they
     * returned, their result is the receipt: a currentness check or LOGOUT that
     * fails afterwards is logged and the result is still returned, because the
     * server already acted and a failure here would invite a second save.
     */
    readonly effect?: boolean;
  } = {},
): Promise<T> {
  const signals = [signal, sourceRead?.signal].filter((value): value is AbortSignal => value !== undefined);
  const lifetime = AbortSignal.any(signals);
  const current = (): void => {
    if (lifetime.aborted) throw new Error('Mail read was cancelled.');
    sourceRead?.assertCurrent();
  };
  current();
  // These ports may not support abort. Await their real settlement, then refuse
  // admission and destroy any late socket. Never race and detach owned work.
  const password = await resolveEmailPassword(config.passwordRef, deps.secretsManager);
  current();
  const connect = deps.imapSocketFactory ?? imapSocketFactoryFor(deps.transport, config.imapSecurity);
  const socket = await connect(config.imapHost, config.imapPort);
  let client: ImapClient | undefined;
  const swallowSocketError = (): void => {};
  socket.on('error', swallowSocketError);
  const closed = socket.closed === true ? Promise.resolve() : new Promise<void>((resolve) => socket.once('close', resolve));
  const abort = (): void => { if (client) client.close(); else socket.destroy(); };
  lifetime.addEventListener('abort', abort, { once: true });
  try {
    current();
    client = new ImapClient({ socket, username: config.username, password, signal: lifetime, assertCurrent: current,
      ...(config.mailbox.length > 0 ? { mailbox: config.mailbox } : {}),
      ...(options.maxLiteralBytes === undefined ? {} : { maxLiteralBytes: options.maxLiteralBytes }) });
    await client.open();
    current();
    sourceRead?.observeMailbox(client.mailbox, client.mailboxStatus?.uidValidity ?? null);
    const result = await read(client, current);
    if (options.effect === true) {
      try {
        current();
        await client.logout();
      } catch (error) {
        logger.warn('[email] the mailbox change was made; signing out afterwards failed', { error: summarizeError(error) });
      }
      return result;
    }
    current();
    await client.logout();
    current();
    return result;
  } finally {
    lifetime.removeEventListener('abort', abort);
    // Failure/cancellation does not issue a new LOGOUT onto a stuck command.
    if (client) client.close(); else socket.destroy();
    await closed;
    socket.off('error', swallowSocketError);
  }
}
