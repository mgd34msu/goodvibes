#!/usr/bin/env bun
/**
 * check-public-suffix-drift.ts
 *
 * Compares the BUNDLED public-suffix snapshot
 * (platform/src/platform/security/generated/public-suffix-data.ts) against the upstream
 * Mozilla Public Suffix List, and FAILS on drift.
 *
 * ── Why bundled, and why a separate check ─────────────────────────────────
 *
 * The list is bundled and never fetched at runtime. A security gate that
 * reaches the network to reach a decision is a gate an attacker can influence
 * by making that fetch fail or hang, and the failure would land exactly when
 * validation matters. So the data ships in the package, and the cost of that
 * choice is that it can go stale. This script is how the staleness is caught.
 *
 * It runs on its own schedule, deliberately OUTSIDE the normal CI lane, so an
 * upstream publication cadence can never block a release. And it FAILS rather
 * than warns, because a nudge that cannot fail is not a guard, this platform
 * has already been bitten by exactly that, where several checks looked like
 * enforcement and none of them could go red.
 *
 * ── What counts as drift, and which direction is dangerous ────────────────
 *
 * Plain MULTI-LABEL suffixes, `*.parent` wildcard rules and `!exception` rules
 * are compared. Single-label suffixes (`com`, `dev`,
 * `app`, every new gTLD) need no rule at all: the module's fallback treats one
 * label as the suffix, which is correct for all of them. That fallback is why
 * a stale snapshot degrades in the HARMLESS direction, an unknown new gTLD
 * still resolves correctly.
 *
 * The direction that matters is a multi-label suffix upstream has and we do
 * not. Under that rule two DIFFERENT registrants compare equal, `a.foo.xx`
 * and `b.foo.xx` would both reduce to `foo.xx`, and a link check would accept
 * a stranger's domain as the authorized one. That is reported as MISSING and
 * fails the run.
 *
 * A suffix we carry that upstream has REMOVED is the opposite error: the
 * comparison becomes needlessly narrow and a legitimate link is refused. That
 * is a correctness bug rather than a security hole, so it is reported as STALE
 * and also fails, but the message says which kind it is so whoever picks it up
 * knows whether they are fixing a hole or an annoyance.
 *
 * Fixing either is a DATA-ONLY change: regenerate the tables with
 * `bun packages/engine/scripts/generate-public-suffix-data.ts`.
 *
 * Usage:
 *   bun scripts/check-public-suffix-drift.ts            # fails on drift
 *   bun scripts/check-public-suffix-drift.ts --report   # prints, exits 0
 */

import {
  bundledMultiLabelSuffixes,
  bundledWildcardSuffixParents,
} from '../platform/src/platform/security/public-suffix.ts';
import { PUBLIC_SUFFIX_EXCEPTIONS } from '../platform/src/platform/security/generated/public-suffix-data.ts';
import { CURATED_PRIVATE_SUFFIXES, parsePublicSuffixList, UPSTREAM_URL } from './public-suffix-source.ts';

export interface PublicSuffixDrift {
  /** Plain multi-label suffixes upstream has and the snapshot lacks (security-relevant). */
  readonly missing: readonly string[];
  /** Plain multi-label suffixes the snapshot carries that upstream dropped. */
  readonly stale: readonly string[];
  /** `*.parent` rules upstream has and the snapshot lacks (security-relevant). */
  readonly missingWildcards: readonly string[];
  /** `*.parent` rules the snapshot carries that upstream dropped. */
  readonly staleWildcards: readonly string[];
  /** `!exception` rules upstream has and the snapshot lacks, so a wildcard over-matches. */
  readonly missingExceptions: readonly string[];
  /** `!exception` rules the snapshot carries that upstream dropped, so a suffix looks registrable. */
  readonly staleExceptions: readonly string[];
  readonly upstreamMultiLabelCount: number;
}

function difference(from: Iterable<string>, other: ReadonlySet<string>): string[] {
  return [...from].filter((value) => !other.has(value)).sort();
}

/**
 * Compares the bundled data with an upstream list text. The private section is
 * excluded: it is thousands of churning entries, so only the hand-kept
 * CURATED_PRIVATE_SUFFIXES are carried, and those are exempt from "stale".
 */
export function comparePublicSuffixList(
  text: string,
  bundled: {
    readonly multiLabel: ReadonlySet<string>;
    readonly wildcardParents: ReadonlySet<string>;
    readonly exceptions: ReadonlySet<string>;
  },
): PublicSuffixDrift {
  const upstream = parsePublicSuffixList(text);
  const curated = new Set(CURATED_PRIVATE_SUFFIXES);
  return {
    // An upstream plain rule that the snapshot keeps as a wildcard parent is covered.
    missing: difference(upstream.multiLabel, bundled.multiLabel).filter((suffix) => !bundled.wildcardParents.has(suffix)),
    stale: difference(bundled.multiLabel, upstream.multiLabel).filter((suffix) => !curated.has(suffix)),
    missingWildcards: difference(upstream.wildcardParents, bundled.wildcardParents),
    staleWildcards: difference(bundled.wildcardParents, upstream.wildcardParents),
    missingExceptions: difference(upstream.exceptions, bundled.exceptions),
    staleExceptions: difference(bundled.exceptions, upstream.exceptions),
    upstreamMultiLabelCount: upstream.multiLabel.size,
  };
}

function printGroup(title: string, detail: string, sign: '+' | '-', values: readonly string[]): void {
  if (values.length === 0) return;
  console.error('');
  console.error(`${title}, ${String(values.length)} ${detail}`);
  for (const value of values.slice(0, 60)) console.error(`  ${sign} ${value}`);
  if (values.length > 60) console.error(`  … and ${String(values.length - 60)} more`);
}

async function main(): Promise<void> {
  const reportOnly = process.argv.includes('--report');
  const bundledMultiLabel = bundledMultiLabelSuffixes();
  const bundled = {
    multiLabel: bundledMultiLabel,
    wildcardParents: new Set(bundledWildcardSuffixParents()),
    exceptions: new Set(PUBLIC_SUFFIX_EXCEPTIONS),
  };

  let text: string;
  try {
    const response = await fetch(UPSTREAM_URL);
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    text = await response.text();
  } catch (error) {
    // A fetch failure is NOT drift and must not read as one, reporting a
    // network blip as a security finding is how a real finding gets ignored.
    console.error(
      `public-suffix drift: could not reach ${UPSTREAM_URL} (${error instanceof Error ? error.message : String(error)}).`,
    );
    console.error('This is a check failure, not a drift finding. The bundled list is unchanged and still correct.');
    process.exit(reportOnly ? 0 : 2);
  }

  const drift = comparePublicSuffixList(text, bundled);
  console.log(
    `public-suffix drift: bundled ${String(bundledMultiLabel.size)} multi-label, `
    + `${String(bundled.wildcardParents.size)} wildcard, ${String(bundled.exceptions.size)} exception; `
    + `upstream ICANN multi-label ${String(drift.upstreamMultiLabelCount)}.`,
  );

  const clean = drift.missing.length === 0 && drift.stale.length === 0
    && drift.missingWildcards.length === 0 && drift.staleWildcards.length === 0
    && drift.missingExceptions.length === 0 && drift.staleExceptions.length === 0;
  if (clean) {
    console.log('public-suffix drift: OK, the bundled multi-label, wildcard and exception rules match upstream\'s ICANN section.');
    return;
  }

  printGroup('SECURITY-RELEVANT', 'multi-label suffix(es) upstream has and the snapshot does not (two different registrants compare equal)', '+', drift.missing);
  printGroup('SECURITY-RELEVANT', 'wildcard rule(s) upstream has and the snapshot does not (every label under the parent is a suffix)', '+', drift.missingWildcards);
  printGroup('SECURITY-RELEVANT', 'exception rule(s) the snapshot carries that upstream dropped (a suffix would look registrable)', '-', drift.staleExceptions);
  printGroup('CORRECTNESS', 'suffix(es) the snapshot carries that upstream no longer lists (a legitimate link may be refused)', '-', drift.stale);
  printGroup('CORRECTNESS', 'wildcard rule(s) the snapshot carries that upstream dropped', '-', drift.staleWildcards);
  printGroup('CORRECTNESS', 'exception rule(s) upstream has and the snapshot does not (a wildcard over-matches)', '+', drift.missingExceptions);

  console.error('');
  console.error('This is a DATA-ONLY fix: regenerate the tables with');
  console.error('  bun packages/engine/scripts/generate-public-suffix-data.ts');
  console.error('Do not edit the generated file by hand, and do not delete an entry to quiet this check.');
  console.error('A hosting suffix kept on purpose belongs in CURATED_PRIVATE_SUFFIXES in');
  console.error('  packages/engine/scripts/public-suffix-source.ts');
  console.error('');
  console.error('Note the blast radius before treating this as urgent: the module falls back to a');
  console.error('single-label suffix for anything it does not know, which is CORRECT for com, dev,');
  console.error('app and every new gTLD. Staleness narrows coverage; it does not break resolution.');

  if (!reportOnly) process.exit(1);
}

if (import.meta.main) await main();
