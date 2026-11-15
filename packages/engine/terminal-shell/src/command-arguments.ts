/** Shared command argument syntax; callers own allowed flags and mutation authority. */
import { shellSplit } from '@goodvibes-jev/engine/platform/platform/utils';
export function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function readStringListFlag(args: string[], name: string): string[] {
  const value = readFlag(args, name);
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function readPositiveIntFlag(args: string[], name: string, fallback: number): number {
  const raw = readFlag(args, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readJsonObjectFlag(args: string[], name: string): Record<string, unknown> | null | undefined {
  const value = readFlag(args, name);
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

export function positionalArgs(args: string[], valuedFlags: readonly string[] = []): string[] {
  return args.filter((token, index) => {
    if (token.startsWith('--')) return false;
    if (index > 0 && valuedFlags.includes(args[index - 1]!)) return false;
    return true;
  });
}

export function readRepeatedFlagValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index + 1];
    if (args[index] === name && value) {
      values.push(value);
      index++;
    }
  }
  return values;
}
export function readKnowledgeTaskArguments(args: string[]) {
  return { scopeValues: readRepeatedFlagValues(args, '--scope'), query: positionalArgs(args, ['--scope']).join(' ').trim() };
}
export function readKnowledgeAskArguments(args: string[], allowKnowledgeSpace: boolean) {
  const query = positionalArgs(args, allowKnowledgeSpace ? ['--space', '--knowledge-space', '--limit', '--mode'] : ['--limit', '--mode'])
    .join(' ')
    .trim();
  const requested = readFlag(args, '--mode');
  const mode = requested === 'concise' || requested === 'standard' || requested === 'detailed' ? requested : 'standard';
  return {
    query,
    limit: readPositiveIntFlag(args, '--limit', 10),
    mode,
    includeSources: true,
    includeConfidence: true,
    includeLinkedObjects: true,
    ...(allowKnowledgeSpace ? { knowledgeSpaceId: readFlag(args, '--space') ?? readFlag(args, '--knowledge-space') } : {}),
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
