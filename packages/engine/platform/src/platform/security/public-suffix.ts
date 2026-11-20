/**
 * public-suffix.ts, the registrable domain (eTLD+1) of a host.
 *
 * ── Why this exists rather than a string comparison ───────────────────────
 *
 * Every naive host check fails to a real attack:
 *
 *   `endsWith('google.com')`      passes `google.com.evil.example`
 *   `includes('google.com')`      passes `google.com.evil.example`
 *   split on the last two labels  gets `co.uk` wrong for `bbc.co.uk`
 *
 * The only correct comparison is on the REGISTRABLE domain, the label
 * immediately below the public suffix, because that is the unit somebody had
 * to buy. `google.com.evil.example` is registrable-domain `evil.example`, and
 * so it fails against `google.com` for the right reason rather than by luck.
 *
 * ── The data, and how it stays current ────────────────────────────────────
 *
 * This is a BUNDLED SNAPSHOT of the ICANN section of Mozilla's Public Suffix
 * List, reduced to the rules that matter for the comparison this module
 * performs: the multi-label suffixes. A single-label suffix (`com`, `dev`,
 * `app`, any new gTLD) needs no rule, the fallback treats one label as the
 * suffix, which is correct for all of them.
 *
 * That fallback is what makes the snapshot safe to be slightly stale: an
 * unknown NEW suffix degrades to the single-label rule. The failure that
 * matters is the opposite direction, a multi-label suffix we do not know
 * about, e.g. a newly delegated `something.xx`, would make two distinct
 * registrants compare equal. So the list must be refreshed, and refreshing it
 * is a data change with no code change: run `bun scripts/generate-public-suffix-data.ts`
 * (never edit generated/public-suffix-data.ts by hand), then
 * `bun scripts/check-public-suffix-drift.ts`. A test pins the cases that
 * motivated each group, so a bad refresh fails rather than silently
 * widening what compares equal.
 */

import {
  PUBLIC_SUFFIX_MULTI_LABEL,
  PUBLIC_SUFFIX_WILDCARD_PARENTS,
  PUBLIC_SUFFIX_EXCEPTIONS,
} from './generated/public-suffix-data.js';

/**
 * The bundled tables, generated from upstream.
 *
 * The first version of this file carried a HAND-CURATED 174 suffixes out of
 * upstream's 5,484. That left 5,332 multi-label suffixes under which two
 * different registrants reduced to the same registrable domain, a link check
 * would have accepted a stranger's domain as the authorized one. The drift
 * check caught it on its first run. Curation by hand is how that happens, so
 * the data is generated now and the tables below are not edited directly.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set(PUBLIC_SUFFIX_MULTI_LABEL);

const NON_ASCII = /[^\x00-\x7f]/;

/**
 * A host or suffix in the form URL.hostname gives it: lowercase ASCII, an
 * internationalised label as its `xn--` (punycode) form. Null when it is not a
 * valid host. ASCII input is only lowercased, so the common case parses nothing.
 */
function asciiHost(value: string): string | null {
  const lowered = value.toLowerCase();
  if (!NON_ASCII.test(lowered)) return lowered;
  try {
    const hostname = new URL(`http://${lowered}`).hostname;
    return hostname.length > 0 && !NON_ASCII.test(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * The tables as lookups read them. The snapshot holds internationalised
 * suffixes in Unicode (`andøy.no`) while a URL's host is punycode
 * (`xn--andy-ira.no`), so every non-ASCII entry is also kept in its punycode
 * form; a host is converted the same way before the lookup. Without this an
 * IDN suffix fell back to the last two labels and two registrants under it
 * compared equal. Only the few hundred non-ASCII entries are converted, once.
 */
function withAsciiForms(entries: Iterable<string>): ReadonlySet<string> {
  const set = new Set<string>();
  for (const entry of entries) {
    set.add(entry);
    if (NON_ASCII.test(entry)) {
      const ascii = asciiHost(entry);
      if (ascii) set.add(ascii);
    }
  }
  return set;
}

const MULTI_LABEL_LOOKUP: ReadonlySet<string> = withAsciiForms(PUBLIC_SUFFIX_MULTI_LABEL);

/**
 * `*.parent` rules: every label directly under one of these is itself a
 * suffix, so two instances under it are different registrants.
 */
const WILDCARD_SUFFIX_PARENTS: readonly string[] = PUBLIC_SUFFIX_WILDCARD_PARENTS;
const WILDCARD_PARENT_SET: ReadonlySet<string> = withAsciiForms(WILDCARD_SUFFIX_PARENTS);

/**
 * `!exception` rules: the exception itself is registrable despite matching a
 * wildcard above (its suffix is the exception minus its first label).
 *
 * Checked before every other rule, which is the order the PSL algorithm
 * requires, an exception that lost to its own wildcard would do nothing.
 */
const SUFFIX_EXCEPTIONS: ReadonlySet<string> = withAsciiForms(PUBLIC_SUFFIX_EXCEPTIONS);

/**
 * The bundled snapshot, for the drift check.
 *
 * Exported so `scripts/check-public-suffix-drift.ts` compares against the data
 * this module actually uses, a drift check holding its own copy of what it is
 * checking would pass forever.
 */
export function bundledMultiLabelSuffixes(): ReadonlySet<string> {
  return MULTI_LABEL_SUFFIXES;
}

/** The wildcard-parent rules in the snapshot. See the header. */
export function bundledWildcardSuffixParents(): readonly string[] {
  return WILDCARD_SUFFIX_PARENTS;
}

/** True when `host` has no registrant: it is itself a public suffix, a single label or malformed. */
export function isPublicSuffix(host: string): boolean {
  return registrableDomain(host) === null;
}

/**
 * The registrable domain of `host`, the label immediately below its public
 * suffix, or `null` when the host has none (it IS a suffix, or is a single
 * label, or is malformed).
 *
 * `null` is a refusal, never a fallback to the whole host: a caller that
 * treated an unparseable host as its own registrable domain would compare
 * equal to itself and let a malformed host through.
 */
export function registrableDomain(host: string): string | null {
  const trimmed = host.trim().replace(/\.+$/, '');
  if (trimmed.length === 0) return null;
  // Compared in punycode, the form a URL's host has: `andøy.no` and `xn--andy-ira.no` are one host.
  const normalized = asciiHost(trimmed.normalize('NFKC'));
  if (normalized === null || normalized.length === 0) return null;
  const labels = normalized.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return null;

  // PSL order: an exception rule wins over every other rule. `!city.kobe.jp`
  // makes `city.kobe.jp` the registrable domain of itself and every host below it.
  for (let start = 0; start < labels.length; start += 1) {
    const candidate = labels.slice(start).join('.');
    if (SUFFIX_EXCEPTIONS.has(candidate)) return candidate;
  }

  // Otherwise the longest matching rule is the suffix, so `co.uk` beats `uk`.
  // A wildcard `*.p` makes every `<label>.p` a suffix: a host exactly one label
  // below `p` is itself a suffix (no registrant).
  for (let start = 0; start < labels.length; start += 1) {
    const candidate = labels.slice(start).join('.');
    const wildcard = start + 1 < labels.length && WILDCARD_PARENT_SET.has(labels.slice(start + 1).join('.'));
    if (wildcard || (start < labels.length - 1 && MULTI_LABEL_LOOKUP.has(candidate))) {
      if (start === 0) return null; // the host IS the suffix
      return labels.slice(start - 1).join('.');
    }
  }

  // Fallback: a single-label suffix. Correct for com, dev, app and every new
  // gTLD, and the reason an out-of-date snapshot degrades safely.
  return labels.slice(-2).join('.');
}

/** True when both hosts sit under the same registrable domain. */
export function sameRegistrableDomain(left: string, right: string): boolean {
  const a = registrableDomain(left);
  const b = registrableDomain(right);
  return a !== null && b !== null && a === b;
}
