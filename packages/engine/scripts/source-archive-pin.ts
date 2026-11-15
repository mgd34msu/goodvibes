import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Checks a downloaded source archive against its pinned sha256 before anything
 * is built from it. Throws, naming the computed digest, when the pin is absent
 * or different; that digest is what a reviewer verifies upstream and records.
 */
export function verifySourceArchive(archivePath: string, label: string, expectedSha256: string | undefined): void {
  const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  if (expectedSha256 === undefined || expectedSha256.length === 0) {
    throw new Error(
      `${label}: no sha256 pin for this source archive (computed ${actual}). `
      + 'Verify that digest against upstream, then add it to the pin table or pass --source-sha256.',
    );
  }
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`${label}: source archive sha256 ${actual} does not match the pin ${expectedSha256}; refusing to build from it.`);
  }
}
