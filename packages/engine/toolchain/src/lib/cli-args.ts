/**
 * Argument parsing shared by the toolchain bins. A bin that meets a flag it does
 * not know, or a flag that needs a value and has none, stops with a usage line
 * and exit 2: guessing or falling back to a default would act on a different
 * target than the one the caller meant, and still report success.
 */
import { consoleLogger } from './effects.js';

/** A command line the bin cannot act on. Bins print `message` and the usage line, then exit 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/**
 * How each flag is read: `value` takes the next argument, `switch` takes none,
 * `rest` takes every argument after it (at least one).
 */
export type FlagSpec = Readonly<Record<string, 'value' | 'switch' | 'rest'>>;

export interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly rest: ReadonlyMap<string, readonly string[]>;
  readonly positional: readonly string[];
}

/** Parse `argv` against `spec`; throws {@link UsageError} for anything the spec does not allow. */
export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const rest = new Map<string, readonly string[]>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const kind = Object.hasOwn(spec, arg) ? spec[arg] : undefined;
    if (kind === undefined) throw new UsageError(`unknown option ${arg}`);
    if (values.has(arg) || switches.has(arg) || rest.has(arg)) throw new UsageError(`${arg} given more than once`);
    if (kind === 'switch') { switches.add(arg); continue; }
    if (kind === 'rest') {
      const taken = argv.slice(index + 1);
      if (taken.length === 0) throw new UsageError(`${arg} needs at least one value`);
      rest.set(arg, taken);
      break;
    }
    values.set(arg, flagValue(argv.slice(index), arg)!);
    index++;
  }
  return { values, switches, rest, positional };
}

/** The value after `flag`, or undefined when the flag is absent. Throws when the flag has no value. */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
  return value;
}

/**
 * Run `body` with the bin's own usage line: a {@link UsageError} prints
 * `<bin>: <message>` and the usage line, then exits 2.
 */
export function withUsage<T>(bin: string, usage: string, body: () => T): T {
  try { return body(); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    consoleLogger.error(`${bin}: ${error.message}`);
    consoleLogger.error(`Usage: ${usage}`);
    process.exit(2);
  }
}
