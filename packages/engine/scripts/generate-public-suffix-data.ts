#!/usr/bin/env bun
/**
 * generate-public-suffix-data.ts
 *
 * Regenerates the bundled public-suffix data from upstream: both sections of
 * the list, ICANN and PRIVATE, each in its own tables. This is the "refresh"
 * the drift check tells you to run, and it is deliberately a generator rather
 * than a hand-edit: a hand-kept subset leaves every suffix it omits as one
 * under which two different registrants (or two tenants of one host) compare
 * equal.
 *
 * Run:  bun scripts/generate-public-suffix-data.ts
 * Then: bun scripts/check-public-suffix-drift.ts   (should print OK)
 */

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIN_MULTI_LABEL_SUFFIXES,
  MIN_PRIVATE_RULES,
  parsePublicSuffixList,
  ruleCount,
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
  readonly privateRules: number;
} {
  const { icann, private: privateRules } = parsePublicSuffixList(text);
  if (icann.multiLabel.size < MIN_MULTI_LABEL_SUFFIXES || ruleCount(privateRules) < MIN_PRIVATE_RULES) {
    throw new Error(
      `public-suffix: the bundled data was left unchanged. The fetched list has only ${String(icann.multiLabel.size)} `
      + `multi-label ICANN suffixes and ${String(ruleCount(privateRules))} private-section rules (the real one has more than `
      + `${String(MIN_MULTI_LABEL_SUFFIXES)} and ${String(MIN_PRIVATE_RULES)}), so it is not the full list. `
      + `Check ${UPSTREAM_URL} and run the generator again.`,
    );
  }
  const source = `// GENERATED FILE — do not edit by hand.
//
// Regenerate with:  bun scripts/generate-public-suffix-data.ts
// Drift is caught by the weekly Public Suffix Drift workflow, which FAILS
// rather than warns. See security/public-suffix.ts for what the data is for
// and why it is bundled rather than fetched at runtime.
//
// Source: ${UPSTREAM_URL}, both sections: ICANN (suffixes delegated by
// registries) and PRIVATE (hosts that give each customer its own name, so two
// tenants under one are different registrants). Each section has its own tables.
//
// Snapshot taken: ${snapshotDate}

/** ICANN multi-label public suffixes. Single-label suffixes need no rule, see the module header. */
export const PUBLIC_SUFFIX_MULTI_LABEL: readonly string[] = [
${serialize(icann.multiLabel)}
];

/** ICANN \`*.parent\` rules: every label directly under these is itself a suffix. */
export const PUBLIC_SUFFIX_WILDCARD_PARENTS: readonly string[] = [
${serialize(icann.wildcardParents)}
];

/** ICANN \`!exception\` rules: these are registrable despite matching a wildcard above. */
export const PUBLIC_SUFFIX_EXCEPTIONS: readonly string[] = [
${serialize(icann.exceptions)}
];

/** PRIVATE-section multi-label public suffixes. */
export const PUBLIC_SUFFIX_PRIVATE_MULTI_LABEL: readonly string[] = [
${serialize(privateRules.multiLabel)}
];

/** PRIVATE-section \`*.parent\` rules. */
export const PUBLIC_SUFFIX_PRIVATE_WILDCARD_PARENTS: readonly string[] = [
${serialize(privateRules.wildcardParents)}
];

/** PRIVATE-section \`!exception\` rules. */
export const PUBLIC_SUFFIX_PRIVATE_EXCEPTIONS: readonly string[] = [
${serialize(privateRules.exceptions)}
];
`;

  return {
    source,
    multiLabel: icann.multiLabel.size + privateRules.multiLabel.size,
    wildcardParents: icann.wildcardParents.size + privateRules.wildcardParents.size,
    exceptions: icann.exceptions.size + privateRules.exceptions.size,
    privateRules: ruleCount(privateRules),
  };
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
    `wrote ${target}\n  multi-label: ${String(rendered.multiLabel)}\n  wildcard parents: ${String(rendered.wildcardParents)}\n  exceptions: ${String(rendered.exceptions)}\n  of which private-section rules: ${String(rendered.privateRules)}`,
  );
}
