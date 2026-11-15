/**
 * The read tool reports what the bytes are and what it could not do: a resized image carries the type it
 * was re-encoded to, a file that is not an image is refused rather than sent as one, an archive that is
 * not a tar is not listed as one, and a file or expansion past the limit is refused instead of loaded.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, deflateSync } from 'node:zlib';
import { ProjectIndex } from '../platform/src/platform/state/project-index.js';
import { ReadTool } from '../platform/src/platform/tools/read/index.js';
import { MAX_READ_FILE_BYTES } from '../platform/src/platform/tools/read/file-readers.js';
import { listArchiveContents, resizeImage } from '../platform/src/platform/tools/read/media.js';
import { extractOutline } from '../platform/src/platform/tools/read/text.js';

let root: string;
let index: ProjectIndex;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'read-media-'));
  index = new ProjectIndex(root);
});
afterEach(async () => { await index.dispose(); rmSync(root, { recursive: true, force: true }); });

type ReadResult = { success: boolean; output?: string; error?: string; _images?: readonly { path: string; mediaType: string }[] };
const parse = (result: ReadResult) => ({ ...JSON.parse(result.output!) as {
  files: Array<{ path: string; error?: string; content?: string; mediaType?: string; lineCount: number }>;
  summary: Record<string, unknown>;
  pagination?: unknown;
}, images: result._images });

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);

describe('images', () => {
  test('a resized image reports the type it was re-encoded to, not the file extension', async () => {
    const fakeSharp = (() => {
      const instance = {
        metadata: async () => ({ width: 3000, height: 1000 }),
        resize: () => instance,
        jpeg: () => instance,
        png: () => instance,
        toBuffer: async () => ({ data: Buffer.from('re-encoded'), info: { width: 1568, height: 523 } }),
      };
      return instance;
    }) as never;
    const webp = await resizeImage(Buffer.from('webp-bytes'), 'image/webp', 1568, async () => fakeSharp);
    expect(webp).toMatchObject({ resized: true, mediaType: 'image/png' });
    const jpeg = await resizeImage(Buffer.from('jpeg-bytes'), 'image/jpeg', 1568, async () => fakeSharp);
    expect(jpeg).toMatchObject({ resized: true, mediaType: 'image/jpeg' });
  });

  test('a read of a large .webp reports the PNG it was re-encoded to', async () => {
    const webpHead = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);
    writeFileSync(join(root, 'big.webp'), webpHead);
    const fakeSharp = (() => {
      const instance = {
        metadata: async () => ({ width: 3000, height: 1000 }),
        resize: () => instance,
        jpeg: () => instance,
        png: () => instance,
        toBuffer: async () => ({ data: Buffer.from('re-encoded'), info: { width: 1568, height: 523 } }),
      };
      return instance;
    }) as never;
    const tool = new ReadTool(index, undefined, undefined, undefined, undefined, undefined, async () => fakeSharp);
    const result = await tool.execute({ files: [{ path: 'big.webp' }] });
    expect(result.success).toBe(true);
    expect(parse(result).images?.[0]?.mediaType).toBe('image/png');
  });

  test('a text file named .png is refused, not sent to the model as an image', async () => {
    writeFileSync(join(root, 'asset.png'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n');
    const result = await new ReadTool(index).execute({ files: [{ path: 'asset.png' }] });
    expect(result.success).toBe(false);
    const output = parse(result);
    expect(output.images).toBeUndefined();
    expect(output.files[0]!.error).toContain('not an image');
  });

  test('a real image under the wrong extension is sent under its true media type', async () => {
    writeFileSync(join(root, 'photo.png'), JPEG_HEAD);
    const result = await new ReadTool(index).execute({ files: [{ path: 'photo.png' }] });
    expect(result.success).toBe(true);
    expect(parse(result).images?.[0]?.mediaType).toBe('image/jpeg');
  });

  test('a genuine image is unchanged', async () => {
    writeFileSync(join(root, 'ok.png'), PNG_HEAD);
    const result = await new ReadTool(index).execute({ files: [{ path: 'ok.png' }] });
    expect(parse(result).images?.[0]?.mediaType).toBe('image/png');
  });
});

describe('archives', () => {
  const tarWith = (name: string, body: string): Buffer => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('ustar', 257, 'ascii');
    const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    data.write(body, 0, 'utf8');
    return Buffer.concat([header, data, Buffer.alloc(1024)]);
  };

  test('a gzipped log is reported as one compressed file, not as a tar entry named after its first bytes', () => {
    const listing = listArchiveContents('/x/app.log.gz', gzipSync('2026-01-01 INFO started\n'), '.gz');
    expect(listing).toContain('gzip of a single file');
    expect(listing).not.toContain('INFO started');
  });

  test('a gzipped tar lists its entries', () => {
    const listing = listArchiveContents('/x/a.tgz', gzipSync(tarWith('docs/readme.md', 'hello')), '.tgz');
    expect(listing).toContain('Archive (1 files)');
    expect(listing).toContain('docs/readme.md');
  });

  test('a plain tar lists its entries with sizes', () => {
    const listing = listArchiveContents('/x/a.tar', tarWith('src/a.txt', 'hello'), '.tar');
    expect(listing).toContain('Archive (1 files)');
    expect(listing).toContain('src/a.txt (5 B)');
  });

  // One stored entry: local header, name, data, central directory entry, end-of-central-directory record.
  const zipWith = (name: string, body: string, eocdOverride?: { size?: number; offset?: number }): Buffer => {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    const localPart = Buffer.concat([local, nameBytes, data]);
    const centralPart = Buffer.concat([central, nameBytes]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(eocdOverride?.size ?? centralPart.length, 12);
    eocd.writeUInt32LE(eocdOverride?.offset ?? localPart.length, 16);
    return Buffer.concat([localPart, centralPart, eocd]);
  };

  test('a zip lists the name and size of each entry', () => {
    const listing = listArchiveContents('/x/a.zip', zipWith('docs/readme.md', 'hello world'), '.zip');
    expect(listing).toContain('Archive (1 files)');
    expect(listing).toContain('docs/readme.md (11 B)');
  });

  test('a zip64 archive is refused rather than listed as empty', () => {
    expect(() => listArchiveContents('/x/big.zip', zipWith('a.txt', 'x', { offset: 0xffffffff }), '.zip')).toThrow('zip64');
  });

  test('a corrupt gzip is an error, not a listing', () => {
    expect(() => listArchiveContents('/x/bad.gz', Buffer.from('not gzip data at all'), '.gz')).toThrow();
  });

  test('a gzip that expands past the cap is refused with the cap named', () => {
    expect(() => listArchiveContents('/x/bomb.gz', gzipSync(Buffer.alloc(64 * 1024)), '.gz', 1024)).toThrow('expands beyond');
  });

  test('an archive that cannot be listed is a failed read, not a placeholder listing', async () => {
    writeFileSync(join(root, 'broken.zip'), 'this is not a zip archive at all');
    const result = await new ReadTool(index).execute({ files: [{ path: 'broken.zip' }] });
    expect(result.success).toBe(false);
    expect(parse(result).files[0]!.error).toContain('Cannot list archive');
  });
});

describe('notebooks', () => {
  test('cells are listed with their type, source and text output', async () => {
    writeFileSync(join(root, 'n.ipynb'), JSON.stringify({ cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'intro'] },
      { cell_type: 'code', source: 'print(1)', outputs: [{ output_type: 'stream', text: ['1\n'] }] },
    ] }));
    const result = await new ReadTool(index).execute({ files: [{ path: 'n.ipynb' }] });
    expect(result.success).toBe(true);
    const content = parse(result).files[0]!.content!;
    expect(content).toContain('[cell 1] (markdown):');
    expect(content).toContain('# Title\nintro');
    expect(content).toContain('[cell 2] (code):\nprint(1)\n[output]:\n1');
  });
});

describe('line counts', () => {
  test('a file ending in a newline has the lines it shows, and a range past them is refused naming that count', async () => {
    writeFileSync(join(root, 'three.txt'), 'a\nb\nc\n');
    const tool = new ReadTool(index);
    expect(parse(await tool.execute({ files: [{ path: 'three.txt' }] })).files[0]!.lineCount).toBe(3);
    const past = await tool.execute({ files: [{ path: 'three.txt', range: { start: 4, end: 5 } }] });
    expect(past.success).toBe(false);
    expect(parse(past).files[0]!.error).toContain('which has 3 lines');
  });
});

describe('limits', () => {
  test('a file past the read limit is refused before it is loaded', async () => {
    const path = join(root, 'huge.log');
    writeFileSync(path, '');
    truncateSync(path, MAX_READ_FILE_BYTES + 1);
    const result = await new ReadTool(index).execute({ files: [{ path: 'huge.log' }] });
    expect(result.success).toBe(false);
    expect(parse(result).files[0]!.error).toContain('read limit');
  });
});

describe('ranges and pages', () => {
  beforeEach(() => writeFileSync(join(root, 'short.ts'), 'a\nb\nc\n'));

  test('a range past the end of the file is an error that names the line count', async () => {
    const result = await new ReadTool(index).execute({ files: [{ path: 'short.ts', extract: 'lines', range: { start: 500, end: 600 } }] });
    expect(result.success).toBe(false);
    expect(parse(result).files[0]!.error).toMatch(/outside this file, which has \d+ lines/);
  });

  test('a range inside the file still reads', async () => {
    const result = await new ReadTool(index).execute({ files: [{ path: 'short.ts', extract: 'lines', range: { start: 2, end: 3 } }] });
    expect(parse(result).files[0]!.content).toContain('b');
  });

  test('a page past the last is refused instead of repeating the last page', async () => {
    const result = await new ReadTool(index).execute({ files: [{ path: 'short.ts' }], token_budget: 1000, page: 4 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('past the last page');
  });

  test('page without a token budget is refused instead of ignored', async () => {
    const result = await new ReadTool(index).execute({ files: [{ path: 'short.ts' }], page: 2 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('token_budget');
  });
});

describe('PDF', () => {
  test('the pages argument is not pretended to apply: the text is labelled approximate and says so', async () => {
    const content = 'BT (Hello page one) Tj ET';
    const stream = deflateSync(Buffer.from(content)).toString('binary');
    writeFileSync(join(root, 'doc.pdf'), Buffer.from(`%PDF-1.4\n1 0 obj\nstream\n${stream}\nendstream\nendobj\n`, 'binary'));
    const result = await new ReadTool(index).execute({ files: [{ path: 'doc.pdf', pages: '2' }] });
    const text = parse(result).files[0]!.content!;
    expect(text).toContain('approximate');
    expect(text).toContain('pages argument (2) was not applied');
    expect(text).toContain('Hello page one');
  });
});

describe('outline fallback note', () => {
  const lines = ['export const x = 1;'];
  test('says the parser found nothing when it ran, and unavailable only when it failed', async () => {
    const empty = await extractOutline('a.ts', lines.join('\n'), lines, false, { getOutline: async () => [], getSymbols: async () => [] });
    expect(empty).toContain('returned no entries');
    expect(empty).not.toContain('unavailable');
    const failed = await extractOutline('a.ts', lines.join('\n'), lines, false, {
      getOutline: async () => { throw new Error('no grammar'); },
      getSymbols: async () => [],
    });
    expect(failed).toContain('unavailable');
  });
});

describe('links inside the project', () => {
  test('a link is judged by where it leads, so a denied target cannot be read through it', async () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'secret.env'), 'TOKEN=abc\n');
    symlinkSync(join(root, 'secret.env'), join(root, 'docs', 'notes.txt'));
    writeFileSync(join(root, 'docs', 'plain.txt'), 'fine\n');
    const denySecret = async (path: string) => !path.endsWith('secret.env');
    const tool = new ReadTool(index, undefined, undefined, denySecret);
    const result = await tool.execute({ files: [{ path: 'docs/notes.txt' }, { path: 'docs/plain.txt' }] });
    const files = parse(result).files;
    expect(files[0]!.error).toContain('Access restricted');
    expect(files[0]!.content).toBeUndefined();
    expect(files[1]!.content).toContain('fine');
  });
});
