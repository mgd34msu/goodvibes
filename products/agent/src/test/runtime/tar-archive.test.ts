import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extractTarGzEntry, extractTarGzTree, readTarGzEntries } from '../../runtime/tar-archive.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function header(path: string, size: number, typeflag = '0'): Buffer {
  const block = Buffer.alloc(512);
  block.write(path.slice(0, 100), 0, 'utf-8');
  block.write('0000644\0', 100);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124);
  block.write(typeflag, 156);
  block.write('ustar\0', 257);
  return block;
}

function entry(path: string, data: string, typeflag = '0'): Buffer[] {
  const body = Buffer.from(data);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return [header(path, body.length, typeflag), ...(body.length > 0 ? [padded] : [])];
}

const gz = (blocks: Buffer[]): Buffer => Buffer.from(gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));

describe('runtime/tar-archive', () => {
  test('a complete archive extracts every file', () => {
    const destination = makeProjectTempDir('tar-archive-ok');
    dirs.push(destination);
    const result = extractTarGzTree(gz([...entry('a.txt', 'one'), ...entry('b.txt', 'two')]), destination);
    expect(result.files).toBe(2);
  });

  test('an entry cut short by the end of the archive throws instead of reading as complete', () => {
    const destination = makeProjectTempDir('tar-archive-truncated');
    dirs.push(destination);
    const full = Buffer.concat([...entry('a.txt', 'one'), header('b.txt', 4096)]);
    const truncated = Buffer.from(gzipSync(Buffer.concat([full, Buffer.alloc(512)])));
    expect(() => extractTarGzTree(truncated, destination)).toThrow(/truncated/);
    expect(() => extractTarGzEntry(truncated, 'missing.txt')).toThrow(/truncated/);
  });

  test('an unreadable size field throws', () => {
    const bad = header('a.txt', 0);
    bad.write('zzzzzzzzzzz\0', 124);
    expect(() => [...readTarGzEntries(gz([bad]))]).toThrow(/malformed/);
  });

  test('a GNU long-name header throws rather than extracting the next entry under a truncated name', () => {
    const archive = gz([...entry('././@LongLink', `${'d/'.repeat(80)}file.txt\0`, 'L'), ...entry('d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d/d', 'x')]);
    expect(() => [...readTarGzEntries(archive)]).toThrow(/long name/);
  });

  test('a PAX path header throws, while a global PAX header stays skippable', () => {
    const record = (key: string, value: string): string => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
      return `${length}${body}`;
    };
    expect(() => [...readTarGzEntries(gz([...entry('PaxHeader', record('path', 'long/path/file.txt'), 'x'), ...entry('f', 'x')]))]).toThrow(/PAX path/);
    const entries = [...readTarGzEntries(gz([...entry('pax_global_header', record('comment', 'abc'), 'g'), ...entry('f.txt', 'x')]))];
    expect(entries.filter((candidate) => candidate.kind === 'file').map((candidate) => candidate.path)).toEqual(['f.txt']);
  });
});
