/**
 * The one builder of an outgoing plain-text message.
 *
 * A draft saved over IMAP and a message sent over SMTP are the same message on
 * the wire: same header encoding, same declared body encoding. Both paths call
 * `composePlainTextMessage`; the SMTP client adds only its Message-ID and the
 * DATA dot-stuffing, the draft builder adds neither.
 *
 * Field validation (control characters, bare addresses) stays with the callers,
 * which refuse before anything is composed.
 */

const CRLF = '\r\n';

const RFC5322_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC5322_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** `Mon, 27 Jul 2026 14:03:05 +0000`, RFC 5322 §3.3, always in UTC. */
export function formatRfc5322Date(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = RFC5322_DAYS[date.getUTCDay()] ?? 'Mon';
  const month = RFC5322_MONTHS[date.getUTCMonth()] ?? 'Jan';
  return (
    `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** Bytes of UTF-8 per encoded-word, chosen so each folded line stays under 76. */
const ENCODED_WORD_BYTE_BUDGET = 45;

/**
 * Encode a header value as RFC 2047 encoded-words when it is not plain ASCII.
 *
 * A subject in any language other than English is the ordinary case, not an
 * edge one, and mail clients read `=?UTF-8?B?..?=` everywhere while raw UTF-8
 * in a header is only understood by servers that announce RFC 6532 support.
 * Long values are split on character boundaries and folded, because an
 * encoded-word longer than 75 characters is not one.
 */
export function encodeHeaderValue(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value;

  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const char of value) {
    const width = Buffer.byteLength(char, 'utf8');
    if (chunkBytes + width > ENCODED_WORD_BYTE_BUDGET && chunk.length > 0) {
      words.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += width;
  }
  if (chunk.length > 0) words.push(chunk);

  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`)
    .join(`${CRLF} `);
}

/** RFC 5322 §2.1.1: no line may exceed 998 octets before its CRLF. */
const MAX_LINE_OCTETS = 998;
/** RFC 2045 §6.7: an encoded line is at most 76 characters, soft break included. */
const QP_LINE_LIMIT = 76;

function hexByte(byte: number): string {
  return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Quoted-printable for one line of UTF-8 text (no line break in `line`). */
function quotedPrintableLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    const last = i === bytes.length - 1;
    const literal =
      (byte >= 33 && byte <= 126 && byte !== 61) ||
      ((byte === 32 || byte === 9) && !last);
    const token = literal ? String.fromCharCode(byte) : hexByte(byte);
    // Leave room for the `=` that marks a soft line break.
    if (current.length + token.length > QP_LINE_LIMIT - 1) {
      out.push(`${current}=`);
      current = '';
    }
    current += token;
  }
  out.push(current);
  return out.join(CRLF);
}

export type BodyTransferEncoding = '7bit' | '8bit' | 'quoted-printable';

export interface PlainTextMessageInput {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string | undefined;
  readonly references?: string | undefined;
  /** Written as `Message-ID` when given; a draft has none until it is sent. */
  readonly messageId?: string | undefined;
}

export interface ComposedMessage {
  /** Header block, blank line and body, CRLF line endings, ending in CRLF. */
  readonly message: string;
  /** What `Content-Transfer-Encoding` declares; `8bit` needs 8BITMIME on SMTP. */
  readonly bodyEncoding: BodyTransferEncoding;
}

/**
 * Compose a text/plain UTF-8 message.
 *
 * The body is sent as written (`7bit` when it is ASCII, `8bit` when it is not),
 * so what the recipient or the owner later reads is exactly the text handed in.
 * It falls back to quoted-printable when a line is longer than the 998 octets
 * a message line may be, or when the receiver cannot take 8-bit data
 * (`eightBitAllowed: false`, an SMTP server without 8BITMIME).
 */
export function composePlainTextMessage(
  input: PlainTextMessageInput,
  now: Date,
  options: { readonly eightBitAllowed?: boolean } = {},
): ComposedMessage {
  const headers = [
    `Date: ${formatRfc5322Date(now)}`,
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
  ];
  const inReplyTo = input.inReplyTo?.trim() ?? '';
  if (inReplyTo.length > 0) headers.push(`In-Reply-To: ${inReplyTo}`);
  const references = input.references?.trim() ?? '';
  if (references.length > 0) headers.push(`References: ${references}`);
  if (input.messageId !== undefined) headers.push(`Message-ID: ${input.messageId}`);

  const lines = input.body.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const ascii = !/[^\x00-\x7f]/.test(input.body);
  const longLine = lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_LINE_OCTETS);
  const bodyEncoding: BodyTransferEncoding = longLine || (!ascii && options.eightBitAllowed === false)
    ? 'quoted-printable'
    : ascii ? '7bit' : '8bit';
  const bodyLines = bodyEncoding === 'quoted-printable' ? lines.map(quotedPrintableLine) : lines;

  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset=utf-8');
  headers.push(`Content-Transfer-Encoding: ${bodyEncoding}`);

  return {
    message: `${headers.join(CRLF)}${CRLF}${CRLF}${bodyLines.join(CRLF)}${CRLF}`,
    bodyEncoding,
  };
}
