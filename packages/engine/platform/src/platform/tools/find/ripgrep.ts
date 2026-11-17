import { relative } from 'node:path';

/**
 * ripgrep as the first pass of a content search, where the host has it.
 *
 * The search's own file list stays the authority on which files are searched
 * (rg is handed those files by name, so its ignore rules and walk never
 * apply), and the JavaScript matcher stays the authority on which lines match:
 * rg only says which files may hold a match, and only those are read and
 * matched as before. So a result never depends on which engine ran.
 *
 * That holds because the pattern rg is given is a translation that matches
 * every line the JavaScript pattern matches (it may match more; the second
 * pass drops those). Patterns the translation cannot carry that way
 * (lookarounds, backreferences, astral or replacement characters,
 * case-insensitive non-ASCII, a pattern that matches an empty line) are not
 * handed to rg; the search then reads every file, as without rg.
 *
 * Cost: one rg process per batch of about 96 KiB of file names (a few for a
 * large project, four at a time), each reading its files natively and in
 * parallel; the search then reads only the files rg named.
 */

/** File-name bytes per rg process; well under the kernel's argument limit. */
const RG_BATCH_ARG_BYTES = 96 * 1024;
/** rg processes run at once (each also searches its files on several threads; four smaller batches finish sooner than one large one). */
const RG_CONCURRENCY = 4;

let detected: string | null | undefined;

/** The rg on PATH, looked up once per process; null when there is none. */
export function hostRipgrep(): string | null {
  if (detected === undefined) {
    try { detected = Bun.which('rg') ?? null; } catch { detected = null; }
  }
  return detected;
}

/** Any one to three bytes of a non-ASCII sequence: one JavaScript code unit of an astral character, or a U+FFFD the decoder put in place of invalid bytes. */
const NON_ASCII_UNIT = '(?-u:[\\x80-\\xFF]{1,3})';
/** JavaScript's `\s` without the line feed (a line never holds one). */
const JS_SPACE = '\\t\\x0B\\x0C\\r\\x20\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}';
const JS_DIGIT = '0-9';
const JS_WORD = '0-9A-Za-z_';

function hex(code: number): string {
  return `\\x{${code.toString(16).toUpperCase()}}`;
}

function isAsciiAlnum(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** A code unit rg cannot be given as one character with the same meaning. */
function unsupportedUnit(code: number, caseInsensitive: boolean): boolean {
  return (code >= 0xd800 && code <= 0xdfff) || code === 0xfffd || code === 0x0a || (caseInsensitive && code > 0x7f);
}

/** One literal code unit as rg pattern text, or null. */
function literal(code: number, caseInsensitive: boolean): string | null {
  if (unsupportedUnit(code, caseInsensitive)) return null;
  return isAsciiAlnum(code) ? String.fromCharCode(code) : hex(code);
}

class Unsupported extends Error {}

function fail(): never {
  throw new Unsupported();
}

/**
 * A pattern for rg that matches every line `source` (a JavaScript pattern
 * without the `u`, `v`, `m`, `s` or `y` flags, as content search compiles it)
 * matches, or null when the translation cannot promise that.
 */
export function ripgrepSupersetPattern(source: string, caseInsensitive: boolean): string | null {
  let at = 0;
  const peek = (offset = 0): string | undefined => source[at + offset];

  /** A `\` escape outside a class, as one rg atom; `at` is past the backslash. */
  const escapeAtom = (): { text: string; quantifiable: boolean } => {
    const ch = source[at++] ?? fail();
    switch (ch) {
      case 'd': return { text: `[${JS_DIGIT}]`, quantifiable: true };
      case 'w': return { text: `[${JS_WORD}]`, quantifiable: true };
      case 's': return { text: `[${JS_SPACE}]`, quantifiable: true };
      case 'D': return { text: `(?:[^${JS_DIGIT}\\n]|${NON_ASCII_UNIT})`, quantifiable: true };
      case 'W': return { text: `(?:[^${JS_WORD}\\n]|${NON_ASCII_UNIT})`, quantifiable: true };
      case 'S': return { text: `(?:[^${JS_SPACE}\\n]|${NON_ASCII_UNIT})`, quantifiable: true };
      case 'b': return { text: '(?-u:\\b)', quantifiable: false };
      case 'B': return { text: '(?-u:\\B)', quantifiable: false };
      default: return { text: escapedUnit(ch), quantifiable: true };
    }
  };

  /** The code unit a character escape (not a class escape) stands for, as rg text. */
  const escapedUnit = (ch: string): string => {
    const code = escapedCode(ch);
    return literal(code, caseInsensitive) ?? fail();
  };

  const escapedCode = (ch: string): number => {
    switch (ch) {
      case 't': return 0x09;
      case 'r': return 0x0d;
      case 'f': return 0x0c;
      case 'v': return 0x0b;
      case '0': if (/[0-9]/.test(peek() ?? '')) fail(); return 0;
      case 'x': {
        const digits = source.slice(at, at + 2);
        if (!/^[0-9A-Fa-f]{2}$/.test(digits)) fail();
        at += 2;
        return parseInt(digits, 16);
      }
      case 'u': {
        const digits = source.slice(at, at + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(digits)) fail();
        at += 4;
        return parseInt(digits, 16);
      }
      default: {
        const code = ch.charCodeAt(0);
        // Only escaped ASCII punctuation is a plain literal; escaped letters and digits have meanings rg does not share.
        if (code > 0x7f || isAsciiAlnum(code)) fail();
        return code;
      }
    }
  };

  /** A class `[...]`; `at` is past the `[`. */
  const classAtom = (): string => {
    let negated = false;
    if (peek() === '^') { negated = true; at++; }
    if (peek() === ']') {
      at++;
      // `[]` matches nothing; `[^]` matches any code unit.
      if (!negated) fail();
      return `(?:[^\\n]|${NON_ASCII_UNIT})`;
    }
    const items: string[] = [];
    /** Negated class escapes met (`\D`, `\W`, `\S`), and the positive ones. */
    const negatedEscapes = new Set<string>();
    const positiveEscapes = new Set<string>();
    /** The next class member: a code unit, or a class escape's items. */
    const member = (): { code: number } | { items: string } => {
      const ch = source[at++] ?? fail();
      if (ch !== '\\') {
        const code = ch.charCodeAt(0);
        if (unsupportedUnit(code, caseInsensitive)) fail();
        return { code };
      }
      const next = source[at++] ?? fail();
      if (next === 'd') { positiveEscapes.add('d'); return { items: JS_DIGIT }; }
      if (next === 'w') { positiveEscapes.add('w'); return { items: JS_WORD }; }
      if (next === 's') { positiveEscapes.add('s'); return { items: JS_SPACE }; }
      if (next === 'D' || next === 'W' || next === 'S') { negatedEscapes.add(next.toLowerCase()); return { items: '' }; }
      if (next === 'b') return { code: 0x08 };
      if (next === 'B' || next === 'c' || next === 'n') fail();
      const code = escapedCode(next);
      if (unsupportedUnit(code, caseInsensitive)) fail();
      return { code };
    };
    while (peek() !== ']') {
      if (peek() === undefined) fail();
      const first = member();
      if (peek() === '-' && peek(1) !== ']' && peek(1) !== undefined) {
        at++;
        const last = member();
        // A range with a class escape at either end is a literal hyphen in JavaScript: not carried.
        if (!('code' in first) || !('code' in last)) fail();
        const lo = (first as { code: number }).code;
        const hi = (last as { code: number }).code;
        if (lo > hi || (lo <= 0xfffd && hi >= 0xfffd) || (lo <= 0xdfff && hi >= 0xd800)) fail();
        // A line never holds a line feed: a range across it is carried as the parts either side.
        if (lo < 0x0a) items.push(`${hex(lo)}-${hex(Math.min(hi, 0x09))}`);
        if (hi > 0x0a) items.push(`${hex(Math.max(lo, 0x0b))}-${hex(hi)}`);
        continue;
      }
      items.push('code' in first ? hex(first.code) : first.items);
    }
    at++;
    if (negatedEscapes.size > 0) {
      // `[\s\S]` and the like match any code unit; a negated escape with anything else is not carried.
      if (negated || [...negatedEscapes].some((name) => !positiveEscapes.has(name))) fail();
      return `(?:[^\\n]|${NON_ASCII_UNIT})`;
    }
    if (items.every((item) => item === '')) fail();
    return negated ? `(?:[^${items.join('')}\\n]|${NON_ASCII_UNIT})` : `[${items.join('')}]`;
  };

  /** A quantifier after an atom, as rg text (greedy: laziness does not change whether a line matches). */
  const quantifier = (): string => {
    const ch = peek();
    let text = '';
    if (ch === '*' || ch === '+' || ch === '?') { at++; text = ch; }
    else if (ch === '{') {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
      // A brace that is not a quantifier is a literal in JavaScript: not carried.
      if (!match) fail();
      at += match![0].length;
      text = match![0];
    } else return '';
    if (peek() === '?') at++;
    return text;
  };

  const sequence = (depth: number): string => {
    let out = '';
    while (at < source.length) {
      const ch = source[at]!;
      if (ch === ')') {
        if (depth === 0) fail();
        return out;
      }
      if (ch === '|') { at++; out += '|'; continue; }
      let atom: string;
      let quantifiable = true;
      at++;
      if (ch === '\\') {
        const escaped = escapeAtom();
        atom = escaped.text;
        quantifiable = escaped.quantifiable;
      } else if (ch === '[') {
        atom = classAtom();
      } else if (ch === '(') {
        if (peek() === '?') {
          if (peek(1) === ':') at += 2;
          else if (peek(1) === '<' && peek(2) !== '=' && peek(2) !== '!') {
            const end = source.indexOf('>', at);
            if (end < 0) fail();
            at = end + 1;
          } else fail();
        }
        const inner = sequence(depth + 1);
        if (source[at] !== ')') fail();
        at++;
        atom = `(?:${inner})`;
      } else if (ch === '.') {
        atom = `(?:[^\\n\\r\\x{2028}\\x{2029}]|${NON_ASCII_UNIT})`;
      } else if (ch === '^') {
        // The decoder drops a byte-order mark that rg (reading raw bytes) still sees at the start of line 1.
        atom = '(?:^\\x{FEFF}?)';
        quantifiable = false;
      } else if (ch === '$') {
        // The search reads a CRLF line ending as LF; rg (without --crlf, so a pattern may still match a lone CR) keeps the CR.
        atom = '(?:\\r?$)';
        quantifiable = false;
      } else if (ch === '*' || ch === '+' || ch === '?' || ch === '{' || ch === '}' || ch === ']') {
        fail();
      } else {
        atom = literal(ch.charCodeAt(0), caseInsensitive) ?? fail();
      }
      const repeat = quantifier();
      if (repeat && !quantifiable) fail();
      out += repeat ? (atom.length === 1 || atom.startsWith('(?:') || atom.startsWith('[') ? atom : `(?:${atom})`) + repeat : atom;
    }
    if (depth > 0) fail();
    return out;
  };

  try {
    const translated = sequence(0);
    return caseInsensitive ? `(?i)${translated}` : translated;
  } catch (error) {
    if (error instanceof Unsupported) return null;
    throw error;
  }
}

/**
 * The files among `files` (absolute, all under `cwd`) in which rg finds
 * `pattern`, plus any rg could not read (so the second pass reports them as
 * it would). Null when rg could not answer (it refused the pattern, it was
 * missing, it was stopped): the caller searches every file.
 */
export async function ripgrepCandidates(
  rg: string,
  cwd: string,
  files: readonly string[],
  pattern: string,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  const byArgument = new Map<string, string>();
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const argument = relative(cwd, file);
    if (argument === '' || argument.startsWith('..')) return null;
    byArgument.set(argument, file);
    if (bytes + argument.length + 1 > RG_BATCH_ARG_BYTES && batch.length > 0) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(argument);
    bytes += Buffer.byteLength(argument) + 1;
  }
  if (batch.length > 0) batches.push(batch);
  const found = new Set<string>();
  let failed = false;

  const runBatch = async (names: readonly string[]): Promise<void> => {
    if (failed) return;
    signal?.throwIfAborted();
    const child = Bun.spawn([
      rg, '--no-config', '--files-with-matches', '--null', '--text', '--no-ignore', '--hidden',
      '--encoding', 'none', '--regexp', pattern, '--', ...names,
    ], { cwd, env: {}, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', ...(signal ? { signal } : {}) });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    signal?.throwIfAborted();
    if (code !== 0 && code !== 1 && code !== 2) { failed = true; return; }
    for (const name of out.split('\0')) {
      if (!name) continue;
      const file = byArgument.get(name);
      if (file === undefined) { failed = true; return; }
      found.add(file);
    }
    if (code !== 2) return;
    // Exit 2 with per-file errors: those files go to the second pass, which reports them. Any other error: rg did not answer.
    for (const line of err.split('\n')) {
      if (!line) continue;
      const file = unreadableFile(line, byArgument);
      if (file === undefined) { failed = true; return; }
      found.add(file);
    }
  };

  const queue = [...batches];
  await Promise.all(Array.from({ length: Math.min(RG_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await runBatch(next);
  }));
  return failed ? null : found;
}

/** The file named by an rg per-file error line (`rg: <name>: <reason>`), or undefined. */
function unreadableFile(line: string, byArgument: ReadonlyMap<string, string>): string | undefined {
  if (!line.startsWith('rg: ')) return undefined;
  const rest = line.slice(4);
  for (let end = rest.lastIndexOf(': '); end > 0; end = rest.lastIndexOf(': ', end - 1)) {
    const file = byArgument.get(rest.slice(0, end));
    if (file !== undefined) return file;
  }
  return undefined;
}
