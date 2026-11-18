// check-credential-literals.ts
//
// Gate: no tracked file in the repository may hold a literal in the shape of a
// real credential. The repository is public, and a secret scanner (GitHub's,
// gitleaks) reads shape, not intent: a fixture value someone made up to look
// real is reported, and revoked, exactly like a working one. A fixture that
// needs a credential-shaped value builds it at run time from named parts
// (packages/engine/platform/src/platform/utils/fixture-credentials.ts), so the
// file never holds the whole shape.
//
// Scans every file `git ls-files` names, the generated ones included, as it is
// in the working tree (or, with --staged, as it is in the index). Reports file,
// line, kind and a short fingerprint (the first 16 hex digits of the SHA-256 of
// the matched text); it never prints the matched text.
//
// Kinds:
//   telegram-bot-token   digits, a colon and 35 token characters
//   openai-api-key       sk-proj-/sk-svcacct-/sk-admin- keys and keys holding the T3BlbkFJ marker
//   api-key              sk-/key- followed by 20+ (sk-) or 16+ (key-) token characters
//   anthropic-api-key    sk-ant-...
//   google-api-key       AIza and 35 characters
//   github-token         ghp_/gho_/ghu_/ghs_/ghr_ and 36+, github_pat_ and 22+
//   gitlab-token         glpat- and 20+
//   slack-token          xoxa-/xoxb-/xoxp-/xoxr-/xoxs-/xoxe- tokens, Slack webhook URLs
//   discord-token        bot tokens (three dot-separated parts) and webhook URLs
//   stripe-key           sk_/rk_ live or test keys
//   aws-access-key       AKIA/ASIA/ABIA/ACCA key ids
//   jwt                  three base64url parts, the first two starting eyJ
//   private-key          a PEM private-key header followed by a key body
//   bearer-token         a high-entropy token after "Bearer"
//   url-password         scheme://user:password@host with a password that is not a placeholder
//   card-number          a 13-19 digit card number in a card issuer's range that passes Luhn
//   generic-secret       a key/secret/token/password name assigned a high-entropy quoted value
//
// An exemption is one exact finding: path, kind and fingerprint, with the
// reason it is not a credential. There is none today; add one only for a value
// that cannot be assembled at run time, and say why.
//
//   bun run credential-literals:check            # every tracked file
//   bun run credential-literals:check --staged   # the staged version of each staged file
//   bun packages/engine/scripts/check-credential-literals.ts <file>...   # these files only
//
// Test override: CREDENTIAL_LITERALS_ROOT replaces the repository root.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = process.env['CREDENTIAL_LITERALS_ROOT'] ?? resolve(import.meta.dir, '../../..');

export interface CredentialLiteralFinding {
  readonly path: string;
  readonly line: number;
  readonly kind: string;
  readonly fingerprint: string;
}

interface Exemption {
  readonly path: string;
  readonly kind: string;
  readonly fingerprint: string;
  readonly reason: string;
}

/** Exact findings that are not credentials, each with its reason. */
const EXEMPTIONS: readonly Exemption[] = [];

interface Detector {
  readonly kind: string;
  readonly pattern: RegExp;
  /** The part of the match that is the credential; the whole match when absent. */
  readonly group?: number;
  /** False when the matched value is a placeholder rather than a credential. */
  readonly accept?: (value: string, match: RegExpMatchArray) => boolean;
  /** A character that may not come right before the match (default: a token character). */
  readonly notAfter?: RegExp;
}

const TOKEN_CHARS = 'A-Za-z0-9_-';
/** Not followed by a token character, so a match is the whole token (the character before is checked in code: a leading lookbehind makes every position a match attempt). */
const END = `(?![${TOKEN_CHARS}])`;
const TOKEN_CHAR = new RegExp(`[${TOKEN_CHARS}]`);

/** Shannon entropy in bits per character. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Words and forms that mark a value as a stand-in a reader is meant to replace. */
const PLACEHOLDER = /example|placeholder|redacted|dummy|fake|fixture|synthetic|sample|changeme|replace|your[_-]?|x{4,}|\*{3,}|\.{3}|<[^>]*>|\$\{|\{\{|%s|^\$[A-Za-z_{(]/i;

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER.test(value)) return true;
  // Filler of one or two repeated characters.
  return new Set(value.replace(/[-_.:]/g, '').toLowerCase()).size <= 2;
}

/**
 * Built from words: every part between separators is a word of letters, a
 * camelCase name, or at most four characters (`e2e`, `v1`, `2024`). `key-rotation-policy-2024`,
 * `local-e2e-native-host-token`, `__GOODVIBES_LITERAL_V1__`. A random token
 * has long parts that mix letters and digits.
 */
function isWordy(value: string): boolean {
  const parts = value.split(/[-_.:/]+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => /^[A-Za-z]{1,16}$/.test(part) || /^[a-z]+(?:[A-Z][a-z]+)+$/.test(part) || /^[A-Za-z0-9]{1,4}$/.test(part));
}

/** Random-looking: digits among letters or mixed case, high entropy, not built from words, not a stand-in. */
function looksRandom(value: string, minEntropy: number): boolean {
  const mixed = (/[A-Za-z]/.test(value) && /\d/.test(value)) || (/[A-Z]/.test(value) && /[a-z]/.test(value));
  return mixed && entropy(value) >= minEntropy && !isWordy(value) && !isPlaceholder(value);
}

/** An identifier, a path or a URL, which a secret is not. */
function isNameLike(value: string): boolean {
  if (isWordy(value)) return true;
  // A path or URL: a secret has no path separators between word-like parts.
  if (/^(?:[a-z]+:\/\/|\.{0,2}\/)/.test(value) || /^[\w.-]+(?:\/[\w.-]+){2,}$/.test(value)) return true;
  return false;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Issuer ranges: Visa, Mastercard (51-55, 2221-2720), Amex, Discover, JCB, Diners, UnionPay, Maestro. */
const CARD_ISSUER = /^(?:4|5[1-5]|2(?:2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)|3[47]|6011|65|64[4-9]|35(?:2[89]|[3-8]\d)|3(?:0[0-5]|[689])|62|5018|5020|5038|6304|6759|676[1-3])/;

/**
 * Card numbers the networks and processors publish for testing, which no
 * account carries (fingerprints of the digits, so this file holds none):
 * Visa 4111…1111, 4012…1881, 4222…2222 (13), Stripe's Visa 4242…4242 and
 * Visa debit 4000…5556; Mastercard 5555…4444, 5105…5100, 5500…0004, Stripe's
 * 2223…3222 and 5200…8210; Amex 3782…0005, 3714…8431, 3787…1000; Discover
 * 6011…1117, 6011…9424; Diners 3056…5904, 3852…3237, Stripe's 3622…1667;
 * JCB 3530…0000, 3566…0505; Stripe's UnionPay 6200…0005.
 */
const PUBLISHED_TEST_CARDS = new Set([
  '9bbef19476623ca5', 'dd13cdf9af9dd3ba', '253da55d8a05e361', '477bba133c182267', '68594afe9c9cda52',
  '2f725bbd1f405a1e', '304945e91de3deff', 'dd1ed74bd626c6fa', '576c15a8072461c2', 'b40e9bc7a74d50ab',
  '3a134ef77d4e2e4c', '53a8fc816e63b7a5', '273476b83f26d858', '19ff47cc8024c133', 'd8086d483c15c711',
  '51a4ae4c6ae99914', 'f41e7ca4a3d71c4f', '20e6583871d36495', '1c9d38ed26cd808f', 'd79449f462cec9af',
  '7cbcc57fc39e4317',
]);

function cardDigits(raw: string): string {
  return raw.replace(/[ .-]/g, '');
}

function isCardNumber(raw: string): boolean {
  const digits = cardDigits(raw);
  if (digits.length < 13 || digits.length > 19) return false;
  if (!CARD_ISSUER.test(digits)) return false;
  // A bare run of one repeated digit, or of zeros after the issuer prefix, is filler.
  if (/^(\d)\1+$/.test(digits)) return false;
  if (!passesLuhn(digits)) return false;
  // Ungrouped runs: only the lengths cards are printed with.
  if (!/[ .-]/.test(raw) && ![15, 16].includes(digits.length)) return false;
  return !PUBLISHED_TEST_CARDS.has(fingerprint(digits));
}

const DETECTORS: readonly Detector[] = [
  { kind: 'telegram-bot-token', pattern: new RegExp(`\\d{5,16}:[${TOKEN_CHARS}]{35}${END}`, 'g') },
  { kind: 'anthropic-api-key', pattern: new RegExp(`sk-ant-[a-z]{2,8}\\d{0,3}-[${TOKEN_CHARS}]{20,}`, 'g') },
  { kind: 'openai-api-key', pattern: new RegExp(`sk-(?:proj|svcacct|admin)-[${TOKEN_CHARS}]{20,}|sk-[${TOKEN_CHARS}]*T3BlbkFJ[${TOKEN_CHARS}]*`, 'g') },
  {
    kind: 'api-key',
    pattern: new RegExp(`(?:sk-[${TOKEN_CHARS}]{20,}|key-[${TOKEN_CHARS}]{16,})`, 'g'),
    accept: (value) => !/^sk-(?:ant|proj|svcacct|admin)-/.test(value) && !/T3BlbkFJ/.test(value) && looksRandom(value.replace(/^(?:sk|key)-/, ''), 3),
  },
  { kind: 'google-api-key', pattern: new RegExp(`AIza[${TOKEN_CHARS}]{35}${END}`, 'g') },
  { kind: 'github-token', pattern: new RegExp(`(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`, 'g') },
  { kind: 'gitlab-token', pattern: new RegExp(`glpat-[${TOKEN_CHARS}]{20,}`, 'g') },
  { kind: 'slack-token', pattern: new RegExp(`xox[abposre]-[A-Za-z0-9-]{10,}`, 'g'), accept: (value) => !isPlaceholder(value.slice(5)) && !isWordy(value.slice(5)) },
  { kind: 'slack-token', pattern: /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/g, accept: (value) => !isPlaceholder(value.split('/').pop() ?? '') },
  { kind: 'discord-token', pattern: new RegExp(`[MNO][A-Za-z0-9_-]{23,27}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,40}${END}`, 'g') },
  { kind: 'discord-token', pattern: /discord(?:app)?\.com\/api\/webhooks\/\d{5,}\/[A-Za-z0-9_-]{40,}/g, accept: (value) => !isPlaceholder(value.split('/').pop() ?? '') },
  { kind: 'stripe-key', pattern: new RegExp(`(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{10,}`, 'g'), accept: (value) => !isPlaceholder(value.replace(/^\w+?_\w+?_/, '')) },
  // AWS's documentation key ids end in EXAMPLE (AKIAIOSFODNN7EXAMPLE); no issued key does.
  { kind: 'aws-access-key', pattern: /(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Z0-9])/g, notAfter: /[A-Z0-9]/, accept: (value) => !value.endsWith('EXAMPLE') },
  { kind: 'jwt', pattern: new RegExp(`eyJ[${TOKEN_CHARS}]{8,}\\.eyJ[${TOKEN_CHARS}]{8,}\\.[${TOKEN_CHARS}]{8,}`, 'g') },
  {
    kind: 'private-key',
    // The header, then (across real or escaped line breaks) a base64 body of 64+ characters.
    pattern: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:\s|\\[nr])*((?:[A-Za-z0-9+/=]{16,}(?:\s|\\[nr])*){4,})/g,
    group: 1,
  },
  {
    kind: 'bearer-token',
    pattern: /Bearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g,
    group: 1,
    accept: (value) => !/^eyJ/.test(value) && looksRandom(value, 3.5),
  },
  {
    kind: 'url-password',
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@'"`<>()]{1,64}:([^\s/@'"`<>()]{6,128})@[A-Za-z0-9.-]+/g,
    group: 1,
    accept: (value) => looksRandom(value, 3),
  },
  {
    kind: 'card-number',
    // Groups of four split by one kind of separator (space, hyphen or dot), or one run of 15-16 digits.
    pattern: /\d{4}(?:([ .-])\d{4}\1\d{4}\1\d{1,7}|([ .-])\d{4}\2\d{1,7}|\d{11,12})(?![\w-]|\.\d)/g,
    accept: (value) => isCardNumber(value),
    notAfter: /[\w.-]/,
  },
  {
    kind: 'generic-secret',
    pattern: /(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|credential|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]{0,20}["']?\s*(?::|=|=>|:=)\s*["'`]([A-Za-z0-9_+/=.~!@#$%^&*-]{12,200})["'`]/gi,
    group: 1,
    accept: (value) => !isNameLike(value) && looksRandom(value, 3.5),
    // The name may be the tail of a longer one (`nativeHostToken`).
    notAfter: /(?!)/,
  },
];

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** The credential-shaped literals in one file's text, at most one per line and kind. */
export function findCredentialLiterals(path: string, text: string): CredentialLiteralFinding[] {
  const found: CredentialLiteralFinding[] = [];
  const seen = new Set<string>();
  let lineStarts: number[] | undefined;
  const lineOf = (index: number): number => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    }
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  for (const detector of DETECTORS) {
    for (const match of text.matchAll(detector.pattern)) {
      const value = detector.group === undefined ? match[0] : (match[detector.group] ?? '');
      if (value.length === 0) continue;
      const before = match.index === undefined || match.index === 0 ? '' : text[match.index - 1]!;
      if (before !== '' && (detector.notAfter ?? TOKEN_CHAR).test(before)) continue;
      if (detector.accept && !detector.accept(value, match)) continue;
      const line = lineOf(match.index ?? 0);
      const key = `${line}:${detector.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const finding = { path, line, kind: detector.kind, fingerprint: fingerprint(detector.kind === 'card-number' ? cardDigits(value) : value) };
      if (EXEMPTIONS.some((e) => e.path === path && e.kind === finding.kind && e.fingerprint === finding.fingerprint)) continue;
      found.push(finding);
    }
  }
  return found.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|icns|bmp|tiff?|pdf|woff2?|ttf|otf|eot|wasm|zip|gz|tgz|br|zst|xz|bz2|7z|tar|mp[34]|m4a|wav|ogg|opus|flac|webm|mov|avi|bin|exe|dll|so|dylib|node|db|sqlite|onnx|gguf|pem\.enc)$/i;

function git(args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { maxBuffer: 256 * 1024 * 1024 });
}

function textOf(content: Buffer): string | undefined {
  // A NUL byte in the first 8 KiB marks a binary file, as git decides.
  if (content.subarray(0, 8192).includes(0)) return undefined;
  return content.toString('utf8');
}

export function scanTracked(options: { readonly staged?: boolean; readonly paths?: readonly string[] } = {}): { files: number; findings: CredentialLiteralFinding[] } {
  const listed = options.paths && options.paths.length > 0
    ? options.paths.map((path) => relative(REPO_ROOT, resolve(process.cwd(), path)))
    : git(options.staged ? ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'] : ['ls-files', '-z']).toString('utf8').split('\u0000').filter(Boolean);
  let files = 0;
  const findings: CredentialLiteralFinding[] = [];
  for (const path of listed) {
    if (BINARY_EXT.test(path)) continue;
    let content: Buffer;
    try {
      content = options.staged ? git(['show', `:${path}`]) : readFileSync(join(REPO_ROOT, path));
    } catch {
      continue; // deleted in the working tree, or a submodule
    }
    const text = textOf(content);
    if (text === undefined) continue;
    files++;
    findings.push(...findCredentialLiterals(path.split('\\').join('/'), text));
  }
  return { files, findings };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const staged = argv.includes('--staged');
  const paths = argv.filter((arg) => !arg.startsWith('--'));
  const { files, findings } = scanTracked({ staged, paths });
  if (findings.length > 0) {
    console.error(`credential-literals-check FAILED: ${findings.length} credential-shaped literal(s) in ${files} files.\n`);
    for (const f of findings) console.error(`- ${f.path}:${f.line}: ${f.kind} (fingerprint ${f.fingerprint})`);
    console.error('\nA fixture that needs a credential-shaped value builds it at run time from named parts');
    console.error('(platform/utils/fixture-credentials.ts); the file must never hold the whole shape.');
    process.exit(1);
  }
  console.log(`credential-literals-check PASSED: ${files} files.`);
}
