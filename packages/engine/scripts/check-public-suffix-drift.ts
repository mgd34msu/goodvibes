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
 * Both sections of the list are compared, ICANN and PRIVATE, each against its
 * own bundled tables: a private-section suffix (`weebly.com`, `onrender.com`)
 * the snapshot lacks makes two tenants of one host compare equal, which is the
 * same hole.
 *
 * A suffix we carry that upstream has REMOVED is the opposite error: the
 * comparison becomes needlessly narrow and a legitimate link is refused. That
 * is a correctness bug rather than a security hole, so it is reported as STALE.
 * In the ICANN section it also fails. In the private section, which churns by
 * the week, it is reported and does not fail, so that churn never keeps the
 * check red for the safe direction. Every message says which kind it is, so
 * whoever picks it up knows whether they are fixing a hole or an annoyance.
 *
 * Fixing either is a DATA-ONLY change: regenerate the tables with
 * `bun packages/engine/scripts/generate-public-suffix-data.ts`.
 *
 * Usage:
 *   bun scripts/check-public-suffix-drift.ts            # fails on drift
 *   bun scripts/check-public-suffix-drift.ts --report   # prints, exits 0
 */

import {
  bundledPublicSuffixRules,
  type BundledPublicSuffixRules,
  type BundledPublicSuffixSnapshot,
} from '../platform/src/platform/security/public-suffix.ts';
import { parsePublicSuffixList, UPSTREAM_URL, type PublicSuffixRules } from './public-suffix-source.ts';

/** One section's drift. */
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

/** The drift of both sections of the list. */
export interface PublicSuffixListDrift {
  readonly icann: PublicSuffixDrift;
  readonly private: PublicSuffixDrift;
}

function difference(from: Iterable<string>, other: ReadonlySet<string>): string[] {
  return [...from].filter((value) => !other.has(value)).sort();
}

function compareSection(upstream: PublicSuffixRules, bundled: BundledPublicSuffixRules): PublicSuffixDrift {
  return {
    // An upstream plain rule that the snapshot keeps as a wildcard parent is covered.
    missing: difference(upstream.multiLabel, bundled.multiLabel).filter((suffix) => !bundled.wildcardParents.has(suffix)),
    stale: difference(bundled.multiLabel, upstream.multiLabel),
    missingWildcards: difference(upstream.wildcardParents, bundled.wildcardParents),
    staleWildcards: difference(bundled.wildcardParents, upstream.wildcardParents),
    missingExceptions: difference(upstream.exceptions, bundled.exceptions),
    staleExceptions: difference(bundled.exceptions, upstream.exceptions),
    upstreamMultiLabelCount: upstream.multiLabel.size,
  };
}

/** Compares the bundled data with an upstream list text, each section against its own tables. */
export function comparePublicSuffixList(text: string, bundled: BundledPublicSuffixSnapshot): PublicSuffixListDrift {
  const upstream = parsePublicSuffixList(text);
  return {
    icann: compareSection(upstream.icann, bundled.icann),
    private: compareSection(upstream.private, bundled.private),
  };
}

/** Rules upstream has that the snapshot lacks, or an exception it keeps that upstream dropped: a widened comparison. */
function securityRelevant(drift: PublicSuffixDrift): number {
  return drift.missing.length + drift.missingWildcards.length + drift.staleExceptions.length;
}

/** The opposite direction: a needlessly narrow comparison. */
function correctness(drift: PublicSuffixDrift): number {
  return drift.stale.length + drift.staleWildcards.length + drift.missingExceptions.length;
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
  const bundled = bundledPublicSuffixRules();

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
  for (const [name, rules, sectionDrift] of [
    ['ICANN', bundled.icann, drift.icann],
    ['PRIVATE', bundled.private, drift.private],
  ] as const) {
    console.log(
      `public-suffix drift: ${name} bundled ${String(rules.multiLabel.size)} multi-label, `
      + `${String(rules.wildcardParents.size)} wildcard, ${String(rules.exceptions.size)} exception; `
      + `upstream multi-label ${String(sectionDrift.upstreamMultiLabelCount)}.`,
    );
  }

  const failing = securityRelevant(drift.icann) + securityRelevant(drift.private) + correctness(drift.icann);
  const reported = failing + correctness(drift.private);
  if (reported === 0) {
    console.log('public-suffix drift: OK, the bundled multi-label, wildcard and exception rules match both sections upstream.');
    return;
  }

  for (const [name, sectionDrift] of [['ICANN', drift.icann], ['PRIVATE', drift.private]] as const) {
    printGroup(`SECURITY-RELEVANT (${name})`, 'multi-label suffix(es) upstream has and the snapshot does not (two different registrants compare equal)', '+', sectionDrift.missing);
    printGroup(`SECURITY-RELEVANT (${name})`, 'wildcard rule(s) upstream has and the snapshot does not (every label under the parent is a suffix)', '+', sectionDrift.missingWildcards);
    printGroup(`SECURITY-RELEVANT (${name})`, 'exception rule(s) the snapshot carries that upstream dropped (a suffix would look registrable)', '-', sectionDrift.staleExceptions);
  }
  printGroup('CORRECTNESS (ICANN)', 'suffix(es) the snapshot carries that upstream no longer lists (a legitimate link may be refused)', '-', drift.icann.stale);
  printGroup('CORRECTNESS (ICANN)', 'wildcard rule(s) the snapshot carries that upstream dropped', '-', drift.icann.staleWildcards);
  printGroup('CORRECTNESS (ICANN)', 'exception rule(s) upstream has and the snapshot does not (a wildcard over-matches)', '+', drift.icann.missingExceptions);
  printGroup('CORRECTNESS (PRIVATE, does not fail the check)', 'suffix(es) the snapshot carries that upstream no longer lists (a legitimate link may be refused)', '-', drift.private.stale);
  printGroup('CORRECTNESS (PRIVATE, does not fail the check)', 'wildcard rule(s) the snapshot carries that upstream dropped', '-', drift.private.staleWildcards);
  printGroup('CORRECTNESS (PRIVATE, does not fail the check)', 'exception rule(s) upstream has and the snapshot does not (a wildcard over-matches)', '+', drift.private.missingExceptions);

  console.error('');
  console.error('This is a DATA-ONLY fix: regenerate the tables with');
  console.error('  bun packages/engine/scripts/generate-public-suffix-data.ts');
  console.error('Do not edit the generated file by hand, and do not delete an entry to quiet this check.');
  console.error('');
  console.error('Note the blast radius before treating this as urgent: the module falls back to a');
  console.error('single-label suffix for anything it does not know, which is CORRECT for com, dev,');
  console.error('app and every new gTLD. Staleness narrows coverage; it does not break resolution.');

  if (!reportOnly && failing > 0) process.exit(1);
}

if (import.meta.main) await main();
