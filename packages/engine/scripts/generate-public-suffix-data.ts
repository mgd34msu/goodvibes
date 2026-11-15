#!/usr/bin/env bun
/**
 * generate-public-suffix-data.ts
 *
 * Regenerates the bundled public-suffix data from upstream. This is the
 * "refresh" the drift check tells you to run, and it is deliberately a
 * generator rather than a hand-edit: the first hand-curated snapshot carried
 * 174 of the 5,484 multi-label ICANN suffixes, which left 5,332 suffixes under
 * which two different registrants compared equal. Curation by hand is how that
 * happens.
 *
 * Run:  bun scripts/generate-public-suffix-data.ts
 * Then: bun scripts/check-public-suffix-drift.ts   (should print OK)
 */

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CURATED_PRIVATE_SUFFIXES,
  MIN_MULTI_LABEL_SUFFIXES,
  parsePublicSuffixList,
  UPSTREAM_URL,
} from './public-suffix-source.ts';

function serialize(values: Iterable<string>): string {
  return [...values].sort().map((value) => `  '${value}',`).join('\n');
}

/**
 * The generated data file for an upstream list text. Throws, writing nothing,
 * when the list does not look like the real one.
 */
export function renderPublicSuffixData(text: string, snapshotDate: string): {
  readonly source: string;
  readonly multiLabel: number;
  readonly wildcardParents: number;
  readonly exceptions: number;
} {
  const parsed = parsePublicSuffixList(text);
  const multiLabel = new Set(parsed.multiLabel);
  for (const suffix of CURATED_PRIVATE_SUFFIXES) multiLabel.add(suffix);
  if (parsed.multiLabel.size < MIN_MULTI_LABEL_SUFFIXES) {
    throw new Error(
      `public-suffix: the upstream list has only ${String(parsed.multiLabel.size)} multi-label ICANN suffixes `
      + `(expected more than ${String(MIN_MULTI_LABEL_SUFFIXES)}); refusing to overwrite the bundled data.`,
    );
  }
  const { wildcardParents, exceptions } = parsed;
  const source = `// GENERATED FILE — do not edit by hand.
//
// Regenerate with:  bun scripts/generate-public-suffix-data.ts
// Drift is caught by the weekly Public Suffix Drift workflow, which FAILS
// rather than warns. See security/public-suffix.ts for what the data is for
// and why it is bundled rather than fetched at runtime.
//
// Source: ${UPSTREAM_URL} (ICANN section) plus a small hand-kept set of
// private-section hosting suffixes where two sites under one suffix are
// genuinely different registrants.
//
// Snapshot taken: ${snapshotDate}

/** Multi-label public suffixes. Single-label suffixes need no rule, see the module header. */
export const PUBLIC_SUFFIX_MULTI_LABEL: readonly string[] = [
${serialize(multiLabel)}
];

/** \`*.parent\` rules: every label directly under these is itself a suffix. */
export const PUBLIC_SUFFIX_WILDCARD_PARENTS: readonly string[] = [
${serialize(wildcardParents)}
];

/** \`!exception\` rules: these are registrable despite matching a wildcard above. */
export const PUBLIC_SUFFIX_EXCEPTIONS: readonly string[] = [
${serialize(exceptions)}
];
`;

  return { source, multiLabel: multiLabel.size, wildcardParents: wildcardParents.size, exceptions: exceptions.size };
}

if (import.meta.main) {
  const response = await fetch(UPSTREAM_URL);
  if (!response.ok) throw new Error(`upstream fetch failed: HTTP ${String(response.status)}`);
  const rendered = renderPublicSuffixData(await response.text(), new Date().toISOString().slice(0, 10));
  const target = join(
    import.meta.dir,
    '..',
    'platform/src/platform/security/generated/public-suffix-data.ts',
  );
  // Write beside the target and rename, so an interrupted run never leaves half a file.
  const staging = `${target}.tmp`;
  writeFileSync(staging, rendered.source, 'utf8');
  renameSync(staging, target);
  console.log(
    `wrote ${target}\n  multi-label: ${String(rendered.multiLabel)}\n  wildcard parents: ${String(rendered.wildcardParents)}\n  exceptions: ${String(rendered.exceptions)}`,
  );
}
