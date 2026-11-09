/** Original physical group-state ownership, authored and UNRUN. */
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupStateOwner } from '../platform/src/platform/cluster/group-state-owner.ts';
test('own atomic publications advance only their original source and preserve private mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'cluster-owned-state-'));
  try {
    const directory = join(root, 'missing', 'state'), owner = new GroupStateOwner(directory, ['group-state.json', 'group-config.json']);
    owner.write('group-state.json', '{"revision":1}\n', true); owner.write('group-state.json', '{"revision":2}\n', true); owner.assertCurrent();
    expect(readFileSync(join(directory, 'group-state.json'), 'utf8')).toBe('{"revision":2}\n'); expect(statSync(join(directory, 'group-state.json')).mode & 0o777).toBe(0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('equal-byte foreign inode replacement is preserved rather than adopted as a new write source', () => {
  const root = mkdtempSync(join(tmpdir(), 'cluster-foreign-state-'));
  try {
    const path = join(root, 'group-state.json'); writeFileSync(path, '{}\n'); const owner = new GroupStateOwner(root, ['group-state.json']);
    renameSync(path, `${path}.original`); writeFileSync(path, '{}\n');
    expect(() => owner.write('group-state.json', '{"foreign":false}\n', true)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{}\n'); expect(readFileSync(`${path}.original`, 'utf8')).toBe('{}\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('an original configured alias works, but replacing it cannot create files in the replacement tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'cluster-alias-state-'));
  try {
    const original = join(root, 'original'), foreign = join(root, 'foreign'), alias = join(root, 'alias'); mkdirSync(original); mkdirSync(foreign); symlinkSync(original, alias);
    const owner = new GroupStateOwner(join(alias, 'state'), ['group-state.json']);
    owner.write('group-state.json', '{}\n', true);
    unlinkSync(alias); symlinkSync(foreign, alias);
    expect(() => owner.write('group-state.json', '{}\n', true)).toThrow(); expect(statSync(foreign).isDirectory()).toBe(true);
    expect(() => statSync(join(foreign, 'state'))).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('a publication whose directory durability failed never becomes the owner of a later write', () => {
  const root = mkdtempSync(join(tmpdir(), 'cluster-unknown-state-'));
  try {
    const owner = new GroupStateOwner(root, ['group-state.json']);
    const native = fs.fsyncSync;
    const durability = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('fixture directory durability unavailable'), { code: 'EIO' });
      return native(fd);
    });
    try { expect(() => owner.write('group-state.json', '{"unconfirmed":true}\n', true)).toThrow(); }
    finally { durability.mockRestore(); }
    const path = join(root, 'group-state.json');
    expect(readFileSync(path, 'utf8')).toBe('{"unconfirmed":true}\n');
    expect(() => owner.write('group-state.json', '{"retried":true}\n', true)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{"unconfirmed":true}\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
