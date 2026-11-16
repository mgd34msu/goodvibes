/**
 * One parse for a subcommand's declared flags. A command lists the flags that
 * take a value and the ones that do not; the parse and every refusal come from
 * that list, so a misspelt flag is refused instead of silently falling back to
 * a default. The grammar is the shared one (`--name value` or `--name=value`,
 * cli-arguments.ts).
 */
import { splitCommandOption } from '@goodvibes-jev/engine/terminal-shell/cli-arguments';

export interface DeclaredFlags {
  /** Flags that take a value, without the leading `--`. */
  readonly values: readonly string[];
  /** Flags that take no value, without the leading `--`. */
  readonly booleans?: readonly string[] | undefined;
}

export interface ParsedDeclaredFlags {
  readonly positional: readonly string[];
  /** Every value given for a value flag, in order. A boolean flag maps to an empty list. */
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

export type DeclaredFlagsResult =
  | ({ readonly ok: true } & ParsedDeclaredFlags)
  | { readonly ok: false; readonly problem: string };

/** The accepted flags, for a refusal: `--a <value>, --b`. */
export function describeDeclaredFlags(spec: DeclaredFlags): string {
  const names = [...spec.values.map((name) => `--${name} <value>`), ...(spec.booleans ?? []).map((name) => `--${name}`)];
  return names.length > 0 ? names.join(', ') : 'none';
}

export function parseDeclaredFlags(args: readonly string[], spec: DeclaredFlags): DeclaredFlagsResult {
  const valued = new Set(spec.values);
  const booleans = new Set(spec.booleans ?? []);
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const { name: dashed, value: inline } = splitCommandOption(token);
    const name = dashed.slice(2);
    if (booleans.has(name)) {
      if (inline !== undefined) return { ok: false, problem: `--${name} takes no value.` };
      flags.set(name, []);
      continue;
    }
    if (!valued.has(name)) {
      return { ok: false, problem: `Unknown option ${dashed}. Accepted: ${describeDeclaredFlags(spec)}.` };
    }
    let value = inline;
    if (value === undefined) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      }
    }
    if (value === undefined || value.trim().length === 0) {
      return { ok: false, problem: `--${name} needs a value, for example --${name} <value>.` };
    }
    flags.set(name, [...(flags.get(name) ?? []), value.trim()]);
  }
  return { ok: true, positional, flags };
}
