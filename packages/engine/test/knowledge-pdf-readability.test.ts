import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { extractPdf } from '../platform/src/platform/knowledge/pdf-extractor.js';
import { KnowledgeExtractionJudgmentHoldError } from '../platform/src/platform/knowledge/extraction-policy.js';
import { JudgmentInputError } from '../platform/src/platform/gate/judgment-input.js';
import { extractionReadability } from '../platform/src/platform/knowledge/batteries/extraction-readability.js';
import { createCompressedPdfBuffer } from './_helpers/homegraph-service-fixtures.js';
// The field-name reading no longer exists (the activity log masks locally); a request naming it is unexpected.
const fieldKind = { name: 'engine.redaction.field-kind', items: { kind: { question: {} as Record<string, unknown> } } };
import { redactionCredential } from '../platform/src/platform/utils/batteries/redaction.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function rawPdf(content: string, compressed = false): Buffer {
  const bytes = compressed ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${bytes.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'),
    bytes,
    Buffer.from('\nendstream\nendobj\n%%EOF\n'),
  ]);
}

function textPort(p = 0.99) {
  const fake = fakePort((name, question) => {
    if (name === 'readable' && question.type === 'noul' && question.instructions === extractionReadability.items.readable.question.instructions) return noulAnswer(p);
    throw new Error(`Unexpected PDF fixture contract: ${name}`);
  });
  installJudgmentPort(fake.port);
  return fake;
}
function extractionRequests(fake: ReturnType<typeof textPort>) {
  for (const request of fake.requests) {
    if (request.context?.battery === extractionReadability.name) continue;
    if (request.context?.battery === redactionCredential.name) {
      expect(request.questions).toEqual({ lineHasCredential: redactionCredential.items.lineHasCredential.question,
        spanIsCredential: redactionCredential.items.spanIsCredential.question });
      expect(request.state).toEqual({ phase: 'source', parts: [{ kind: 'text', text: 'Invalid PDF structure.' }], target: 'whole-line' });
      continue;
    }
    expect(request.context?.battery).toBe(fieldKind.name);
    expect(request.questions as unknown).toEqual({ kind: fieldKind.items.kind.question });
    expect(request.state).toEqual({ field: 'error' });
  }
  return fake.requests.filter(request => request.context?.battery === extractionReadability.name);
}

describe('PDF readability judgment', () => {
  test('empty or image-only PDF content asks nothing and requires OCR rather than guessing', async () => {
    const fake = textPort();
    await expect(extractPdf(createCompressedPdfBuffer(''))).rejects.toThrow('PDF extraction failed');
    await expect(extractPdf(rawPdf('q /Im0 Do Q'))).rejects.toThrow('PDF extraction failed');
    expect(extractionRequests(fake)).toHaveLength(0);
  });

  test('preserves the pdfjs parser and filters text through the named battery', async () => {
    const fake = textPort();
    const result = await extractPdf(createCompressedPdfBuffer('A readable PDF manual.'));
    expect(result.extractorId).toBe('pdfjs');
    expect(result.structure.searchText).toBe('A readable PDF manual.');
    expect(extractionRequests(fake).every((request) => request.context?.battery === 'engine.knowledge.extraction-readability')).toBe(true);
  });

  test('preserves raw-stream inflate, escapes, nesting, deduplication and one-character fragments', async () => {
    textPort();
    const result = await extractPdf(rawPdf('BT (A) Tj (Hello \\(nested\\) \\101) Tj (A) Tj ET', true));
    expect(result.extractorId).toBe('pdf-raw');
    expect(result.structure.searchText).toBe('A\nHello (nested) A');
    // Raw streams have no outline: no leading line becomes a heading.
    expect(result.sections).toEqual([]);
  });

  test('accepts readable prose explaining PDF tokens instead of treating tokens as binary', async () => {
    textPort();
    const text = 'PDF syntax uses %PDF and 7 0 obj with /Filter /FlateDecode.';
    const result = await extractPdf(rawPdf(`BT (${text}) Tj ET`));
    expect(result.structure.searchText).toBe(text);
  });

  test('honors the UTF-16BE BOM without an encoding guess, then judges readable text', async () => {
    const fake = textPort();
    const result = await extractPdf(rawPdf('BT <FEFF65E5672C> Tj ET'));
    expect(result.structure.searchText).toBe('日本');
    expect(extractionRequests(fake)).toHaveLength(1);
  });

  test('decodes unmarked hex strings by their bytes: one readability request for the whole document', async () => {
    const fake = textPort();
    const hex = (text: string) => `<${Buffer.from(text, 'latin1').toString('hex')}>`;
    const strings = Array.from({ length: 5000 }, (_, index) => hex(`Readable label number ${index}`));
    const result = await extractPdf(rawPdf(`BT ${strings.join(' Tj ')} Tj <65E5672C> Tj <0001> Tj ET`));
    expect(result.extractorId).toBe('pdf-raw');
    expect(String(result.structure.searchText)).toContain('Readable label number 0');
    expect(extractionRequests(fake)).toHaveLength(1);
    expect((await extractPdf(rawPdf('BT <65E5672C> Tj ET'))).structure.searchText).toBe('日本');
  });

  test('retains a single-byte hex label, but rejects malformed odd-byte hex syntax', async () => {
    textPort();
    expect((await extractPdf(rawPdf('BT <41> Tj ET'))).structure.searchText).toBe('A');
    const fake = textPort();
    await expect(extractPdf(rawPdf('BT <4> Tj ET'))).rejects.toThrow('PDF extraction failed');
    expect(extractionRequests(fake)).toHaveLength(0);
  });

  test('hex bytes that are neither text encoding are left out', async () => {
    const fake = textPort();
    await expect(extractPdf(rawPdf('BT <0001> Tj ET'))).rejects.toThrow('PDF extraction failed');
    expect(extractionRequests(fake)).toHaveLength(0);
  });

  test('does not turn a pdfjs judgment hold into raw-parser fallback', async () => {
    const fake = textPort(0.5);
    await expect(extractPdf(createCompressedPdfBuffer('Readable-looking text.'))).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    expect(extractionRequests(fake)).toHaveLength(1);
    installJudgmentPort(undefined);
    await expect(extractPdf(createCompressedPdfBuffer('Readable-looking text.'))).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
  });

  test('preflights full decoded candidates before any sample is sent', async () => {
    const fake = textPort();
    await expect(extractPdf(rawPdf(`BT (${ 'Ordinary text. '.repeat(400) }password=synthetic-fixture) Tj ET`))).rejects.toBeInstanceOf(JudgmentInputError);
    const text = 'password=synthetic-fixture';
    const bytes = Buffer.from(text, 'utf16le');
    bytes.swap16();
    await expect(extractPdf(rawPdf(`BT <${bytes.toString('hex')}> Tj ET`))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(extractionRequests(fake)).toHaveLength(0);
    expect(JSON.stringify(fake.requests)).not.toContain('password=synthetic-fixture');
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-fixture');
  });
});
