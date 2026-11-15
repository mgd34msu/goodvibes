import { describe, expect, test } from 'bun:test';
import { createZipArchive } from '../../tools/artifact-archive.ts';

const UTF8_FLAG = 0x0800;

/** General-purpose flags of the first local header and the first central header. */
function flags(zip: Buffer): { local: number; central: number } {
  const centralOffset = zip.readUInt32LE(zip.length - 22 + 16);
  return { local: zip.readUInt16LE(6), central: zip.readUInt16LE(centralOffset + 8) };
}

describe('ZIP entry names', () => {
  test('a non-ASCII name is flagged as UTF-8 in both headers so unzip tools do not read it as CP437', () => {
    const zip = createZipArchive([{ path: 'é.txt', buffer: Buffer.from('x') }]);
    const { local, central } = flags(zip);
    expect(local & UTF8_FLAG).toBe(UTF8_FLAG);
    expect(central & UTF8_FLAG).toBe(UTF8_FLAG);
  });

  test('an ASCII name keeps the plain flags', () => {
    const zip = createZipArchive([{ path: 'a.txt', buffer: Buffer.from('x') }]);
    expect(flags(zip)).toEqual({ local: 0, central: 0 });
  });
});
