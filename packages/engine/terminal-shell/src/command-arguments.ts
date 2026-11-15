/**
 * Slash-command argument readers. They speak the one flag grammar of
 * cli-arguments.ts (`--name value` or `--name=value`; a following `--flag` is
 * never taken as the value), so a flag spelt one way works in every command.
 * Callers own which flags they allow and what a value may change.
 */
import { shellSplit } from '@goodvibes-jev/engine/platform/platform/utils';
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

export function readKnowledgeTaskArguments(args: readonly string[]) {
  return { scopeValues: readOptionValues(args, '--scope'), query: positionalArgs(args, ['--scope']).join(' ').trim() };
}
export function readKnowledgeAskArguments(args: readonly string[], allowKnowledgeSpace: boolean) {
  const query = positionalArgs(args, allowKnowledgeSpace ? ['--space', '--knowledge-space', '--limit', '--mode'] : ['--limit', '--mode'])
    .join(' ')
    .trim();
  const requested = readOptionValue(args, '--mode');
  const mode = requested === 'concise' || requested === 'standard' || requested === 'detailed' ? requested : 'standard';
  return {
    query,
    limit: readPositiveInt(args, '--limit', 10),
    mode,
    includeSources: true,
    includeConfidence: true,
    includeLinkedObjects: true,
    ...(allowKnowledgeSpace ? { knowledgeSpaceId: readOptionValue(args, '--space') ?? readOptionValue(args, '--knowledge-space') } : {}),
  } as const;
}

/**
 * The arguments of a typed line (without its leading `/`) for a command that
 * declares `strictArgs`: split with strict shell quoting, refused (undefined)
 * on an unclosed quote, a trailing lone backslash or an empty quoted word.
 */
export function strictCommandArguments(command: string): string[] | undefined {
  try {
    const words = shellSplit(command, { strict: true });
    return words.includes('') ? undefined : words.slice(1);
  } catch {
    return undefined;
  }
}

/** The refusal printed when a `strictArgs` command's line does not split. */
export function strictArgumentsRefusal(name: string): string {
  return `Not run: /${name} has an unclosed quote, a trailing backslash or an empty quoted word, so its words could land in the wrong fields. Close the quote or fill the empty word, then run it again.`;
}
