import { expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { readMultimodalPdf } from '../platform/src/platform/multimodal/pdf-source.js';

/** A one-page PDF whose content stream is `commands`, with optional extra objects (pictures) after the page font. */
function pdf(commands: string, extra: { dictionary: string; bytes: Buffer }[] = []): Buffer {
  const content = deflateSync(Buffer.from(commands));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${content.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...extra.map(({ dictionary, bytes }) => `<< ${dictionary} /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`),
  ];
  let body = '%PDF-1.4\n'; const offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

test('page text that contains the letters BI is not mistaken for an inline image', async () => {
  const result = await readMultimodalPdf(pdf('BT /F1 12 Tf 72 720 Td (BI tools for AI) Tj ET'), () => {});
  expect(result.source).toContain('BI tools for AI');
});

test('a PDF with an embedded JPEG picture is read for its text', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
  const bytes = pdf('BT /F1 12 Tf 72 720 Td (report with a picture) Tj ET', [{
    dictionary: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode', bytes: jpeg,
  }]);
  expect((await readMultimodalPdf(bytes, () => {})).source).toContain('report with a picture');
});

test('a refusal names the rule that held the file, so it can be told from a corrupt PDF', async () => {
  const error = await readMultimodalPdf(pdf('q BI /W 1 /H 1 /BPC 8 /F /Fl ID hostile EI Q'), () => {}).catch((failure: unknown) => failure) as Error;
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain('inline image');
  expect(error.message).toContain('Refused before judgment');
});

test('an encrypted PDF and a file that is not a PDF are refused with their own reasons', async () => {
  const encrypted = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Encrypt 2 0 R >>\nendobj\n', 'latin1');
  const encryptedError = await readMultimodalPdf(encrypted, () => {}).catch((failure: unknown) => failure) as Error;
  expect(encryptedError.message).toContain('file is encrypted');
  const notPdf = await readMultimodalPdf(Buffer.from('plain text'), () => {}).catch((failure: unknown) => failure) as Error;
  expect(notPdf.message).toContain('file is not a PDF');
});
