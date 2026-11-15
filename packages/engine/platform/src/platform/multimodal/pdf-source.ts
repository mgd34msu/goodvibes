/** Local, bounded two-phase PDF admission. No decoding judgment is made here. */
import { inflateSync } from 'node:zlib';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import type { KnowledgeExtractionResult } from '../knowledge/extractors.js';
const MAX_SOURCE_BYTES = 750_000;
/** Pictures and font programs are binary, not text; they are bounded but never screened as text. */
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
/** The refusal stays value-free; the message names only which rule held the file, so a failure can be told from a corrupt file by a person or an agent reading it. */
const refuse = (cause?: string) => {
  const error = new JudgmentInputError('unsupported-input');
  if (cause) {
    error.message = `${error.message} (PDF held: ${cause})`;
    error.cause = cause;
  }
  return error;
};

/**
 * Whether a content stream carries an inline image (`BI /W 4 /H 4 ... ID ... EI`).
 * Strings and comments are skipped, so the words "BI tools" in page text are not one.
 */
function containsInlineImage(content: string): boolean {
  let code = '';
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!;
    if (depth > 0) {
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      continue;
    }
    if (c === '(') { depth = 1; code += ' '; continue; }
    if (c === '%') { while (i < content.length && content[i] !== '\n' && content[i] !== '\r') i++; code += ' '; continue; }
    code += c;
  }
  return /(?<![^\s\])>])BI(?=\s*\/[A-Za-z])/.test(code);
}

/** Validate stream extents and bound expansion before PDF.js can decompress anything.
 * Unsupported filters/encryption/ambiguous lengths are explicit holds, never partial extraction.
 */
function admitPdfStreams(buffer: Buffer): void {
  if (buffer.length > 8 * 1024 * 1024) throw refuse('file is larger than 8 MiB');
  const body = buffer.toString('latin1');
  if (!body.startsWith('%PDF-')) throw refuse('file is not a PDF');
  if (/\/Encrypt\b/.test(body)) throw refuse('file is encrypted');
  let expanded = 0, binaryExpanded = 0;
  const pattern = /\bstream\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const eol = body.slice(pattern.lastIndex).match(/^(?:\r\n|\n|\r)/);
    if (!eol) throw refuse('stream keyword is not followed by a line ending');
    pattern.lastIndex += eol[0].length;
    const objectStart = body.lastIndexOf(' obj', match.index);
    const dictionary = body.slice(objectStart + 4, match.index).trim();
    if (objectStart < 0 || !dictionary.startsWith('<<') || !dictionary.endsWith('>>')) throw refuse('stream dictionary is not readable');
    const binary = /\/Subtype\s*\/(?:Image|Type1C|CIDFontType0C|OpenType)\b/.test(dictionary) || /\/Length1\b/.test(dictionary);
    if (/\/[^\s<>[\]()]*#[0-9a-f]{2}/i.test(dictionary)) throw refuse('stream dictionary uses an escaped name');
    if (/\/(?:F|FFilter|FDecodeParms)\b/.test(dictionary) || (!binary && /\/DecodeParms\b/.test(dictionary))) throw refuse('stream is stored outside the file or uses decode parameters');
    const lengths = [...dictionary.matchAll(/\/Length\s+(\d+)(?:\s+(\d+)\s+R)?\b/g)];
    if (lengths.length !== 1) throw refuse('stream length is missing or ambiguous');
    const length = lengths[0]!;
    let size = Number(length[1]);
    if (length[2] !== undefined) {
      const values = [...body.matchAll(new RegExp(`(?:^|[\\r\\n])${length[1]}\\s+${length[2]}\\s+obj\\s+(\\d+)\\s+endobj\\b`, 'g'))];
      if (values.length !== 1) throw refuse('indirect stream length is ambiguous');
      size = Number(values[0]![1]);
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > buffer.length - pattern.lastIndex) throw refuse('stream length is out of range');
    const start = pattern.lastIndex, end = start + size;
    const terminator = body.slice(end).match(/^\s*endstream\b/);
    if (!terminator) throw refuse('stream is not closed by endstream');
    const filters = [...dictionary.matchAll(/\/Filter\s*(\[[^\]]*\]|\/[^\s<>[\]()]+)/g)];
    if (filters.length > 1 || [...dictionary.matchAll(/\/Filter\b/g)].length !== filters.length) throw refuse('stream filter is not readable');
    const filter = filters[0]?.[1]?.replace(/[\s[\]]/g, '');
    if (binary) {
      // A picture or font is never read as text. Its own compression is still
      // bounded, and a picture codec (JPEG and the like) has no expansion to bound here.
      if (filter === '/FlateDecode') {
        try { binaryExpanded += inflateSync(buffer.subarray(start, end), { maxOutputLength: MAX_BINARY_BYTES - binaryExpanded + 1 }).length; }
        catch { throw refuse('compressed image or font data is invalid or too large'); }
        if (binaryExpanded > MAX_BINARY_BYTES) throw refuse('compressed image and font data is too large');
      }
      pattern.lastIndex = end + terminator[0].length;
      continue;
    }
    if (filter !== undefined && filter !== '/FlateDecode') throw refuse(`text stream uses the unsupported filter ${filter}`);
    let bytes: Buffer;
    try { bytes = filter ? inflateSync(buffer.subarray(start, end), { maxOutputLength: MAX_SOURCE_BYTES - expanded + 1 }) : buffer.subarray(start, end); }
    catch { throw refuse('compressed stream is invalid or too large'); }
    // Inline image filters can recursively decompress data inside this stream.
    // They are outside this reader's bounded text-only subset.
    if (containsInlineImage(bytes.toString('latin1'))) throw refuse('content stream holds an inline image');
    assertJudgmentInput(bytes.toString('utf-8'));
    expanded += bytes.length;
    if (expanded > MAX_SOURCE_BYTES) throw refuse('decoded streams are too large');
    pattern.lastIndex = end + terminator[0].length;
  }
}

export async function readMultimodalPdf(buffer: Buffer, assertCurrent: () => void): Promise<{ source: string; extraction: KnowledgeExtractionResult }> {
  assertCurrent();
  // Encoded PDF syntax (including xref offsets) is structural, not semantic input.
  // Every decoded stream, page and metadata field is screened below.
  admitPdfStreams(buffer);
  const pages: string[] = [];
  let count = 0, chars = 0;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    assertCurrent();
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false, maxImageSize: MAX_SOURCE_BYTES, stopAtErrors: true });
    try {
      const document = await task.promise;
      assertCurrent();
      const metadata = await document.getMetadata();
      assertCurrent();
      assertJudgmentInput({ info: metadata.info, metadata: metadata.metadata?.getAll() });
      count = document.numPages;
      for (let number = 1; number <= count; number++) {
        assertCurrent();
        const page = await document.getPage(number);
        try {
          const content = await page.getTextContent();
          assertCurrent();
          const text = content.items.map(item => 'str' in item ? item.str : '').join(' ');
          chars += text.length;
          if (chars > MAX_SOURCE_BYTES) throw refuse('extracted text exceeds the size limit');
          pages.push(text);
        } finally { page.cleanup(); }
      }
    } finally { await task.destroy(); }
  } catch (error) {
    assertCurrent();
    if (error instanceof JudgmentInputError) throw error;
    // The reader's own message names the failing PDF structure, not its content.
    throw refuse(`the PDF reader could not open the file: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
  }
  const source = pages.join('\n\n');
  // All pages are local and complete before the first hosted reading.
  assertJudgmentInput(source);
  if (!source.trim()) throw new Error('PDF extraction failed: no text was extracted. OCR or a dedicated PDF provider is required.');
  assertCurrent();
  return { source, extraction: { extractorId: 'pdfjs', format: 'pdf',
    title: source.split('\n').find(line => line.trim())?.slice(0, 320),
    summary: source.slice(0, 320), excerpt: source.slice(0, 480), sections: pages, links: [],
    estimatedTokens: Math.ceil(source.length / 4), structure: { pageCount: count, extractedTextChars: source.length },
    metadata: { limitations: ['PDF text extraction does not perform OCR for scanned images.'] },
  } };
}
