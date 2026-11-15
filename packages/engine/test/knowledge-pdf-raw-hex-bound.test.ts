import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { extractPdf } from '../platform/src/platform/knowledge/pdf-extractor.js';
import { extractionReadability, pdfTextDecoding } from '../platform/src/platform/knowledge/batteries/extraction-readability.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function rawPdf(content: string): Buffer {
  const bytes = Buffer.from(content, 'latin1');
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${bytes.length} >>\nstream\n`, 'latin1'), bytes, Buffer.from('\nendstream\nendobj\n%%EOF\n'),
  ]);
}

function countingPort() {
  const fake = fakePort((name, question) => {
    if (name === 'readable' && question.type === 'noul' && question.instructions === extractionReadability.items.readable.question.instructions) return noulAnswer(0.99);
    if (name === 'decoding' && question.type === 'choice' && question.instructions === pdfTextDecoding.items.decoding.question.instructions) return choiceAnswer(question, 'singleByte', 0.99);
    throw new Error(`Unexpected PDF fixture contract: ${name}`);
  });
  installJudgmentPort(fake.port);
  return fake;
}

const decodingRequests = (fake: ReturnType<typeof countingPort>) => fake.requests.filter((request) => request.context?.battery === pdfTextDecoding.name);
const hexString = (text: string) => `<${Buffer.from(text, 'latin1').toString('hex')}>`;

test('a PDF with thousands of distinct hex strings costs a bounded number of decoding judgments', async () => {
  const fake = countingPort();
  const strings = Array.from({ length: 5000 }, (_, index) => hexString(`Readable label number ${index}`));
  const result = await extractPdf(rawPdf(`BT ${strings.join(' Tj ')} Tj ET`));
  expect(result.extractorId).toBe('pdf-raw');
  expect(decodingRequests(fake).length).toBeGreaterThan(0);
  expect(decodingRequests(fake).length).toBeLessThanOrEqual(256);
});

test('a hex string repeated many times is judged once', async () => {
  const fake = countingPort();
  const label = hexString('Repeated heading text');
  const result = await extractPdf(rawPdf(`BT ${Array.from({ length: 300 }, () => label).join(' Tj ')} Tj ET`));
  expect(result.structure.searchText).toBe('Repeated heading text');
  expect(decodingRequests(fake)).toHaveLength(1);
});
