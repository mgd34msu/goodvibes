import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { extractKnowledgeArtifact } from '../platform/src/platform/knowledge/extractors.js';
import { parseBookmarkSeeds } from '../platform/src/platform/knowledge/bookmarks.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('office extraction', () => {
  test('docx headings are only the paragraphs styled as headings', async () => {
    const document = await zipOf({ 'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:t>Intro text</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Real Title</w:t></w:r></w:p></w:body></w:document>' });
    const result = await extractKnowledgeArtifact({ id: 'a', mimeType: DOCX, filename: 'a.docx' }, document);
    expect(result.title).toBe('Real Title');
    expect(result.sections).toEqual(['Real Title']);
    expect(result.structure['headingCount']).toBe(1);
  });

  test('xlsx shared-string cells resolve when t is not the first attribute and blank cells stay blank', async () => {
    const workbook = await zipOf({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>zero</t></si><si><t>one</t></si><si><t>two</t></si><si><t>Quarterly Revenue</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1">'
        + '<c r="A1" s="1" t="s"><v>3</v></c><c r="B1" s="1"/><c r="C1"><v>42</v></c>'
        + '</row></sheetData></worksheet>',
    });
    const result = await extractKnowledgeArtifact({ id: 'b', mimeType: XLSX, filename: 'b.xlsx' }, workbook);
    const searchText = String(result.structure['searchText']);
    expect(searchText).toContain('Quarterly Revenue');
    expect(searchText).toContain('42');
    expect(searchText).not.toContain('<v>');
  });
});

describe('bookmark parsing', () => {
  test('input that looks like JSON but is truncated is an error, not an empty import', () => {
    expect(() => parseBookmarkSeeds('[{"url":')).toThrow('could not be parsed');
  });

  test('nested JSON folders extend the folder path', () => {
    const seeds = parseBookmarkSeeds(JSON.stringify({
      name: 'Work', children: [{ name: 'Docs', children: [{ name: 'Spec', url: 'https://example.com/spec' }] }],
    }));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.folderPath).toBe('Work / Docs');
  });
});
