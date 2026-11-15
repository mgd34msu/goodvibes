/**
 * What the public-suffix generator and its drift check agree on: where the list
 * comes from, how its ICANN section is read, and which private-section
 * suffixes are kept by hand. One definition, so a hand-kept suffix added for
 * the generator is not reported as stale by the check.
 */

export const UPSTREAM_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const ICANN_BEGIN = '// ===BEGIN ICANN DOMAINS===';
const ICANN_END = '// ===END ICANN DOMAINS===';

/**
 * Fewer multi-label ICANN suffixes than this means the upstream list was
 * truncated or reformatted (it carries several thousand).
 */
export const MIN_MULTI_LABEL_SUFFIXES = 1000;

/**
 * Private-section entries kept by hand.
 *
 * The private section is thousands of entries that churn constantly, so
 * bundling all of it would make the drift check permanently red. These are the
 * hosting suffixes where getting it wrong makes two unrelated sites compare
 * equal, the failure that actually matters for link validation.
 */
export const CURATED_PRIVATE_SUFFIXES: readonly string[] = [
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'r2.dev', 'web.app', 'firebaseapp.com',
  's3.amazonaws.com', 'blogspot.com', 'wordpress.com', 'sharepoint.com', 'myshopify.com',
];

export interface ParsedPublicSuffixList {
  /** Plain rules with at least one dot. */
  readonly multiLabel: ReadonlySet<string>;
  /** The parent of each `*.parent` rule. */
  readonly wildcardParents: ReadonlySet<string>;
  /** Each `!exception` rule without its marker. */
  readonly exceptions: ReadonlySet<string>;
}

/** The ICANN section's lines, or a throw when the markers are missing or out of order. */
export function icannSection(text: string): string[] {
  const start = text.indexOf(ICANN_BEGIN);
  const end = text.indexOf(ICANN_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'public-suffix: could not find the ICANN section markers in the upstream list. '
      + 'The upstream format may have changed; inspect it before trusting the result.',
    );
  }
  return text.slice(start, end).split('\n');
}

/** Reads the ICANN section of the upstream list into its three rule kinds. */
export function parsePublicSuffixList(text: string): ParsedPublicSuffixList {
  const multiLabel = new Set<string>();
  const wildcardParents = new Set<string>();
  const exceptions = new Set<string>();
  for (const raw of icannSection(text)) {
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
