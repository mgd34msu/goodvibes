import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPinnedWorkspaceVersion } from '@goodvibes-jev/engine/toolchain';

const ROOT = join(import.meta.dir, '..');

function readRequiredExactSemver(value: unknown, label: string): string {
  if (!isPinnedWorkspaceVersion(value)) {
    throw new Error(`${label} must be a pinned semantic version, such as 3.0.0 or 3.0.0-dev.0.`);
  }
  return value;
}

export function syncVersionSurfaces(root = ROOT): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    readonly version?: unknown;
  };
  const version = readRequiredExactSemver(pkg.version, 'package.json version');

  const versionTsPath = join(root, 'src', 'version.ts');
  if (existsSync(versionTsPath)) {
    let versionTs = readFileSync(versionTsPath, 'utf8');
    const versionFallbackPattern = /let _version = '[^']*'/;
    if (!versionFallbackPattern.test(versionTs)) {
      throw new Error('src/version.ts is missing the _version fallback literal.');
    }
    versionTs = versionTs.replace(versionFallbackPattern, `let _version = '${version}'`);
    writeFileSync(versionTsPath, versionTs);
    console.log(`prebuild: src/version.ts fallback -> ${version}`);
  } else {
    console.log('prebuild: src/version.ts - not found, skipping');
  }

  return version;
}

export function syncProjectSurfaces(root = ROOT): string {
  const version = syncVersionSurfaces(root);
  console.log(`prebuild: done (v${version})`);
  return version;
}
