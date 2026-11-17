/**
 * The one way both terminal apps split a slash command into its words.
 *
 * - Words are separated by whitespace.
 * - A `"` or `'` at the start of a word opens a quote that the same character
 *   closes; inside it spaces are kept exactly, and a backslash keeps the next
 *   quote character or backslash.
 * - Outside a quote a backslash is an ordinary character, kept exactly as
 *   typed (`C:\dir`, `pa\ss\word`, `ab\\cd`): a typed value such as a
 *   secret reaches the command with the characters the person typed. Spaces
 *   in a word are written by quoting it.
 * - A quote character inside a word is ordinary (`it's`).
 * - A quote left open refuses the whole line: nothing is closed for the person.
 * - A command can take the rest of the line untouched from a given word on
 *   (`rawRest`), for free text such as a title.
 */
export interface ParsedSlashCommand {
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * The word from which a command takes the rest of the line as typed; given the
 * words read so far and, while there is one, the next word as typed (not yet
 * read), so a rule can read leading flags as words and stop before the text.
 */
export type SlashCommandRawRest = number | ((args: readonly string[], upcoming?: string) => number | undefined);

/** What a command declares about how its line is split. */
export interface SlashCommandGrammar {
  /** An empty quoted word is refused: the command's words are fields, and an empty one would shift the rest. */
  readonly strictArgs?: boolean | undefined;
  readonly rawRest?: SlashCommandRawRest | undefined;
}

export type SplitSlashCommand =
  | { readonly ok: true; readonly name: string; readonly args: string[] }
  | { readonly ok: false; readonly name: string; readonly reason: string };

interface WordScan {
  readonly words: string[];
  /** Offset of each word's first character in the line. */
  readonly starts: number[];
  /** Whether each word was written as a quoted empty string. */
  readonly emptyQuoted: boolean[];
  readonly unclosedQuote: boolean;
}

const QUOTES = new Set(['"', "'"]);

/**
 * Splits `line` into words. `stopAfter` is asked after each complete word with
 * the words so far and the next word as typed (undefined at the end of the
 * line); when it returns true the scan stops and `rest` is the offset where the
 * next word begins.
 */
function scanWords(line: string, stopAfter?: (words: readonly string[], upcoming?: string) => boolean): WordScan & { readonly rest?: number } {
  const words: string[] = [];
  const starts: number[] = [];
  const emptyQuoted: boolean[] = [];
  let index = 0;
  const length = line.length;
  while (index < length) {
    while (index < length && /\s/.test(line[index]!)) index++;
    if (index >= length) break;
    if (stopAfter) {
      let end = index;
      while (end < length && !/\s/.test(line[end]!)) end++;
      if (stopAfter(words, line.slice(index, end))) return { words, starts, emptyQuoted, unclosedQuote: false, rest: index };
    }
    const start = index;
    let word = '';
    let quoted = false;
    while (index < length && !/\s/.test(line[index]!)) {
      const char = line[index]!;
      if (QUOTES.has(char) && word.length === 0 && !quoted && index === start) {
        quoted = true;
        index++;
        let closed = false;
        while (index < length) {
          const inner = line[index]!;
          if (inner === '\\' && index + 1 < length && (line[index + 1] === char || line[index + 1] === '\\')) {
            word += line[index + 1];
            index += 2;
            continue;
          }
          if (inner === char) {
            closed = true;
            index++;
            break;
          }
          word += inner;
          index++;
        }
        if (!closed) return { words, starts, emptyQuoted, unclosedQuote: true };
        continue;
      }
      word += char;
      index++;
    }
    words.push(word);
    starts.push(start);
    emptyQuoted.push(quoted && word.length === 0);
  }
  if (stopAfter?.(words)) return { words, starts, emptyQuoted, unclosedQuote: false, rest: length };
  return { words, starts, emptyQuoted, unclosedQuote: false };
}

function rawRestIndex(rule: SlashCommandRawRest | undefined, args: readonly string[], upcoming?: string): number | undefined {
  if (rule === undefined) return undefined;
  return typeof rule === 'number' ? rule : rule(args, upcoming);
}

/**
 * A `rawRest` rule for `<subcommand> [flags…] <free text>`: for one of
 * `subcommands`, the flags typed right after it are read as words and the
 * rest of the line, from the first word that is not one of `flags`, is kept
 * as typed (spacing, line breaks and quotes included).
 */
export function rawRestAfterLeadingFlags(subcommands: readonly string[], flags: ReadonlySet<string>): SlashCommandRawRest {
  return (args, upcoming) => {
    if (!subcommands.includes((args[0] ?? '').toLowerCase())) return undefined;
    if (!args.slice(1).every((word) => flags.has(word))) return undefined;
    return upcoming !== undefined && flags.has(upcoming) ? undefined : args.length;
  };
}

/**
 * Split a typed command line (with or without its leading `/`) for dispatch.
 * Refuses, naming what to fix, when a quote is left open or (for a
 * `strictArgs` command) a quoted word is empty; nothing should run then.
 */
export function splitSlashCommand(
  line: string,
  grammarOf?: ((name: string) => SlashCommandGrammar | undefined) | undefined,
): SplitSlashCommand {
  const text = line.replace(/^\s*\//, '');
  const nameMatch = /^\s*(\S*)/.exec(text);
  const name = nameMatch?.[1] ?? '';
  const grammar = name ? grammarOf?.(name) : undefined;
  const rule = grammar?.rawRest;
  const scan = scanWords(text, rule === undefined ? undefined : (words, upcoming) => {
    if (words.length === 0) return false;
    return rawRestIndex(rule, words.slice(1), upcoming) === words.length - 1;
  });
  if (scan.unclosedQuote) {
    return { ok: false, name, reason: `Not run: /${name} has an unclosed quote, so its words could land in the wrong places. Close the quote, then run it again.` };
  }
  if (grammar?.strictArgs && scan.emptyQuoted.some((empty, index) => empty && index > 0)) {
    return { ok: false, name, reason: `Not run: /${name} has an empty quoted word, so the words after it would shift into the wrong fields. Fill the word or remove it, then run it again.` };
  }
  const args = scan.words.slice(1);
  if (scan.rest !== undefined && scan.rest < text.length) {
    const rest = text.slice(scan.rest).replace(/[\r\n]+$/, '');
    if (rest.length > 0) args.push(rest);
  }
  return { ok: true, name: scan.words[0] ?? name, args };
}

/**
 * Split a command line the program built itself (with {@link quoteSlashCommandArg})
 * or one only read for its name. Same rules as {@link splitSlashCommand}, but a
 * quote left open keeps the words read before it instead of refusing; typed
 * lines are dispatched through `splitSlashCommand`.
 */
export function parseSlashCommand(command: string): ParsedSlashCommand {
  const tokens = tokenizeSlashCommand(command.trim().replace(/^\//, ''));
  return {
    name: tokens[0] ?? '',
    args: tokens.slice(1),
  };
}

/** The words of a program-built line; see {@link parseSlashCommand}. */
export function tokenizeSlashCommand(command: string): readonly string[] {
  return scanWords(command).words;
}

/** Quote one value so {@link splitSlashCommand} reads it back exactly. */
export function quoteSlashCommandArg(value: string): string {
  if (/^[A-Za-z0-9._/:=@,+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
