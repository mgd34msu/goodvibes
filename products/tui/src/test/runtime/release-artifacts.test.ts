import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveArtifactNames, resolveSqliteVecAsset } from '../../runtime/release-artifacts.ts';

// The addon asset names are a wire contract with the suite installer, which
// downloads them by name. The installer's own platform table is read here, so
// a rename in the installer fails this test instead of silently breaking
// vector search on installed binaries. (The release workflow packages the same
// names; the installer test suite covers that half.)
const installer = readFileSync(join(import.meta.dir, '../../../../../scripts/install.sh'), 'utf8');

/** The installer's addon naming for one release-binary platform tag, read from its `case "$os_tag"` table. */
function installerAddonNaming(osTag: 'linux' | 'macos'): { vecOs: string; suffix: string } {
  const match = new RegExp(`${osTag}\\) VEC_OS="(\\w+)"; VEC_SUFFIX="(\\w+)"`).exec(installer);
  if (!match) throw new Error(`scripts/install.sh has no sqlite-vec naming for ${osTag}`);
  return { vecOs: match[1]!, suffix: match[2]! };
}

/** The installer's release-binary platform tag for a `uname -s` value. */
function installerBinaryTag(uname: 'Linux' | 'Darwin'): string {
  const match = new RegExp(`${uname}\\) os_tag="(\\w+)"`).exec(installer);
  if (!match) throw new Error(`scripts/install.sh has no release platform tag for ${uname}`);
  return match[1]!;
}

describe('resolveArtifactNames follows the installer', () => {
  for (const [platform, uname] of [['linux', 'Linux'], ['darwin', 'Darwin']] as const) {
    test(`${platform} binaries are named with the installer's platform tag`, () => {
      expect(resolveArtifactNames(platform, 'arm64')?.app).toBe(`goodvibes-${installerBinaryTag(uname)}-arm64`);
    });
  }
});

describe('resolveSqliteVecAsset follows the installer', () => {
  for (const [platform, osTag] of [['linux', 'linux'], ['darwin', 'macos']] as const) {
    for (const arch of ['x64', 'arm64'] as const) {
      test(`${platform} ${arch} resolves the asset the installer downloads`, () => {
        const { vecOs, suffix } = installerAddonNaming(osTag);
        expect(resolveSqliteVecAsset(platform, arch)).toEqual({
          assetName: `sqlite-vec-${vecOs}-${arch}.${suffix}`,
          dirName: `sqlite-vec-${vecOs}-${arch}`,
          fileName: `vec0.${suffix}`,
        });
      });
    }
  }

  test('the installer downloads the addon under the name it computes from those tags', () => {
    expect(installer).toContain('fetch_release_asset "sqlite-vec-$VEC_OS-$arch_tag.$VEC_SUFFIX"');
  });
});

describe('resolveSqliteVecAsset', () => {
  test('returns null for unsupported platform or arch', () => {
    expect(resolveSqliteVecAsset('win32', 'x64')).toBeNull();
    expect(resolveSqliteVecAsset('linux', 'riscv64')).toBeNull();
  });
});
