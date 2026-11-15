/**
 * Minimal SMTP submission client over an injectable transport socket.
 *
 * Scope and honest boundaries
 * ────────────────────────────
 * Supported:
 *   - EHLO negotiation
 *   - AUTH PLAIN and AUTH LOGIN
 *   - MAIL FROM / RCPT TO / DATA with RFC 2821 dot-stuffing
 *   - A generated RFC 5322 `Message-ID` on every send, returned to the caller
 *     along with the moment the server accepted the message
 *   - QUIT
 *   - TLS-direct (port 465) via `createSmtpTlsSocket()`
 *   - STARTTLS upgrade (port 587) via `createSmtpStartTlsSocket()`
 *
 * Not supported (document boundaries):
 *   - HTML, MIME multipart, attachments
 *   - Multiple recipients in a single session (call sendMail per recipient)
 *   - DSN / delivery-status-notification extensions
 *   - PIPELINING (all commands are sent sequentially and await a reply)
 *   - Credentials are never logged, and no error carries a credential line
 *
 * Transport injection
 * ────────────────────
 * The `socket` parameter accepts any net.Socket so that unit tests can supply
 * a plain in-process fake socket instead of a real TLS connection. Both socket
 * factories named above live in the sibling `email/node` entry, so importing
 * this module never opens a connection or pulls `node:tls` in behind it.
 */

import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { assertDeliveryCurrent, runDeliveryPublication, type DeliveryLifetime } from '../utils/delivery-lifetime.js';
import { composePlainTextMessage } from './message-compose.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SmtpClientOptions {
  readonly socket: Socket;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
}

export interface SmtpSendOptions extends DeliveryLifetime {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Message-ID of the message this one answers; written as `In-Reply-To`. */
  readonly inReplyTo?: string | undefined;
  /** The thread's Message-ID chain; written as `References`. */
  readonly references?: string | undefined;
  /** Left half of the Message-ID, so a repeated send carries the same id; generated when absent. */
  readonly messageIdLocalPart?: string | undefined;
}

/**
 * The message bytes were written and the server's final reply never arrived
 * (timeout, abort, dropped connection). The server may have accepted and queued
 * the mail, so the outcome is unknown: the caller must not resend it
 * automatically, and should check the Sent folder or ask the owner first.
 */
export class SmtpDeliveryUnconfirmedError extends Error {
  readonly retryable = false;
  override readonly cause: unknown;
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `The mail server did not confirm the message (${reason}). It may already have been delivered, so it was not sent again; check the Sent folder before resending.`,
    );
    this.name = 'SmtpDeliveryUnconfirmedError';
    this.cause = cause;
  }
}

/** What a completed send is afterwards identifiable by. */
export interface SmtpSendResult {
  /**
   * The `Message-ID` header this send actually carried, angle brackets
   * included. It is generated here, written into the message, and handed back
   *, the same string on the wire and in the return value, because its whole
   * purpose is to correlate with what left the machine and with the
   * `In-Reply-To` of whatever comes back.
   */
  readonly messageId: string;
  /**
   * ISO-8601 instant the server ACCEPTED the message, read after the final
   * `250`, not when the attempt started, so it records a send that happened
   * rather than one that was tried.
   */
  readonly sentAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Per-operation timeout, and the connect timeout used by the node adapter. */
export const SMTP_DEFAULT_TIMEOUT_MS = 15_000;
const CRLF = '\r\n';

// ---------------------------------------------------------------------------
// Input validation: SMTP header/command injection prevention
// ---------------------------------------------------------------------------

/** Control-character pattern: CR, LF, and the other C0 and C1 control characters. */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Validate a single SMTP envelope address (MAIL FROM / RCPT TO value).
 * Rejects: control characters (\r, \n, any C0 or C1), spaces, angle brackets,
 * comma-separated lists. Only a single bare address is accepted.
 *
 * @throws Error with a plain-language message on invalid input.
 */
export function validateSmtpAddress(address: string, field: string): void {
  if (CONTROL_CHAR_RE.test(address)) {
    throw new Error(
      `Invalid ${field}: address must not contain control characters (CR, LF, etc.).`,
    );
  }
  if (address.includes(' ') || address.includes('\t')) {
    throw new Error(
      `Invalid ${field}: address must be a single bare address with no spaces or tabs.`,
    );
  }
  if (address.includes('<') || address.includes('>')) {
    throw new Error(
      `Invalid ${field}: address must be a single bare address without angle brackets.`,
    );
  }
  if (address.includes(',')) {
    throw new Error(
      `Invalid ${field}: only one address is allowed per field (no comma-separated lists).`,
    );
  }
  if (!address.includes('@')) {
    throw new Error(
      `Invalid ${field}: "${address}" does not look like an email address (missing @).`,
    );
  }
}

/**
 * Validate an SMTP message Subject header value.
 * Rejects control characters (\r, \n, etc.) that could split headers.
 *
 * @throws Error with a plain-language message on invalid input.
 */
export function validateSmtpSubject(subject: string): void {
  if (CONTROL_CHAR_RE.test(subject)) {
    throw new Error(
      'Invalid subject: subject must not contain control characters (CR, LF, etc.).',
    );
  }
}

/**
 * Validate a threading header value (`In-Reply-To`, `References`). Same rule as
 * the subject: a control character would end the header and start another.
 */
export function validateSmtpThreadHeader(value: string, field: 'inReplyTo' | 'references'): void {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(
      `Invalid ${field}: ${field} must not contain control characters (CR, LF, etc.).`,
    );
  }
}

function dotStuff(message: string): string {
  // RFC 5321 §4.5.2: lines beginning with '.' get an extra '.'
  return message
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

function base64(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64');
}

/**
 * Build an RFC 5322 §3.6.4 message id: a value unlikely to repeat, at the
 * domain that is doing the sending.
 *
 * The domain half has to be the sending domain. A literal like `localhost`, or
 * a domain that does not exist, is a signal receiving servers weigh against a
 * message, an id is supposed to be globally unique BECAUSE its right-hand
 * side belongs to whoever wrote it. The from-address supplies it; the SMTP
 * hostname stands in only if the address somehow carries none.
 */
const MESSAGE_ID_LOCAL_PART = /^[A-Za-z0-9._-]{8,160}$/;

function generateMessageId(fromAddress: string, smtpHostname: string, localPart?: string): string {
  const at = fromAddress.lastIndexOf('@');
  const fromDomain = at === -1 ? '' : fromAddress.slice(at + 1).trim();
  const domain = fromDomain.length > 0 ? fromDomain : smtpHostname;
  if (localPart !== undefined && !MESSAGE_ID_LOCAL_PART.test(localPart)) {
    throw new Error('A chosen Message-ID must be 8 to 160 letters, digits, dots, underscores or hyphens.');
  }
  const unique = localPart ?? `${Date.now().toString(36)}.${randomBytes(12).toString('hex')}`;
  return `<${unique}@${domain}>`;
}

// ---------------------------------------------------------------------------
// SMTP session
// ---------------------------------------------------------------------------

class SmtpSession {
  private readonly socket: Socket;
  private readonly timeoutMs: number;
  private buffer = '';

  constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.socket.setEncoding('utf8');
  }

  /** Read lines until a final SMTP response (no continuation dash). */
  async readResponse(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];

    return new Promise<{ code: number; lines: string[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('SMTP read timeout'));
      }, this.timeoutMs);

      const tryFlush = (): void => {
        let pos: number;
        while ((pos = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, pos).replace(/\r$/, '');
          this.buffer = this.buffer.slice(pos + 1);
          lines.push(line);

          // SMTP responses: XYZ-text (continuation) vs XYZ text (final)
          const match = /^(\d{3})([- ])/.exec(line);
          if (match && match[2] !== '-') {
            cleanup();
            const code = parseInt(match[1] ?? '0', 10);
            resolve({ code, lines });
            return;
          }
        }
      };

      const onData = (chunk: string): void => {
        this.buffer += chunk;
        tryFlush();
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onClose = (): void => {
        cleanup();
        reject(new Error('SMTP connection closed unexpectedly'));
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.off('data', onData);
        this.socket.off('error', onError);
        this.socket.off('close', onClose);
      };

      this.socket.on('data', onData);
      this.socket.on('error', onError);
      this.socket.on('close', onClose);

      // Flush already-buffered data
      if (this.buffer.length > 0) {
        tryFlush();
      }
    });
  }

  async send(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket.write(`${line}${CRLF}`, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async sendRaw(data: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket.write(data, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Send a command and assert the response code. Throws on failure.
   *
   * The error names the command by `label`, never by the line: during AUTH the
   * line is the encoded user name or password, and the error reaches tool
   * output, transcripts and logs.
   */
  async cmd(line: string, expectCode: number, label: string): Promise<{ code: number; lines: string[] }> {
    await this.send(line);
    const resp = await this.readResponse();
    if (resp.code !== expectCode) {
      throw new Error(`SMTP ${label} failed: ${resp.lines.join(' | ')}`);
    }
    return resp;
  }

  destroy(): void {
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

export class SmtpClient {
  private readonly options: SmtpClientOptions;

  constructor(options: SmtpClientOptions) {
    this.options = options;
  }

  /**
   * Connect, negotiate EHLO, and authenticate, then QUIT without sending any
   * mail. Used to verify SMTP credentials/host reachability (a connect-wizard
   * "test connection" step) without the side effect of an actual send.
   * Throws with a plain-language message on any failure stage.
   */
  async verifyAuth(): Promise<void> {
    const { hostname, username, password } = this.options;
    const timeoutMs = this.options.timeoutMs ?? SMTP_DEFAULT_TIMEOUT_MS;
    const session = new SmtpSession(this.options.socket, timeoutMs);
    try {
      const { capabilities } = await this.greetAndEhlo(session, hostname);
      await this.authenticate(session, capabilities, username, password);
      await session.send('QUIT');
    } finally {
      session.destroy();
    }
  }

  /**
   * Send a plain-text email.
   * Callers must ensure the caller-side confirms the send before calling this.
   *
   * Returns the `Message-ID` the message actually carried and the instant the
   * server accepted it. Nothing about either value is invented after the fact:
   * the id is written into the headers that go out, and the timestamp is read
   * once the final `250` has arrived.
   */
  async sendMail(opts: SmtpSendOptions): Promise<SmtpSendResult> {
    assertDeliveryCurrent(opts);
    const { hostname, username, password } = this.options;
    const timeoutMs = this.options.timeoutMs ?? SMTP_DEFAULT_TIMEOUT_MS;
    const session = new SmtpSession(this.options.socket, timeoutMs);
    const abort = () => session.destroy();
    opts.signal?.addEventListener('abort', abort, { once: true });
    try {
      const { capabilities } = await this.greetAndEhlo(session, hostname, opts);

      // AUTH
      await this.authenticate(session, capabilities, username, password, opts);

      // Validate envelope fields before writing to the protocol stream (injection prevention)
      validateSmtpAddress(opts.from, 'from');
      validateSmtpAddress(opts.to, 'to');
      validateSmtpSubject(opts.subject);
      if (opts.inReplyTo !== undefined) validateSmtpThreadHeader(opts.inReplyTo, 'inReplyTo');
      if (opts.references !== undefined) validateSmtpThreadHeader(opts.references, 'references');

      // The same builder as a saved draft, so the sent copy reads as the draft did.
      const messageId = generateMessageId(opts.from, hostname, opts.messageIdLocalPart);
      const eightBitAllowed = capabilities.includes('8BITMIME');
      const composed = composePlainTextMessage({ ...opts, messageId }, new Date(), { eightBitAllowed });
      const message = `${dotStuff(composed.message)}.${CRLF}`;
      const bodyParameter = composed.bodyEncoding === '8bit' ? ' BODY=8BITMIME' : '';

      const result = await runDeliveryPublication(opts, async current => {
        // Authentication is preparation; only the message transaction retains publication ownership.
        current(); await session.cmd(`MAIL FROM:<${opts.from}>${bodyParameter}`, 250, 'MAIL FROM');
        current(); await session.cmd(`RCPT TO:<${opts.to}>`, 250, 'RCPT TO');
        current(); await session.cmd('DATA', 354, 'DATA');
        current(); await session.sendRaw(message);
        // From here the server may have accepted the message, so a failed wait
        // is an unknown outcome rather than a failed send.
        let dataResp: { code: number; lines: string[] };
        try {
          dataResp = await session.readResponse();
        } catch (error) {
          throw new SmtpDeliveryUnconfirmedError(error);
        }
        if (dataResp.code !== 250) throw new Error(`SMTP DATA rejected: ${dataResp.lines.join(' | ')}`);
        // The final response proves the server accepted this message.
        return { messageId, sentAt: new Date().toISOString() };
      });

      // QUIT
      await session.send('QUIT').catch(() => {});
      return result;
    } finally {
      opts.signal?.removeEventListener('abort', abort);
      session.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Read the server greeting and negotiate EHLO. Shared by sendMail and verifyAuth. */
  private async greetAndEhlo(
    session: SmtpSession,
    hostname: string,
    lifetime: DeliveryLifetime = {},
  ): Promise<{ capabilities: readonly string[] }> {
    const greeting = await session.readResponse();
    if (greeting.code !== 220) {
      throw new Error(`SMTP unexpected greeting: ${greeting.lines.join(' | ')}`);
    }
    assertDeliveryCurrent(lifetime);
    const ehlo = await session.cmd(`EHLO ${hostname}`, 250, 'EHLO');
    return { capabilities: ehlo.lines.map((l) => l.slice(4).trim().toUpperCase()) };
  }

  private async authenticate(
    session: SmtpSession,
    capabilities: readonly string[],
    username: string,
    password: string,
    lifetime: DeliveryLifetime = {},
  ): Promise<void> {
    const hasPlain = capabilities.some((c) => c.includes('AUTH') && c.includes('PLAIN'));
    const hasLogin = capabilities.some((c) => c.includes('AUTH') && c.includes('LOGIN'));

    if (hasPlain) {
      // AUTH PLAIN: base64(\x00username\x00password)
      const token = base64(`\x00${username}\x00${password}`);
      assertDeliveryCurrent(lifetime); await session.cmd(`AUTH PLAIN ${token}`, 235, 'AUTH PLAIN');
    } else if (hasLogin) {
      // AUTH LOGIN: two-step base64 exchange
      assertDeliveryCurrent(lifetime); await session.cmd('AUTH LOGIN', 334, 'AUTH LOGIN');
      assertDeliveryCurrent(lifetime); await session.cmd(base64(username), 334, 'AUTH LOGIN (user name)');
      assertDeliveryCurrent(lifetime); await session.cmd(base64(password), 235, 'AUTH LOGIN (password)');
    } else {
      throw new Error('SMTP server does not advertise AUTH PLAIN or AUTH LOGIN');
    }
  }
}
