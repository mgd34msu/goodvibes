/**
 * Reading one whole message: BODYSTRUCTURE, MIME part selection, and decoding.
 *
 * Why a structure parser at all
 * ─────────────────────────────
 * `ImapClient.fetchMessage` returns the text of a message and a LIST of its
 * attachments, never their bytes. That distinction is the reason this file
 * exists: the server describes every part of a message in its BODYSTRUCTURE
 * reply (type, subtype, encoding, size, filename), so a client can report what
 * is attached, and then fetch ONLY the sections it wants to read. Fetching
 * `BODY[]` would have been three lines of code and would have pulled every
 * attachment, a scanned PDF, an archive, whatever a stranger chose to send,
 * down the wire and into memory on every read.
 *
 * Everything here is text in, data out: no socket, no clock, no filesystem.
 *
 * Defensive by construction
 * ─────────────────────────
 * Every function in this file takes attacker-authored input, because a message
 * body and its structure are written by whoever sent the mail. Nothing throws:
 * a malformed structure yields no parts (and therefore no attachments), an
 * unterminated string yields what was readable, and nesting is bounded. The
 * caller's contract, empty rather than an exception, depends on that holding
 * for every input, not for the inputs we thought of.
 */

import { type ImapFetchFrame, parseFetchResponses, fetchSection } from './imap-fetch-response.js';
import type { ImapAttachmentInfo } from './imap-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One leaf MIME part, as the server described it in BODYSTRUCTURE. */
export interface ImapBodyPart {
  /** IMAP section specifier, e.g. `1`, `2`, `1.2`, what BODY.PEEK[..] takes. */
  readonly section: string;
  /** Lowercased MIME type, e.g. `text`. */
  readonly type: string;
  /** Lowercased MIME subtype, e.g. `plain`. */
  readonly subtype: string;
  /** Lowercased content-transfer-encoding, e.g. `base64`. '' when unstated. */
  readonly encoding: string;
  /** Lowercased charset parameter. '' when unstated. */
  readonly charset: string;
  /** Filename from the disposition, or the content-type `name`. '' when none. */
  readonly filename: string;
  /** Size in bytes as the server reported it. 0 when unstated. */
  readonly sizeBytes: number;
  /**
   * True when this part is something the reader should be TOLD about rather
   * than shown: an explicit `attachment` disposition, a filename, or any
   * non-text type. The two body parts are chosen from what is left.
   */
  readonly isAttachment: boolean;
}

// ---------------------------------------------------------------------------
// S-expression reading
// ---------------------------------------------------------------------------

/** A parsed IMAP S-expression node: string, NIL (null), or a nested list. */
export type ImapBodyStructureNode = string | number | null | ImapBodyStructureNode[];
type SNode = ImapBodyStructureNode;

interface StrictParseState { valid: boolean; nodes: number }

/** Bounds adversarial nesting; real messages are a handful of levels deep. */
const MAX_NESTING_DEPTH = 24;
/** Bounds a single parse so a huge structure cannot pin a CPU. */
const MAX_STRUCTURE_CHARS = 200_000;

function readQuoted(text: string, from: number): { value: string; next: number } {
  let out = '';
  let i = from + 1; // skip opening quote
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '\\' && i + 1 < text.length) {
      out += text.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === '"') return { value: out, next: i + 1 };
    out += ch;
    i += 1;
  }
  return { value: out, next: i }; // unterminated, take what we read
}

function readAtom(text: string, from: number): { value: string; next: number } {
  let i = from;
  while (i < text.length && !' \t\r\n()"'.includes(text.charAt(i))) i += 1;
  return { value: text.slice(from, i), next: i };
}

/** `{n}` followed by n characters. Byte/character drift is tolerated. */
function readLiteral(text: string, from: number): { value: string; next: number } | null {
  const close = text.indexOf('}', from);
  if (close === -1) return null;
  const count = parseInt(text.slice(from + 1, close), 10);
  if (!isFinite(count) || count < 0) return null;
  let start = close + 1;
  if (text.startsWith('\r\n', start)) start += 2;
  else if (text.startsWith('\n', start)) start += 1;
  return { value: text.slice(start, start + count), next: start + count };
}

/** Scan past a list without parsing it, honouring quoted strings. */
function skipList(text: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    const ch = text.charAt(i);
    if (ch === '"') {
      i = readQuoted(text, i).next;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    i += 1;
  }
  return i;
}

function parseList(text: string, from: number, depth: number, strict?: StrictParseState): { items: SNode[]; next: number } {
  const items: SNode[] = [];
  let i = from;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === ')') return { items, next: i + 1 };
    if (strict !== undefined && i > from && !/[\s(]/.test(text.charAt(i - 1))
      && !(text.charAt(i - 1) === ')' && ch === '(')) strict.valid = false;
    if (strict !== undefined && ++strict.nodes > 10_000) {
      strict.valid = false;
      return { items, next: text.length };
    }
    if (ch === '(') {
      if (depth >= MAX_NESTING_DEPTH) {
        if (strict !== undefined) strict.valid = false;
        i = skipList(text, i + 1);
        continue;
      }
      const inner = parseList(text, i + 1, depth + 1, strict);
      items.push(inner.items);
      i = inner.next;
      continue;
    }
    if (ch === '"') {
      const quoted = readQuoted(text, i);
      if (strict !== undefined) {
        const token = text.slice(i, quoted.next);
        if (!/^"(?:[^"\\\r\n\u0000-\u001f]|\\["\\])*"$/.test(token)
          || /\ufffd/.test(quoted.value)) strict.valid = false;
      }
      items.push(quoted.value);
      i = quoted.next;
      continue;
    }
    if (ch === '{') {
      // A strict read does not reinterpret byte-counted structure literals as
      // character-counted text. Unsupported literal syntax is explicitly refused.
      if (strict !== undefined) strict.valid = false;
      const literal = readLiteral(text, i);
      if (literal !== null) {
        items.push(literal.value);
        i = literal.next;
        continue;
      }
    }
    const atom = readAtom(text, i);
    if (atom.next === i) {
      i += 1; // no progress possible on this character, step over it
      continue;
    }
    if (strict !== undefined && !/^(?:NIL|[0-9]+)$/i.test(atom.value)) strict.valid = false;
    items.push(/^nil$/i.test(atom.value) ? null
      : strict !== undefined && /^[0-9]+$/.test(atom.value) ? Number(atom.value) : atom.value);
    i = atom.next;
  }
  if (strict !== undefined) strict.valid = false; // unterminated list
  return { items, next: i };
}

/** The same bounded parser, with omissions and malformed syntax refused. */
export function parseCompleteBodyStructureNodes(raw: string): ImapBodyStructureNode[] | null {
  if (raw.length === 0 || raw.length > MAX_STRUCTURE_CHARS || raw.charAt(0) !== '(') return null;
  const strict: StrictParseState = { valid: true, nodes: 0 };
  const parsed = parseList(raw, 1, 1, strict);
  return strict.valid && parsed.next === raw.length ? parsed.items : null;
}

// ---------------------------------------------------------------------------
// BODYSTRUCTURE → parts
// ---------------------------------------------------------------------------

function asText(node: SNode | undefined): string {
  return typeof node === 'string' ? node : '';
}

function asList(node: SNode | undefined): SNode[] {
  return Array.isArray(node) ? node : [];
}

/** Read `("key" "value" "key" "value")` parameter lists case-insensitively. */
function paramValue(params: SNode[], wanted: string): string {
  for (let i = 0; i + 1 < params.length; i += 2) {
    if (asText(params[i]).toLowerCase() === wanted) return asText(params[i + 1]);
  }
  return extendedParamValue(params, wanted);
}

/** A parameter name in its RFC 2231 forms: `name*`, `name*0`, `name*0*`. */
const EXTENDED_PARAM = /^([^*]+)\*(?:(\d{1,3})(\*)?)?$/;

/**
 * An RFC 2231 extended parameter (`filename*=utf-8''R%C3%A9sum%C3%A9.pdf`,
 * or one split into `filename*0*`, `filename*1*`, ...), decoded for display.
 * Names in other languages and long names arrive this way. '' when absent or
 * when the charset cannot be decoded.
 */
function extendedParamValue(params: SNode[], wanted: string): string {
  const segments = new Map<number, { readonly text: string; readonly encoded: boolean }>();
  for (let i = 0; i + 1 < params.length; i += 2) {
    const match = EXTENDED_PARAM.exec(asText(params[i]).toLowerCase());
    if (match === null || match[1] !== wanted) continue;
    const index = match[2] === undefined ? 0 : Number(match[2]);
    const encoded = match[2] === undefined || match[3] === '*';
    if (!segments.has(index)) segments.set(index, { text: asText(params[i + 1]), encoded });
  }
  if (segments.size === 0) return '';
  let charset = '';
  const bytes: number[] = [];
  for (let index = 0; segments.has(index); index += 1) {
    const segment = segments.get(index)!;
    let text = segment.text;
    if (index === 0 && segment.encoded) {
      const parts = text.split("'");
      if (parts.length < 3) return '';
      charset = (parts[0] ?? '').toLowerCase();
      text = parts.slice(2).join("'");
    }
    if (!segment.encoded) { for (const byte of Buffer.from(text, 'utf8')) bytes.push(byte); continue; }
    for (let at = 0; at < text.length; at += 1) {
      const ch = text.charAt(at);
      const hex = text.slice(at + 1, at + 3);
      if (ch === '%' && /^[0-9a-f]{2}$/i.test(hex)) { bytes.push(parseInt(hex, 16)); at += 2; continue; }
      for (const byte of Buffer.from(ch, 'utf8')) bytes.push(byte);
    }
  }
  const decoder = charset === '' || /^(?:utf-?8|us-ascii|ascii)$/.test(charset) ? new TextDecoder('utf-8') : legacyCharsetDecoder(charset);
  return decoder === null ? '' : decoder.decode(Buffer.from(bytes));
}

/**
 * Find the content-disposition list without depending on where it sits.
 *
 * Its index differs by type, a text part carries an extra line count, a
 * message/rfc822 part carries an envelope and a nested body, and getting that
 * arithmetic wrong silently mislabels attachments. Instead we look for the
 * shape a disposition has: a two-element list whose head is `attachment` or
 * `inline`.
 */
function findDisposition(node: SNode[]): { value: string; params: SNode[] } {
  for (const item of node) {
    if (!Array.isArray(item)) continue;
    const head = asText(item[0]).toLowerCase();
    if (head === 'attachment' || head === 'inline') {
      return { value: head, params: asList(item[1]) };
    }
  }
  return { value: '', params: [] };
}

function leafPart(node: SNode[], section: string): ImapBodyPart {
  const type = asText(node[0]).toLowerCase();
  const subtype = asText(node[1]).toLowerCase();
  const typeParams = asList(node[2]);
  const encoding = asText(node[5]).toLowerCase();
  const size = parseInt(asText(node[6]), 10);
  const disposition = findDisposition(node.slice(7));
  const filename =
    paramValue(disposition.params, 'filename') || paramValue(typeParams, 'name');
  return {
    section,
    type,
    subtype,
    encoding,
    charset: paramValue(typeParams, 'charset').toLowerCase(),
    filename,
    sizeBytes: isFinite(size) && size > 0 ? size : 0,
    isAttachment:
      disposition.value === 'attachment' || filename.length > 0 || type !== 'text',
  };
}

function collectParts(node: SNode[], prefix: string, out: ImapBodyPart[]): void {
  if (out.length >= 200) return; // bound a pathological structure
  if (Array.isArray(node[0])) {
    // Multipart: the leading elements are the child parts, numbered from 1.
    let index = 0;
    for (const child of node) {
      if (!Array.isArray(child)) break;
      index += 1;
      collectParts(child, prefix.length > 0 ? `${prefix}.${index}` : String(index), out);
    }
    return;
  }
  // A leaf. A message with no multipart wrapper is section 1 (RFC 3501 §6.4.5).
  out.push(leafPart(node, prefix.length > 0 ? prefix : '1'));
}

/**
 * Parse a BODYSTRUCTURE expression into its leaf parts.
 * Returns an empty list for anything it cannot read, a caller that gets no
 * parts reports no attachments, which is the honest answer when the server's
 * description of the message was not readable.
 */
export function parseBodyStructure(raw: string): ImapBodyPart[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const text = raw.slice(0, MAX_STRUCTURE_CHARS);
  const open = text.indexOf('(');
  if (open === -1) return [];
  const parsed = parseList(text, open + 1, 1);
  const parts: ImapBodyPart[] = [];
  collectParts(parsed.items, '', parts);
  return parts;
}

/** The first part that should be shown as the message body, or null. */
export function selectBodyPart(
  parts: readonly ImapBodyPart[],
  subtype: 'plain' | 'html',
): ImapBodyPart | null {
  for (const part of parts) {
    if (part.type === 'text' && part.subtype === subtype && !part.isAttachment) {
      return part;
    }
  }
  return null;
}

/** Attachment metadata, names, types and sizes only, never content. */
export function attachmentsFromParts(
  parts: readonly ImapBodyPart[],
): ImapAttachmentInfo[] {
  const infos: ImapAttachmentInfo[] = [];
  for (const part of parts) {
    if (!part.isAttachment) continue;
    infos.push({
      filename: part.filename,
      contentType: part.type.length > 0 ? `${part.type}/${part.subtype}` : '',
      sizeBytes: part.sizeBytes,
    });
  }
  return infos;
}

// ---------------------------------------------------------------------------
// Transfer decoding
// ---------------------------------------------------------------------------

function decodeQuotedPrintable(raw: string): Buffer {
  const joined = raw.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined.charAt(i);
    if (ch === '=' && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const code = joined.charCodeAt(i);
    // The socket already decoded UTF-8, so a character above 0x7f here came
    // from an 8-bit body; re-encode it rather than truncating it to one byte.
    if (code > 0x7f) {
      for (const byte of Buffer.from(ch, 'utf8')) bytes.push(byte);
      continue;
    }
    bytes.push(code);
  }
  return Buffer.from(bytes);
}

/**
 * A decoder for a charset beyond the built-in ones, when this runtime has a
 * table for it (shift_jis, gbk, euc-kr, big5, ...), else null. Anything the
 * runtime lists as `replacement` is refused: it decodes to a placeholder, not
 * to the text that was sent.
 */
export function legacyCharsetDecoder(charset: string, fatal = false): TextDecoder | null {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,31}$/i.test(charset)) return null;
  try {
    const decoder = new TextDecoder(charset, { fatal, ignoreBOM: true });
    return decoder.encoding === 'replacement' ? null : decoder;
  } catch { return null; }
}

/** Charsets we can turn back into text, falling back to UTF-8 only for an unstated charset. */
function decodeCharset(buffer: Buffer, charset: string): string {
  if (/^(iso-?8859-1|latin-?1|windows-1252|cp1252)$/.test(charset)) {
    return buffer.toString('latin1');
  }
  if (charset && !/^(utf-?8|us-ascii|ascii)$/.test(charset)) {
    const decoder = legacyCharsetDecoder(charset);
    if (decoder) return decoder.decode(buffer);
  }
  return buffer.toString('utf8');
}

/**
 * Turn one fetched section into readable text.
 *
 * Handles base64 and quoted-printable, which is what mail actually arrives as;
 * 7bit/8bit/binary sections are already text by the time the socket has decoded
 * them. Never throws, an encoding we cannot undo yields the raw section, which
 * is worse to read than the real thing and better than nothing.
 */
export function decodeTextPart(raw: string, encoding: string, charset: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  try {
    if (encoding === 'base64') {
      const cleaned = raw.replace(/[^A-Za-z0-9+/=]/g, '');
      return decodeCharset(Buffer.from(cleaned, 'base64'), charset).replace(/\r\n/g, '\n');
    }
    if (encoding === 'quoted-printable') {
      return decodeCharset(decodeQuotedPrintable(raw), charset).replace(/\r\n/g, '\n');
    }
    return raw.replace(/\r\n/g, '\n');
  } catch {
    return raw.replace(/\r\n/g, '\n');
  }
}

// ---------------------------------------------------------------------------
// FETCH response reading
// ---------------------------------------------------------------------------

const FETCH_START = /^\* \d+ FETCH \(/;
/** `BODY[..]` or `BODY.PEEK[..]`, with an optional `<partial>` suffix. */
const SECTION_MARKER = /BODY(?:\.PEEK)?\[[^\]]*\](?:<[^>]*>)?[ \t]*/;
/** The line that closes a FETCH response: `)`, or `UID 42)` on some servers. */
const RESPONSE_END = /^\s*(?:UID \d+\s*)?\)\s*$/;

/** True when the server actually returned a message for the fetch. */
export function hasFetchResponse(lines: readonly (string | ImapFetchFrame)[]): boolean {
  return lines.some((line) => FETCH_START.test(typeof line === 'string' ? line : line.syntax));
}

/**
 * Pull the section payload out of a single-message FETCH response.
 *
 * Transport callers retain explicit literal frames through the canonical FETCH
 * reader. Scripted string callers retain their historical folded-line shape;
 * short sections may be quoted strings, and absent sections may be NIL. Returns null when there was no FETCH response at all, which is how a
 * UID that no longer exists is told apart from a section that is empty.
 */
export function extractFetchSection(lines: readonly (string | ImapFetchFrame)[]): string | null {
  if (lines.some(line => typeof line !== 'string')) {
    const response = parseFetchResponses(lines)[0];
    if (response !== undefined && response.parseError === null) return fetchSection(response, () => true);
    if (lines.some(line => typeof line !== 'string' && line.literal !== undefined)) return null;
  }
  // Preserve the established lenient quoted-section reader only when there
  // are no literal values to flatten. Transport literals always use frames.
  const textLines = lines.map(line => typeof line === 'string' ? line : line.syntax);
  const startIndex = textLines.findIndex((line) => FETCH_START.test(line));
  if (startIndex === -1) return null;

  const first = textLines[startIndex] ?? '';
  const marker = SECTION_MARKER.exec(first);
  let head = marker === null ? '' : first.slice(marker.index + marker[0].length);

  if (head.startsWith('"')) {
    return readQuoted(head, 0).value;
  }
  if (/^NIL\)?\s*$/i.test(head.trim())) return '';
  if (head === ')') head = '';

  const collected: string[] = head.length > 0 ? [head] : [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = textLines[i] ?? '';
    // The response closes with `)`, which a server that puts the automatic
    // UID item last writes as `UID 42)`. Either ends the payload; so does the
    // tagged completion, in case the close never arrives.
    if (RESPONSE_END.test(line) || /^A\d+ (OK|NO|BAD)\b/.test(line)) break;
    collected.push(line);
  }
  return collected.join('\n');
}

/**
 * Pull the BODYSTRUCTURE expression out of a FETCH response.
 * Lines are joined first, because a literal inside the structure (a filename,
 * typically) fragments the response across several of them.
 */
export function extractBodyStructure(lines: readonly (string | ImapFetchFrame)[]): string {
  const encoded = lines.map(line => typeof line === 'string' ? line : line.syntax
    + (line.literal === undefined ? '' : '"' + line.literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'));
  for (let frameIndex = 0; frameIndex < lines.length; frameIndex += 1) {
    const frame = lines[frameIndex];
    const syntax = typeof frame === 'string' ? frame : frame?.syntax ?? '';
    const start = /^\* \d+ FETCH \(/i.exec(syntax);
    if (start === null) continue;
    // Only actual FETCH syntax can start a candidate. Status prose and a
    // lookalike inside a literal cannot seed depth or supply an item marker.
    let endIndex = frameIndex + 1;
    while (endIndex < lines.length) {
      const next = lines[endIndex];
      const nextSyntax = typeof next === 'string' ? next : next?.syntax ?? '';
      if (/^(?:\* |\S+ (?:OK|NO|BAD)\b)/i.test(nextSyntax)) break;
      endIndex += 1;
    }
    const joined = encoded.slice(frameIndex, endIndex).join('\r\n');
    let depth = 1;
    for (let index = start[0].length; index < joined.length; index += 1) {
      const char = joined.charAt(index);
      if (char === '"') { index = readQuoted(joined, index).next - 1; continue; }
      if (char === '[') { const close = joined.indexOf(']', index); if (close < 0) break; index = close; continue; }
      if (char === '(') { depth += 1; continue; }
      if (char === ')') { if (--depth === 0) break; continue; }
      if (depth !== 1 || !/[\s(]/.test(joined.charAt(index - 1))) continue;
      const marker = /^BODYSTRUCTURE\s+/i.exec(joined.slice(index));
      if (marker === null) continue;
      const rest = joined.slice(index + marker[0].length);
      return rest.startsWith('(') ? rest.slice(0, skipList(rest, 1)) : '';
    }
  }
  return '';
}
