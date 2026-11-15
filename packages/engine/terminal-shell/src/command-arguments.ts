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

/** `/schedule` arguments. Quoting is command grammar, never schedule meaning: incomplete input is refused. */
export function scheduleCommandArguments(command: string): string[] | undefined {
  let quote: '"' | "'" | undefined;
  let tokenStart: number | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (!quote && /\s/.test(ch!)) {
      // shellSplit intentionally drops empty words. A positional command must
      // reject that input before a prompt can shift into the schedule slot.
      if (tokenStart !== undefined && shellSplit(command.slice(tokenStart, i)).length === 0) return undefined;
      tokenStart = undefined;
      continue;
    }
    tokenStart ??= i;
    if (ch === '\\' && quote !== "'") {
      if (i + 1 === command.length) return undefined;
      if (!quote || command[i + 1] === '"' || command[i + 1] === '\\') i++;
    } else if (ch === quote) quote = undefined;
    else if (!quote && (ch === '"' || ch === "'")) quote = ch;
  }
  if (quote || (tokenStart !== undefined && shellSplit(command.slice(tokenStart)).length === 0)) return undefined;
  return shellSplit(command).slice(1);
}
