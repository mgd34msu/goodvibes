/**
 * What the write tool puts on disk is exactly what the caller sent: no content
 * is an error rather than a truncation, base64 bytes are written unchanged,
 * a text encoding that would change the text is refused, and a symbolic link is
 * written through instead of being replaced.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteTool } from '../platform/src/platform/tools/write/index.ts';
import { FileUndoManager } from '../platform/src/platform/state/file-undo.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(): string { const made = realpathSync(mkdtempSync(join(tmpdir(), 'write-content-'))); roots.push(made); return made; }
const write = (root: string, file: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  createWriteTool({ projectRoot: root }).execute({ files: [file], ...extra });

describe('content or content_base64', () => {
  test('an overwrite with neither is refused and the file keeps its content', async () => {
    const root = project(); writeFileSync(join(root, 'a.txt'), 'keep me');
    const result = await write(root, { path: 'a.txt', mode: 'overwrite' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No content');
    expect(readFileSync(join(root, 'a.txt'), 'utf-8')).toBe('keep me');
  });

  test('both together are refused', async () => {
    const root = project();
    const result = await write(root, { path: 'a.txt', content: 'x', content_base64: 'eA==' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('exactly one');
  });

  test('an empty string is a real empty file', async () => {
    const root = project();
    expect((await write(root, { path: 'empty.txt', content: '' })).success).toBe(true);
    expect(readFileSync(join(root, 'empty.txt'), 'utf-8')).toBe('');
  });

  test('base64 bytes that are not text are written unchanged and reported at their true size', async () => {
    const root = project();
    const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x80]);
    const result = await write(root, { path: 'blob.bin', content_base64: bytes.toString('base64') }, { verbosity: 'standard' });
    expect(result.success).toBe(true);
    expect(readFileSync(join(root, 'blob.bin')).equals(bytes)).toBe(true);
    expect(JSON.parse(result.output ?? '{}').bytes_written).toBe(4);
  });

  test('overwriting a binary file records no undo entry that could corrupt it', async () => {
    const root = project(); writeFileSync(join(root, 'blob.bin'), Buffer.from([0xff, 0xfe]));
    const undo = new FileUndoManager();
    const result = await createWriteTool({ projectRoot: root, fileUndoManager: undo }).execute({ files: [{ path: 'blob.bin', content: 'text', mode: 'overwrite' }] });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Undo history was not recorded');
    expect(undo.undo()).toBeNull();
  });
});

describe('text encodings', () => {
  test('hex and base64 are refused for text instead of re-reading it as bytes', async () => {
    const root = project();
    const result = await write(root, { path: 'x.txt', content: 'hello world', encoding: 'hex' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('content_base64');
  });

  test('latin1 is refused when a character does not fit', async () => {
    const root = project();
    const result = await write(root, { path: 'x.txt', content: 'snow ☃', encoding: 'latin1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot hold');
  });
});

describe('a symbolic link as the target', () => {
  test('the link is written through, stays a link, and the target keeps its mode', async () => {
    const root = project();
    writeFileSync(join(root, 'b.txt'), 'old'); chmodSync(join(root, 'b.txt'), 0o640);
    symlinkSync('b.txt', join(root, 'a.txt'));
    const result = await write(root, { path: 'a.txt', content: 'new', mode: 'overwrite' });
    expect(result.success).toBe(true);
    expect(lstatSync(join(root, 'a.txt')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'a.txt'))).toBe('b.txt');
    expect(readFileSync(join(root, 'b.txt'), 'utf-8')).toBe('new');
    expect(lstatSync(join(root, 'b.txt')).mode & 0o777).toBe(0o640);
  });
});

describe('an atomic transaction rolled back through a symbolic link', () => {
  test('the link target keeps its original mode', async () => {
    const root = project();
    writeFileSync(join(root, 'b.txt'), 'old'); chmodSync(join(root, 'b.txt'), 0o640);
    writeFileSync(join(root, 'c.txt'), 'exists');
    symlinkSync('b.txt', join(root, 'a.txt'));
    const result = await createWriteTool({ projectRoot: root }).execute({
      transaction: { mode: 'atomic' },
      files: [
        { path: 'a.txt', content: 'new', mode: 'overwrite' },
        { path: 'c.txt', content: 'clash', mode: 'fail_if_exists' },
      ],
    });
    expect(result.success).toBe(false);
    expect(readFileSync(join(root, 'b.txt'), 'utf-8')).toBe('old');
    expect(lstatSync(join(root, 'b.txt')).mode & 0o777).toBe(0o640);
    expect(lstatSync(join(root, 'a.txt')).isSymbolicLink()).toBe(true);
  });
});
