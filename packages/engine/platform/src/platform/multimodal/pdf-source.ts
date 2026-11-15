/** Local, bounded PDF reading. No decoding judgment is made here. */
import { inflateSync } from 'node:zlib';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import type { KnowledgeExtractionResult } from '../knowledge/extractors.js';
/** Extracted page text, the part a model reads. */
const MAX_TEXT_CHARS = 750_000;
/** Everything the file's compressed streams may expand to, pictures and fonts included. */
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
/** PDF.js decodes no picture larger than this many pixels, inline pictures included. */
const MAX_IMAGE_PIXELS = 750_000;
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
 * Structural bounds before PDF.js decompresses anything: file size, no
 * encryption, readable stream extents, no streams stored outside the file, and
 * a bound on what the compressed streams expand to. Content is screened once,
 * as the extracted page text and metadata a model will read.
 */
function admitPdfStreams(buffer: Buffer): void {
  if (buffer.length > 8 * 1024 * 1024) throw refuse('file is larger than 8 MiB');
  const body = buffer.toString('latin1');
  if (!body.startsWith('%PDF-')) throw refuse('file is not a PDF');
  if (/\/Encrypt\b/.test(body)) throw refuse('file is encrypted');
  let expanded = 0;
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
    if (/\/(?:F|FFilter|FDecodeParms)\b/.test(dictionary)) throw refuse('stream is stored outside the file');
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
    // A picture codec (JPEG and the like) has no expansion to bound here; text
    // streams with another expanding filter cannot be bounded before PDF.js runs.
    if (!binary && filter !== undefined && filter !== '/FlateDecode') throw refuse(`text stream uses the unsupported filter ${filter}`);
    if (filter === '/FlateDecode') {
      try { expanded += inflateSync(buffer.subarray(start, end), { maxOutputLength: MAX_EXPANDED_BYTES - expanded + 1 }).length; }
      catch { throw refuse('compressed stream is invalid or expands beyond 64 MiB'); }
      if (expanded > MAX_EXPANDED_BYTES) throw refuse('compressed streams expand beyond 64 MiB');
    }
    pattern.lastIndex = end + terminator[0].length;
  }
}

/**
 * The text of a PDF. `pages` holds each page's text; `extraction.sections` is
 * empty, because a PDF names no headings this reader can see.
 */
export async function readMultimodalPdf(buffer: Buffer, assertCurrent: () => void): Promise<{ source: string; pages: readonly string[]; extraction: KnowledgeExtractionResult }> {
  assertCurrent();
  admitPdfStreams(buffer);
  const pages: string[] = [];
  let count = 0, chars = 0;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    assertCurrent();
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false, maxImageSize: MAX_IMAGE_PIXELS, stopAtErrors: true });
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
          if (chars > MAX_TEXT_CHARS) throw refuse('extracted text exceeds the size limit');
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
  // The one content screen: all pages are local and complete before any model reads them.
  assertJudgmentInput(source);
  if (!source.trim()) throw new Error('PDF extraction failed: no text was extracted. OCR or a dedicated PDF provider is required.');
  assertCurrent();
  return { source, pages, extraction: { extractorId: 'pdfjs', format: 'pdf',
    title: source.split('\n').find(line => line.trim())?.slice(0, 320),
    summary: source.slice(0, 320), excerpt: source.slice(0, 480), sections: [], links: [],
    estimatedTokens: Math.ceil(source.length / 4), structure: { pageCount: count, extractedTextChars: source.length },
    metadata: { limitations: ['PDF text extraction does not perform OCR for scanned images.'] },
  } };
}
