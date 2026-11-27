import type { CommandRegistry, SlashCommand } from '../input/command-registry.ts';
import { parseSlashCommand } from '../input/slash-command-parser.ts';
import { describeCommandPolicy } from './agent-harness-metadata.ts';
import { rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { clampReadLimit } from '@goodvibes/engine/terminal-shell/agent-turn/read-helpers';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';
import { describeCommandForModel } from '@goodvibes/engine/terminal-shell/command-actions';

export interface AgentHarnessCommandCatalogArgs {
  readonly query?: unknown;
  readonly command?: unknown;
  readonly commandName?: unknown;
  readonly args?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

export interface CommandDetailLookup {
  readonly source: 'command' | 'commandName' | 'target' | 'query';
  readonly input: string;
  readonly parsedName: string;
  readonly parsedArgs: readonly string[];
  readonly resolvedBy: 'name' | 'alias' | 'case-insensitive-name' | 'case-insensitive-alias' | 'description';
}

export type CommandDetailResolution =
  | { readonly status: 'found'; readonly command: SlashCommand; readonly lookup: CommandDetailLookup }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] };

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => typeof entry === 'string' ? entry : String(entry));
}

function previewText(value: string, maxLength = 56): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function commandSearchText(command: CatalogCommand): string {
  return [
    command.name,
    ...(command.aliases ?? []),
    command.description,
    command.usage ?? '',
    command.argsHint ?? '',
  ].join('\n');
}

type CatalogCommand = Omit<SlashCommand, 'handler'>;

/** The registry's commands as data: the handler is left out, it is never evidence. */
function catalogCommand(command: SlashCommand): CatalogCommand {
  const { handler: _handler, ...data } = command;
  return data;
}

/**
 * One read of the registry per call. A description built from that read is
 * consistent by construction; a command registered while the call runs shows
 * up in the next call.
 */
function readCommandCatalog(commandRegistry: CommandRegistry, options: CatalogRankingOptions) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const commands = commandRegistry.list();
  return { commands, catalog: commands.map(catalogCommand) };
}

async function matchingCommands(commandRegistry: CommandRegistry, query: string, options: CatalogRankingOptions) {
  const { catalog } = readCommandCatalog(commandRegistry, options);
  if (!query) return { matches: catalog.slice().sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ entry, judgment: undefined })) };
  return rankHarnessCatalog(catalog, query, (entry) => ({ id: entry.name, description: commandSearchText(entry) }), 'agent.harness.commands', options);
}

function describeCommand(command: CatalogCommand, lookup?: CommandDetailLookup): Record<string, unknown> {
  const policy = describeCommandPolicy(command.name, command);
  const modelRoute = policy.preferredModelTool ?? `screens_keys_commands action:"command" commandName:"${command.name}"`;
  return {
    name: command.name,
    slash: `/${command.name}`,
    aliases: command.aliases ?? [],
    description: command.description,
    usage: command.usage ?? '',
    argsHint: command.argsHint ?? command.usage ?? '',
    modelRoute,
    modelAccess: {
      inspect: `agent_harness mode:"command" commandName:"${command.name}"`,
      run: `agent_harness mode:"run_command" commandName:"${command.name}"`,
      preferred: modelRoute,
      directInspect: `screens_keys_commands action:"command" commandName:"${command.name}"`,
      directRun: `screens_keys_commands action:"run_command" commandName:"${command.name}"`,
    },
    ...(lookup ? {
      lookup: {
        source: lookup.source,
        input: lookup.input,
        parsedName: lookup.parsedName,
        parsedArgs: lookup.parsedArgs,
        resolvedBy: lookup.resolvedBy,
      },
    } : {}),
    policy,
    // A described command gives each action: its label, what it does in one sentence, the exact line, what it touches, and why only the owner may run it.
    ...(command.described ? { actions: describeCommandForModel(command.described).actions } : {}),
  };
}

function describeCommandCandidate(command: CatalogCommand): Record<string, unknown> {
  const policy = describeCommandPolicy(command.name, command);
  return {
    name: command.name,
    slash: `/${command.name}`,
    aliases: command.aliases ?? [],
    summary: previewText(command.description),
    effect: policy.effect,
    modelRoute: policy.preferredModelTool ?? `screens_keys_commands action:"command" commandName:"${command.name}"`,
    ...(command.argsHint ? { argsHint: command.argsHint } : {}),
  };
}

function commandDetailLookupFromArgs(args: AgentHarnessCommandCatalogArgs): Omit<CommandDetailLookup, 'resolvedBy'> | null {
  const rawCommand = readString(args.command);
  if (rawCommand) {
    const parsed = parseSlashCommand(rawCommand);
    // A bare name plus an `args` array is the old `commandName` shape; keep it working.
    const explicitArgs = readStringArray(args.args);
    return { source: 'command', input: rawCommand, parsedName: parsed.name, parsedArgs: parsed.args.length === 0 && explicitArgs.length > 0 ? explicitArgs : parsed.args };
  }
  const rawCommandName = readString(args.commandName);
  if (rawCommandName) {
    const parsed = parseSlashCommand(rawCommandName);
    const explicitArgs = readStringArray(args.args);
    return {
      source: 'commandName',
      input: rawCommandName,
      parsedName: parsed.name,
      parsedArgs: explicitArgs.length > 0 ? explicitArgs : parsed.args,
    };
  }
  const rawTarget = readString(args.target);
  if (rawTarget) {
    const parsed = parseSlashCommand(rawTarget);
    return { source: 'target', input: rawTarget, parsedName: parsed.name, parsedArgs: parsed.args };
  }
  const rawQuery = readString(args.query);
  if (rawQuery) {
    const parsed = parseSlashCommand(rawQuery);
    return { source: 'query', input: rawQuery, parsedName: parsed.name, parsedArgs: parsed.args };
  }
  return null;
}

export async function resolveHarnessCommandDetail(commandRegistry: CommandRegistry, args: AgentHarnessCommandCatalogArgs, options: CatalogRankingOptions = {}): Promise<CommandDetailResolution | null> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const lookup = commandDetailLookupFromArgs(args);
  if (!lookup?.parsedName) return null;
  const direct = commandRegistry.get(lookup.parsedName);
  if (direct) {
    return {
      status: 'found',
      command: direct,
      lookup: {
        ...lookup,
        resolvedBy: direct.name === lookup.parsedName ? 'name' : 'alias',
      },
    };
  }

  const normalized = lookup.parsedName.toLowerCase();
  for (const command of readCommandCatalog(commandRegistry, options).commands) {
    if (command.name.toLowerCase() === normalized) {
      return { status: 'found', command, lookup: { ...lookup, resolvedBy: 'case-insensitive-name' } };
    }
    if ((command.aliases ?? []).some((alias) => alias.toLowerCase() === normalized)) {
      return { status: 'found', command, lookup: { ...lookup, resolvedBy: 'case-insensitive-alias' } };
    }
  }

  // Explicit command names and parsed invocations never become guessed effects.
  if (lookup.source === 'commandName' || lookup.source === 'command') return null;
  const found = await matchingCommands(commandRegistry, lookup.input, options);
  options.signal?.throwIfAborted();
  if (found.matches.length === 1 && found.matches[0]!.judgment?.reading.verdict === 'yes' && found.matches[0]!.judgment?.reading.outcome === 'act') {
    const selected = commandRegistry.get(found.matches[0]!.entry.name);
    if (selected) return { status: 'found', command: selected, lookup: { ...lookup, resolvedBy: 'description' } };
  }
  if (found.matches.length > 0) return { status: 'ambiguous', input: lookup.input,
    candidates: found.matches.slice(0, 8).map(({ entry, judgment }) => ({ ...describeCommandCandidate(entry), judgment })),
  };
  return null;
}

export async function searchHarnessCommands(
  commandRegistry: CommandRegistry,
  args: AgentHarnessCommandCatalogArgs,
  options: CatalogRankingOptions = {},
): Promise<{ readonly matches: readonly Record<string, unknown>[] }> {
  const query = readString(args.query);
  const limit = readLimit(args.limit, 500);
  const includeParameters = args.includeParameters === true;
  const found = await matchingCommands(commandRegistry, query, options);
  options.signal?.throwIfAborted();
  return {
    matches: found.matches
      .slice(0, limit)
      .map(({ entry, judgment }) => ({ ...(includeParameters ? describeCommand(entry) : describeCommandCandidate(entry)), ...(judgment ? { judgment } : {}) })),
  };
}

export async function describeHarnessCommand(commandRegistry: CommandRegistry, args: AgentHarnessCommandCatalogArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown> | null> {
  const detail = await resolveHarnessCommandDetail(commandRegistry, args, options);
  options.signal?.throwIfAborted();
  if (detail?.status === 'found') return describeCommand(detail.command, detail.lookup);
  if (detail?.status === 'ambiguous') return { status: 'ambiguous', input: detail.input, candidates: detail.candidates };
  return null;
}
