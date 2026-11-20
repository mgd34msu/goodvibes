/**
 * Slash-command argument readers. They speak the one flag grammar of
 * cli-arguments.ts (`--name value` or `--name=value`; a following `--flag` is
 * never taken as the value), so a flag spelt one way works in every command.
 * Callers own which flags they allow and what a value may change.
 */
import { readOptionValue, readOptionValues, readPositiveInt, readStringList } from './cli-arguments.js';

export { readOptionValue as readFlag, readPositiveInt as readPositiveIntFlag, readOptionValues as readRepeatedFlagValues };

export function readStringListFlag(args: readonly string[], name: string): string[] {
  return [...readStringList(args, name)];
}

export function readJsonObjectFlag(args: readonly string[], name: string): Record<string, unknown> | null | undefined {
  const value = readOptionValue(args, name);
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The words that are not flags or the value of a bare valued flag; `--name=value` is one flag token. */
export function positionalArgs(args: readonly string[], valuedFlags: readonly string[] = []): string[] {
  return args.filter((token, index) => {
    if (token.startsWith('--')) return false;
    if (index > 0 && valuedFlags.includes(args[index - 1]!)) return false;
    return true;
  });
}

