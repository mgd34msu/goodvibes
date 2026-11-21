import { inflateSync } from 'node:zlib';
import { createKnowledgeExtractionOwner, type KnowledgeExtractionOwner } from './extraction-ownership.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import type { KnowledgeExtractionResult } from './extractors.js';
import {
  KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS,
  hasUsefulKnowledgeExtractionText,
} from './extraction-policy.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

function cleanText(value: string): string {
  return value
    .replace(/\u0000/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * The one readability reading of a PDF's text, taken over the whole extraction
 * (not per line). Unreadable text yields no search text; a cut records the
 * total and retained character counts.
 */
async function searchTextPayload(value: string, owner: KnowledgeExtractionOwner): Promise<Record<string, unknown> | undefined> {
  const cleaned = cleanText(value);
  if (!(await hasUsefulKnowledgeExtractionText(value, owner))) return undefined;
  return cleaned.length <= KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS
    ? { searchText: cleaned }
    : { searchText: cleaned.slice(0, KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS), searchTextTruncated: true,
      searchTextTotalChars: cleaned.length, searchTextRetainedChars: KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS };
}

/** Raw stream strings that hold text: no control or replacement characters, and at least one letter. */
function isPrintableText(value: string): boolean {
  return /\p{L}/u.test(value) && !/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\ufffd]/u.test(value);
}

function estimateTokens(...chunks: Array<string | undefined | null>): number {
  const total = chunks
    .filter((value): value is string => typeof value === 'string')
    .reduce((sum, value) => sum + value.length, 0);
  return Math.max(1, Math.ceil(total / 4));
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);
}

function summarizeText(text: string, maxLength = 320): string | undefined {
  const cleaned = cleanText(text);
  if (!cleaned) return undefined;
  if (cleaned.length <= maxLength) return cleaned;
  const sentence = cleaned.match(/^(.{0,320}?[.!?])(?:\s|$)/)?.[1]?.trim();
  return sentence && sentence.length >= 40 ? sentence : `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

function excerptText(text: string, maxLength = 480): string | undefined {
  const cleaned = cleanText(text);
  if (!cleaned) return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

function uniqueStrings(values: Iterable<string>, limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = cleanText(value);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

/** Local work bound on raw-stream strings kept for the one readability reading. */
const MAX_RAW_PDF_TEXT_CANDIDATES = 2048;
/** Headings kept from a PDF outline. */
const MAX_PDF_OUTLINE_SECTIONS = 64;

/** A link is kept when it parses as an http(s) URL; no reading per link. */
function pdfLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s)>\]]+/g)) {
    const candidate = match[0].replace(/[.,;:!?'"]+$/, '');
    try {
      const url = new URL(candidate);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) links.push(candidate);
    } catch { /* not a URL */ }
  }
  return uniqueStrings(links, 50);
}

interface PdfOutlineNode { readonly title?: unknown; readonly items?: readonly unknown[] }

/** Headings from the document's own outline (bookmarks), depth first. */
function outlineTitles(outline: readonly unknown[] | null | undefined): string[] {
  const titles: string[] = [];
  const visit = (nodes: readonly unknown[]): void => {
    for (const node of nodes) {
      if (titles.length >= MAX_PDF_OUTLINE_SECTIONS) return;
      const record = unknownRecord(node) as PdfOutlineNode;
      if (typeof record.title === 'string' && record.title.trim()) titles.push(record.title);
      if (Array.isArray(record.items)) visit(record.items);
    }
  };
  visit(outline ?? []);
  return uniqueStrings(titles, MAX_PDF_OUTLINE_SECTIONS);
}

interface PdfJsExtractionAttempt {
  readonly result?: KnowledgeExtractionResult | undefined;
  readonly warning?: string | undefined;
}

interface RawPdfExtractionDiagnostics {
  failedFlateDecodeStreams: number;
  firstFlateDecodeError?: string | undefined;
}

export async function extractPdf(buffer: Buffer, owner: KnowledgeExtractionOwner = createKnowledgeExtractionOwner()): Promise<KnowledgeExtractionResult> {
  const parsed = await extractPdfWithPdfJs(buffer, owner);
  if (parsed.result) return parsed.result;
  const raw = await extractPdfRawStreams(buffer, parsed.warning ? [parsed.warning] : [], owner);
  if (raw) return raw;
  throw new Error('PDF extraction failed: no readable text was extracted. OCR or a dedicated PDF provider may be required.');
}

async function extractPdfWithPdfJs(buffer: Buffer, owner: KnowledgeExtractionOwner): Promise<PdfJsExtractionAttempt> {
  let pageCount: number;
  let sections: string[] = [];
  let documentTitle: string | undefined;
  const pageTexts: string[] = [];
  try {
    owner.assertCurrent();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    owner.assertCurrent();
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    const abort = () => { void loadingTask.destroy().catch(() => {}); };
    owner.signal?.addEventListener('abort', abort, { once: true });
    try {
      owner.assertCurrent();
      const document = await loadingTask.promise;
      owner.assertCurrent();
      pageCount = document.numPages;
      // Sections are the author's outline, and the title the document's own
      // Title entry: neither is guessed from leading lines.
      sections = outlineTitles(await document.getOutline().catch(() => null));
      const info = unknownRecord((await document.getMetadata().catch(() => undefined))?.info);
      documentTitle = typeof info.Title === 'string' && info.Title.trim() ? cleanText(info.Title) : undefined;
      owner.assertCurrent();
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        owner.assertCurrent();
        const page = await document.getPage(pageNumber);
        owner.assertCurrent();
        const content = await page.getTextContent();
        owner.assertCurrent();
        const lines = textContentItemsToLines(content.items);
        if (lines.length > 0) pageTexts.push(lines.join('\n'));
        page.cleanup();
      }
    } finally {
      owner.signal?.removeEventListener('abort', abort);
      // The loading task owns teardown in pdfjs 5.x and 6.x.
      await loadingTask.destroy();
    }
  } catch (error) {
    owner.assertCurrent();
    const warning = `PDF.js extraction failed; used raw stream fallback: ${summarizeError(error)}`;
    logger.warn('PDF extraction: pdfjs path failed; trying raw stream extraction', { error: summarizeError(error) });
    return { warning };
  }
  // Parsing fallback is allowed; a judgment outage or uncertain reading is not.
  const uncleaned = pageTexts.join('\n\n');
  assertJudgmentInput(uncleaned);
  const search = await searchTextPayload(uncleaned, owner);
  if (!search) return {};
  const text = cleanText(uncleaned);
  return {
    result: {
      extractorId: 'pdfjs',
      format: 'pdf',
      title: documentTitle ?? firstNonEmptyLine(text) ?? 'PDF document',
      summary: summarizeText(text) ?? 'PDF document.',
      excerpt: excerptText(text),
      sections,
      links: pdfLinks(text),
      estimatedTokens: estimateTokens(text),
      structure: { pageCount, extractedTextChars: text.length, ...search },
      metadata: { limitations: ['PDF text extraction does not perform OCR for scanned images.'], readable: true },
    },
  };
}

function textContentItemsToLines(items: readonly unknown[]): string[] {
  const lines: string[] = [];
  let current = '';
  for (const item of items) {
    const record = unknownRecord(item);
    const text = typeof record.str === 'string' ? record.str : '';
    if (text) current = current ? `${current} ${text}` : text;
    if (record.hasEOL === true && current) {
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines;
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

async function extractPdfRawStreams(buffer: Buffer, initialWarnings: readonly string[], owner: KnowledgeExtractionOwner): Promise<KnowledgeExtractionResult | undefined> {
  const body = buffer.toString('latin1');
  const texts: string[] = [];
  const seenHex = new Set<string>();
  const diagnostics: RawPdfExtractionDiagnostics = { failedFlateDecodeStreams: 0 };
  for (const { dictionary, rawChunk } of rawPdfStreams(body)) {
    const chunk = decodePdfStreamChunk(dictionary, rawChunk, diagnostics);
    texts.push(...extractLiteralStrings(chunk), ...extractHexStrings(chunk, seenHex));
    if (texts.length >= MAX_RAW_PDF_TEXT_CANDIDATES) break;
  }
  texts.length = Math.min(texts.length, MAX_RAW_PDF_TEXT_CANDIDATES);
  assertJudgmentInput(texts);
  const readable = uniqueStrings(texts.filter(isPrintableText), 512);
  const combined = readable.slice(0, 64).join('\n');
  const searchable = readable.join('\n');
  const search = await searchTextPayload(searchable, owner);
  if (!search) return undefined;
  const warnings = [...initialWarnings];
  if (diagnostics.failedFlateDecodeStreams > 0) {
    warnings.push(
      `Failed to inflate ${diagnostics.failedFlateDecodeStreams} FlateDecode PDF stream(s); extracted readable text from remaining streams.`
      + (diagnostics.firstFlateDecodeError ? ` First error: ${diagnostics.firstFlateDecodeError}` : ''),
    );
  }
  return {
    extractorId: 'pdf-raw',
    format: 'pdf',
    title: firstNonEmptyLine(combined) ?? 'PDF document',
    summary: summarizeText(combined) ?? 'PDF document text extracted from raw streams.',
    excerpt: excerptText(combined),
    // Raw streams carry no outline, so there are no headings to report.
    sections: [],
    links: pdfLinks(searchable),
    estimatedTokens: estimateTokens(combined),
    structure: {
      extractedStringCount: texts.length,
      ...search,
    },
    metadata: {
      readable: true,
      limitations: texts.length === 0
        ? ['No readable text streams were found. Complex PDFs need OCR or a dedicated provider.']
        : ['PDF text extraction does not perform OCR for scanned images.'],
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(diagnostics.failedFlateDecodeStreams > 0 ? { failedFlateDecodeStreamCount: diagnostics.failedFlateDecodeStreams } : {}),
    },
  };
}

/** Longest dictionary body (between `<<` and `>>`) read as a stream's dictionary. */
const MAX_PDF_STREAM_DICTIONARY_CHARS = 4096;
const PDF_END_STREAM = '\nendstream';

/**
 * Every `<<dictionary>> stream ... endstream` in a PDF body, in one forward
 * pass: `<<` and `>>` are paired as they nest, and a dictionary whose `>>` is
 * followed by the `stream` keyword and a line end starts a stream that runs to
 * the next line that begins with `endstream`. When no `endstream` follows, no
 * later stream can close either, so the walk ends. Untrusted bytes cost time
 * in proportion to their length, never more.
 */
function* rawPdfStreams(body: string): Generator<{ readonly dictionary: string; readonly rawChunk: string }> {
  const opens: number[] = [];
  let index = 0;
  while (index < body.length - 1) {
    const code = body.charCodeAt(index);
    const next = body.charCodeAt(index + 1);
    if (code === 0x3c && next === 0x3c) {
      opens.push(index);
      index += 2;
      continue;
    }
    if (code !== 0x3e || next !== 0x3e) {
      index += 1;
      continue;
    }
    const start = opens.pop();
    const end = index + 2;
    index = end;
    if (start === undefined || end - start - 4 > MAX_PDF_STREAM_DICTIONARY_CHARS) continue;
    const dataStart = pdfStreamDataStart(body, end);
    if (dataStart === undefined) continue;
    const close = body.indexOf(PDF_END_STREAM, dataStart);
    if (close === -1) return;
    const chunkEnd = close > dataStart && body.charCodeAt(close - 1) === 0x0d ? close - 1 : close;
    yield { dictionary: body.slice(start, end), rawChunk: body.slice(dataStart, chunkEnd) };
    opens.length = 0;
    index = close + PDF_END_STREAM.length;
  }
}

/** Where a stream's data begins when `stream` and a line end follow `from` (after any whitespace). */
function pdfStreamDataStart(body: string, from: number): number | undefined {
  let index = from;
  while (index < body.length && /\s/.test(body[index]!)) index += 1;
  if (!body.startsWith('stream', index)) return undefined;
  index += 'stream'.length;
  if (body.charCodeAt(index) === 0x0d) index += 1;
  return body.charCodeAt(index) === 0x0a ? index + 1 : undefined;
}

function decodePdfStreamChunk(
  dictionary: string,
  rawChunk: string,
  diagnostics: RawPdfExtractionDiagnostics,
): string {
  if (!/\/FlateDecode\b/i.test(dictionary)) return rawChunk;
  try {
    return inflateSync(Buffer.from(rawChunk, 'latin1')).toString('latin1');
  } catch (error) {
    diagnostics.failedFlateDecodeStreams += 1;
    diagnostics.firstFlateDecodeError ??= summarizeError(error);
    return '';
  }
}

function extractLiteralStrings(chunk: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] !== '(') {
      index += 1;
      continue;
    }
    const parsed = readPdfLiteralString(chunk, index + 1);
    if (parsed) {
      values.push(parsed.value);
      index = parsed.nextIndex;
    } else {
      index += 1;
    }
  }
  return values;
}

function readPdfLiteralString(chunk: string, start: number): { readonly value: string; readonly nextIndex: number } | undefined {
  let depth = 1;
  let escaped = false;
  let value = '';
  for (let index = start; index < chunk.length; index += 1) {
    const char = chunk[index]!;
    if (escaped) {
      const decoded = decodePdfEscape(char, chunk.slice(index + 1, index + 3));
      value += decoded.value;
      index += decoded.consumed;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '(') {
      depth += 1;
      value += char;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return { value, nextIndex: index + 1 };
      value += char;
      continue;
    }
    value += char;
  }
  return undefined;
}

function decodePdfEscape(char: string, following: string): { readonly value: string; readonly consumed: number } {
  switch (char) {
    case 'n':
      return { value: '\n', consumed: 0 };
    case 'r':
      return { value: '\r', consumed: 0 };
    case 't':
      return { value: '\t', consumed: 0 };
    case 'b':
      return { value: '\b', consumed: 0 };
    case 'f':
      return { value: '\f', consumed: 0 };
    case '(':
    case ')':
    case '\\':
      return { value: char, consumed: 0 };
    default:
      if (/[0-7]/.test(char)) {
        const octal = `${char}${(following.match(/^[0-7]{0,2}/)?.[0] ?? '')}`;
        return { value: String.fromCharCode(Number.parseInt(octal, 8)), consumed: octal.length - 1 };
      }
      return { value: char, consumed: 0 };
  }
}

function extractHexStrings(chunk: string, seen: Set<string>): string[] {
  const values: string[] = [];
  const hexRe = /(?<!<)<([0-9A-Fa-f\s]*)>(?!>)/g;
  let match: RegExpExecArray | null;
  while ((match = hexRe.exec(chunk)) !== null) {
    const key = (match[1] ?? '').replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = decodeHexPdfString(key);
    if (text) values.push(text);
  }
  return values;
}

/**
 * Decodes one hex string by its bytes: a UTF-16BE byte-order mark is
 * authoritative; otherwise printable ASCII is single-byte text and printable
 * UTF-16BE is the two-byte reading. Anything else (glyph ids of a font without
 * its map) is left out; the whole text then gets the document's one
 * readability reading.
 */
function decodeHexPdfString(hex: string): string | undefined {
  // Preserve the parser's complete-byte rule, not the old two-byte text floor.
  if (hex.length === 0 || hex.length % 2 !== 0) return undefined;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2 !== 0) return undefined;
    return decodeUtf16Be(bytes.subarray(2));
  }
  const singleByte = bytes.toString('latin1');
  if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(singleByte) && /[A-Za-z0-9]/.test(singleByte)) return singleByte;
  const utf16be = bytes.length % 2 === 0 ? decodeUtf16Be(bytes) : undefined;
  return utf16be !== undefined && isPrintableText(utf16be) ? utf16be : undefined;
}

function decodeUtf16Be(bytes: Buffer): string {
  const swapped = Buffer.alloc(bytes.length);
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  return swapped.toString('utf16le');
}
