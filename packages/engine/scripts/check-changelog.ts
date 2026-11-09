/**
 * Changelog gate: verifies that CHANGELOG.md contains a section header
 * matching the current @goodvibes-jev/engine/platform version before release.
 *
 * Usage:
 *   bun scripts/check-changelog.ts
 *
 * Exit 0 when the section is present. Exit 1 with a clear error when missing.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChangelogSection, readPackage } from './release-shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const enginePkgPath = resolve(ROOT, 'package.json');
const changelogPath = resolve(ROOT, 'CHANGELOG.md');

if (!existsSync(enginePkgPath)) {
  console.error(`[changelog-check] ERROR: package.json not found at ${enginePkgPath}`);
  process.exit(1);
}

if (!existsSync(changelogPath)) {
  console.error(
    `[changelog-check] ERROR: CHANGELOG.md not found at ${changelogPath}\n` +
    `  Create it with a ## [X.Y.Z] section before releasing.`,
  );
  process.exit(1);
}

const enginePkg = readPackage('.');
const version = enginePkg.version;

if (!version || typeof version !== 'string') {
  console.error('[changelog-check] ERROR: Could not read version from package.json');
  process.exit(1);
}

try {
  assertChangelogSection(version, 'changelog-check');
} catch (error) {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}

console.log(`[changelog-check] OK, CHANGELOG.md contains section for v${version}`);
