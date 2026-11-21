/**
 * What the public-suffix generator and its drift check agree on: where the list
 * comes from and how its two sections, ICANN and PRIVATE, are read. One
 * definition, so the check reads upstream exactly as the generator did.
 */

export const UPSTREAM_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const ICANN_BEGIN = '// ===BEGIN ICANN DOMAINS===';
const ICANN_END = '// ===END ICANN DOMAINS===';
const PRIVATE_BEGIN = '// ===BEGIN PRIVATE DOMAINS===';
const PRIVATE_END = '// ===END PRIVATE DOMAINS===';

/**
 * Fewer multi-label ICANN suffixes than this means the upstream list was
 * truncated or reformatted (it carries several thousand).
 */
export const MIN_MULTI_LABEL_SUFFIXES = 1000;

/**
 * Fewer private-section rules than this means the upstream list was truncated
 * or reformatted (it carries several thousand).
 */
export const MIN_PRIVATE_RULES = 1000;

export interface PublicSuffixRules {
  /** Plain rules with at least one dot. */
  readonly multiLabel: ReadonlySet<string>;
  /** The parent of each `*.parent` rule. */
  readonly wildcardParents: ReadonlySet<string>;
  /** Each `!exception` rule without its marker. */
  readonly exceptions: ReadonlySet<string>;
}

export interface ParsedPublicSuffixList {
  /** The ICANN section: suffixes delegated by registries. */
  readonly icann: PublicSuffixRules;
  /**
   * The PRIVATE section: hosts under which a company gives each customer its own
   * name (`<tenant>.weebly.com`), so two tenants are different registrants.
   */
  readonly private: PublicSuffixRules;
}

/** One section's lines, or a throw when its markers are missing or out of order. */
function section(text: string, begin: string, end: string, name: string): string[] {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start === -1 || stop === -1 || stop <= start) {
    throw new Error(
      `public-suffix: could not find the ${name} section markers in the upstream list. `
      + 'The upstream format may have changed; inspect it before trusting the result.',
    );
  }
  return text.slice(start, stop).split('\n');
}

function parseRules(lines: readonly string[]): PublicSuffixRules {
  const multiLabel = new Set<string>();
  const wildcardParents = new Set<string>();
  const exceptions = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('//')) continue;
    if (line.startsWith('!')) {
      exceptions.add(line.slice(1).toLowerCase());
    } else if (line.startsWith('*.')) {
      wildcardParents.add(line.slice(2).toLowerCase());
    } else if (line.includes('.')) {
      multiLabel.add(line.toLowerCase());
    }
  }
  return { multiLabel, wildcardParents, exceptions };
}

/** Reads both sections of the upstream list into their three rule kinds. */
export function parsePublicSuffixList(text: string): ParsedPublicSuffixList {
  return {
    icann: parseRules(section(text, ICANN_BEGIN, ICANN_END, 'ICANN')),
    private: parseRules(section(text, PRIVATE_BEGIN, PRIVATE_END, 'PRIVATE')),
  };
}

/** The number of rules of every kind in one section. */
export function ruleCount(rules: PublicSuffixRules): number {
  return rules.multiLabel.size + rules.wildcardParents.size + rules.exceptions.size;
}
