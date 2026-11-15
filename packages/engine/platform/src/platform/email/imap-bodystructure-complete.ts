/** Fail-closed MIME proof, layered over the canonical BODYSTRUCTURE reader. */
import {
  legacyCharsetDecoder,
  parseBodyStructure,
  parseCompleteBodyStructureNodes,
  type ImapBodyPart,
  type ImapBodyStructureNode as Node,
} from './imap-bodystructure.js';

export const COMPLETE_MESSAGE_SOURCE_BYTES = 1_048_576;
export const COMPLETE_MESSAGE_HEADER_BYTES = 65_536;
export const COMPLETE_MESSAGE_STRUCTURE_BYTES = 200_000;

function text(node: Node | undefined): string { return typeof node === 'string' ? node : ''; }
function count(node: Node | undefined): boolean {
  return typeof node === 'number' && Number.isSafeInteger(node) && node >= 0;
}
function nstring(node: Node | undefined): boolean { return node === null || typeof node === 'string'; }
/** A parameter name, plain or in an RFC 2231 extended form (`filename*`, `name*0*`). */
const PARAMETER_NAME = /^[a-z0-9!#$&+.^_`|~-]+(?:\*\d{1,3})?\*?$/;
function parameters(node: Node | undefined): boolean {
  if (node === null) return true;
  if (!Array.isArray(node) || node.length === 0 || node.length % 2 !== 0) return false;
  const keys = new Set<string>();
  for (let i = 0; i < node.length; i += 2) {
    const key = text(node[i]).toLowerCase();
    if (!PARAMETER_NAME.test(key) || keys.has(key) || typeof node[i + 1] !== 'string'
      || (!key.includes('*') && !text(node[i + 1]))) return false;
    keys.add(key);
  }
  return true;
}
function disposition(node: Node | undefined): boolean {
  return node === null || (Array.isArray(node) && node.length === 2
    && /^(?:attachment|inline)$/i.test(text(node[0])) && parameters(node[1]));
}
function language(node: Node | undefined): boolean {
  return nstring(node) || (Array.isArray(node) && node.length > 0 && node.every(item => typeof item === 'string'));
}
function extensions(node: Node[], start: number, multipart: boolean): boolean {
  if (node.length <= start) return true;
  if (multipart ? !parameters(node[start]) : !nstring(node[start])) return false;
  if (node.length > start + 1 && !disposition(node[start + 1])) return false;
  if (node.length > start + 2 && !language(node[start + 2])) return false;
  if (node.length > start + 3 && !nstring(node[start + 3])) return false;
  // Unknown extensions can change which bytes count as body; no silent skip.
  return node.length <= start + 4;
}

const BUILT_IN_CHARSET = /^(?:utf-8|utf8|us-ascii|ascii|iso-?8859-1|latin-?1|windows-1252|cp1252)$/;

/**
 * Validates every node, then decides from the structure itself which leaves are
 * the message's text and which are attachments.
 *
 * Completeness is proven for what is shown, not for the container: any
 * multipart subtype is walked (so `signed`, `report`, `encrypted` and `digest`
 * read like `mixed`), the `text/plain` and `text/html` leaves are the body,
 * and every other leaf (a calendar part, a signature, an inline image, an
 * attached message, an AMP alternative) is listed as an attachment by name,
 * type and size and never fetched. A multipart that is itself an attachment
 * makes its whole subtree attachments. Null when the structure cannot be read,
 * or when a body leaf's charset cannot be decoded or the body is too large.
 */
export function parseCompleteBodyStructure(raw: string): readonly ImapBodyPart[] | null {
  const root = parseCompleteBodyStructureNodes(raw);
  if (root === null || Buffer.byteLength(raw, 'utf8') > COMPLETE_MESSAGE_STRUCTURE_BYTES) return null;
  // `name`, or any of its RFC 2231 forms (`name*`, `name*0*`, ...).
  const named = (params: Node | undefined, key: string): boolean => Array.isArray(params)
    && params.some((item, index) => {
      const name = text(item).toLowerCase();
      return index % 2 === 0 && (name === key || name.startsWith(`${key}*`));
    });
  const attachmentKinds: boolean[] = [];
  const visit = (node: Node[], attached: boolean): boolean => {
    if (Array.isArray(node[0])) {
      let index = 0;
      while (Array.isArray(node[index])) index += 1;
      if (!/^[a-z0-9!#$&+.^_`|~-]+$/i.test(text(node[index])) || !extensions(node, index + 1, true)) return false;
      // A multipart attachment is not a set of inline body sections.
      const disp = node[index + 2];
      const wholeAttached = attached || named(node[index + 1], 'name')
        || (Array.isArray(disp) && (/^attachment$/i.test(text(disp[0])) || named(disp[1], 'filename')));
      for (let child = 0; child < index; child += 1) {
        if (!visit(node[child] as Node[], wholeAttached)) return false;
      }
      return true;
    }
    if (attachmentKinds.length >= 200 || node.length < 7
      || !/^[a-z0-9!#$&+.^_`|~-]+$/i.test(text(node[0]))
      || !/^[a-z0-9!#$&+.^_`|~-]+$/i.test(text(node[1]))
      || !parameters(node[2]) || !nstring(node[3]) || !nstring(node[4])
      || !text(node[5]) || !count(node[6])) return false;
    const type = text(node[0]).toLowerCase();
    const subtype = text(node[1]).toLowerCase();
    if (type === 'multipart') return false;
    // An attached message carries its envelope, its own structure and a line
    // count before the extension data; it is listed, never descended into.
    const encapsulated = type === 'message' && /^(?:rfc822|global)$/.test(subtype);
    if (encapsulated && (!Array.isArray(node[7]) || !Array.isArray(node[8]) || !count(node[9]))) return false;
    const ext = encapsulated ? 10 : type === 'text' ? 8 : 7;
    if (type === 'text' && !count(node[7])) return false;
    const disp = node[ext + 1];
    const explicitlyAttached = (Array.isArray(disp)
      && (/^attachment$/i.test(text(disp[0])) || named(disp[1], 'filename')))
      || named(node[2], 'name') || named(node[2], 'filename');
    const body = !attached && !explicitlyAttached && type === 'text' && /^(?:plain|html)$/.test(subtype);
    attachmentKinds.push(!body);
    return extensions(node, ext, false);
  };
  if (!visit(root, false)) return null;
  const collected = parseBodyStructure(raw);
  if (collected.length !== attachmentKinds.length || collected.length === 0) return null;
  // The lenient collector supplies section, encoding, charset, size and name;
  // which leaves are the body is the strict walk's answer, never its guess.
  const parts = collected.map((part, index) => ({ ...part, isAttachment: attachmentKinds[index]! }));
  let total = 0;
  for (const part of parts) {
    if (part.isAttachment) continue;
    // A charset this runtime cannot decode is a property of the message, so it
    // is refused here with the other unsupported structures.
    if (!BUILT_IN_CHARSET.test(part.charset || 'us-ascii')
      && (!/^(?:base64|quoted-printable)$/.test(part.encoding) || legacyCharsetDecoder(part.charset) === null)) return null;
    total += part.sizeBytes;
    if (!Number.isSafeInteger(total) || total > COMPLETE_MESSAGE_SOURCE_BYTES) return null;
  }
  return parts;
}

/**
 * Quoted-printable to bytes. Trailing spaces and tabs before a line break are
 * transport padding and are dropped (RFC 2045 6.7), a soft break may end in a
 * bare LF, and a raw 8-bit character (the transport already read it as UTF-8)
 * is kept as its UTF-8 bytes. Only a broken `=` escape is unreadable.
 */
function quotedPrintable(raw: string): Buffer | null {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return null;
  const unpadded = raw.replace(/[\t ]+(?=\r?\n|$)/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unpadded.length; i += 1) {
    const ch = unpadded.charAt(i);
    if (ch !== '=') {
      const code = unpadded.charCodeAt(i);
      if (code > 0x7f) { for (const byte of Buffer.from(ch, 'utf8')) bytes.push(byte); continue; }
      bytes.push(code); continue;
    }
    if (unpadded.slice(i + 1, i + 3) === '\r\n') { i += 2; continue; }
    if (unpadded.charAt(i + 1) === '\n') { i += 1; continue; }
    if (i + 1 >= unpadded.length) continue;
    const hex = unpadded.slice(i + 1, i + 3);
    if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
    bytes.push(parseInt(hex, 16)); i += 2;
  }
  return Buffer.from(bytes);
}

/** Charsets whose 8-bit text the transport hands over intact (it reads the wire as UTF-8). */
const UTF8_COMPATIBLE = /^(?:utf-8|utf8|us-ascii|ascii)$/;

/**
 * Complete decoded text, preserving content and line endings; null means the
 * text cannot be recovered exactly. Unlabelled or ASCII-labelled 8-bit text
 * that arrived as valid UTF-8 is read as UTF-8, which is what such mail is.
 */
export function decodeCompleteTextPart(raw: string, part: ImapBodyPart): string | null {
  if (/\ufffd/.test(raw) || Buffer.byteLength(raw, 'utf8') !== part.sizeBytes) return null;
  const declared = part.charset || 'us-ascii';
  const builtIn = BUILT_IN_CHARSET.test(declared);
  // Other charsets are only decodable from base64 or quoted-printable, where the
  // original bytes are recoverable; an 8-bit body arrives already re-decoded as UTF-8.
  const legacy = builtIn || !/^(?:base64|quoted-printable)$/.test(part.encoding) ? null : legacyCharsetDecoder(declared, true);
  if (!builtIn && legacy === null) return null;
  let bytes: Buffer | null;
  if (part.encoding === 'base64') {
    if (/[^A-Za-z0-9+/=\t\r\n ]/.test(raw)) return null;
    const encoded = raw.replace(/[\t\r\n ]/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
    bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return null;
  } else if (part.encoding === 'quoted-printable') {
    bytes = quotedPrintable(raw);
  } else if (part.encoding === '' || /^(?:7bit|8bit|binary)$/.test(part.encoding)) {
    // The transport hands us UTF-8 strings. Non-UTF-8 8-bit bytes in a part
    // labelled with a single-byte charset are unrecoverable here.
    if (!UTF8_COMPATIBLE.test(declared) && /[^\x00-\x7f]/.test(raw)) return null;
    bytes = Buffer.from(raw, 'utf8');
  } else return null;
  if (bytes === null) return null;
  try {
    let decoded: string;
    if (/^(?:iso-?8859-1|latin-?1)$/.test(declared)) decoded = bytes.toString('latin1');
    else if (legacy) decoded = legacy.decode(bytes);
    else decoded = new TextDecoder(/^(?:cp1252|windows-1252)$/.test(declared) ? 'windows-1252' : 'utf-8',
      { fatal: true, ignoreBOM: true }).decode(bytes);
    return /\ufffd|\u0000/.test(decoded) ? null : decoded;
  } catch { return null; }
}
