import type { CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools';
import { formatRefusal, readRefusal, refusal, RefusalError, type Refusal } from '@goodvibes/engine/errors';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { CommandContext } from '../input/command-registry.ts';
import { nativeSettingsCommandMutation } from '../input/commands/operator-runtime.ts';
import { resolveHarnessCommandDetail, type CommandDetailLookup } from './agent-harness-command-catalog.ts';
import type { AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { error, output } from './agent-harness-tool-utils.ts';
import { forwardHarnessCatalogCall, harnessCatalogExecutionGuard, harnessCatalogInvocationAuthority, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { describeCommandPolicy } from './agent-harness-metadata.ts';
import { commandVerbPolicy, ownerOnlyVerbRefusal } from '../input/commands/command-verbs.ts';

function invocationArgsFromLookup(lookup: CommandDetailLookup): readonly string[] {
  return lookup.resolvedBy === 'description' ? [] : lookup.parsedArgs;
}

function safeCommandDisplay(name: string): string {
  return `/${name}`;
}

/** Only trusted workspace routing calls this with its concrete command. */
export function runTranslatedWorkspaceCommand(deps: AgentHarnessToolDeps, original: Record<string, unknown>, command: string, options?: Parameters<Tool['execute']>[1]) {
  const adapter: Tool = { definition: { name: 'workspace-command-route', description: 'Trusted concrete workspace command route.', parameters: {} },
    execute(args, exactOptions) { return runCommand(deps, args, {
      signal: exactOptions?.signal, assertCurrent: harnessCatalogExecutionGuard(args, exactOptions), retainCurrent: retainHarnessCatalogCurrent(args),
    }, exactOptions); } };
  return forwardHarnessCatalogCall(adapter, original, { ...original, command }, options);
}

export async function runCommand(deps: AgentHarnessToolDeps, args: Record<string, unknown>, options: CatalogRankingOptions = {}, executionOptions?: Parameters<Tool['execute']>[1]): Promise<{ readonly success: boolean; readonly output?: string; readonly error?: string }> {
  const registry = deps.commandRegistry;
  const execute = registry.execute, context = deps.commandContext;
  const tools = deps.toolRegistry;
  const executeNested = tools.executeNested;
  const resolved = await resolveHarnessCommandDetail(deps.commandRegistry, args, options);
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (resolved?.status === 'ambiguous') {
    return error(`Ambiguous slash command ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  }
  if (!resolved) return error('run_command requires a valid command, commandName, target, or query. Use mode:"commands" to inspect available commands.');

  // Registry ranking is low-stakes discovery, never an effect grant. Even a
  // sole yes requires the caller to name the selected command in a new call.
  if (resolved.lookup.resolvedBy === 'description') return output({
    status: 'selection_required', reason: 'exact_command_identity_required',
    candidates: [{ commandName: resolved.command.name, inspectRoute: `workspace action:"command" commandName:"${resolved.command.name}"` }],
  });

  const assertCommandEffect = (name: string, commandArgs: readonly string[]) => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    // The command's definition says which admission a run needs: its per-verb
    // declaration (command-verbs.ts), else its `effect` and `readVerbs`.
    const command = registry.get(name);
    // No such command: nothing to admit, and the caller reports it as unknown.
    if (!command) return;
    const verb = commandVerbPolicy(command, commandArgs);
    const policy = describeCommandPolicy(name, command);
    if (!verb && policy.effect === 'undeclared') throw new RefusalError(refusal({
      code: 'COMMAND_EFFECT_UNDECLARED', state: 'not run; nothing was changed',
      reason: `/${name} does not declare what it does, so the model cannot be admitted to run it`,
      next: [`Ask the owner to type /${name}`, `Declare \`effect\` on the /${name} command definition`], status: 403,
    }));
    const firstVerb = (commandArgs[0] ?? '').trim().toLowerCase();
    const read = verb ? verb.effect === 'read'
      : policy.effect === 'read-only' || (policy.readVerbs?.includes(firstVerb) ?? false);
    const effect = verb ? (verb.effect === 'local-write' ? 'write' : 'send')
      : ['local-state', 'ui-navigation', 'session-lifecycle'].includes(policy.effect) ? 'write' : 'send';
    if (!read && !harnessCatalogInvocationAuthority(args, executionOptions, effect)) throw new ToolInputProjectionError('held');
    if (deps.commandRegistry !== registry || registry.execute !== execute || deps.commandContext !== context) throw new ToolInputProjectionError('held');
  };

  const printed: string[] = [];
  const toolContext: CommandContext = {
    ...deps.commandContext,
    judgmentReadingOptions: { signal: options.signal, assertCurrent: () => {
      options.signal?.throwIfAborted(); options.assertCurrent?.();
      if (deps.commandRegistry !== registry || registry.execute !== execute || deps.commandContext !== context) throw new ToolInputProjectionError('stale');
    } },
    // This is the model running a command, not the owner typing one. Said out
    // loud because a command that grants authority must be able to tell the
    // difference, and everything reaching this function is a model tool call,
    // including one a model made after reading a page that suggested it.
    invokedByModel: true,
    print: (text: string) => {
      printed.push(text);
    },
    renderRequest: () => {},
    executeCommand: async (name: string, commandArgs: string[]) => {
      assertCommandEffect(name, commandArgs);
      const handled = await executeModelCommand(name, commandArgs);
      options.signal?.throwIfAborted(); options.assertCurrent?.();
      return handled;
    },
  };
  const executeModelCommand = async (name: string, commandArgs: readonly string[]): Promise<boolean> => {
    const command = registry.get(name);
    // An owner-only verb is refused before any admission is asked for it.
    const verb = commandVerbPolicy(command, commandArgs);
    if (command && verb?.ownerOnly) throw ownerOnlyVerbRefusal(command.name, verb);
    assertCommandEffect(name, commandArgs);
    if (!command) return false;
    const mutation = nativeSettingsCommandMutation(command, commandArgs);
    assertCommandEffect(name, commandArgs);
    if (!mutation) return execute.call(registry, name, [...commandArgs], toolContext);
    const assertSettingsCurrent = () => {
      assertCommandEffect(name, commandArgs);
      const current = nativeSettingsCommandMutation(command, commandArgs);
      if (deps.toolRegistry !== tools || registry.get(name) !== command || !current
        || current.action !== mutation.action || current.key !== mutation.key
        || mutation.action === 'set' && (current.action !== 'set' || current.value !== mutation.value)) throw new ToolInputProjectionError('stale');
    };
    assertSettingsCurrent();
    const result = await executeNested.call(tools, 'agent-harness-command-settings', 'settings', mutation,
      executionOptions, { signal: options.signal, assertCurrent: assertSettingsCurrent });
    assertSettingsCurrent();
    if (!result.success) throw new ToolInputProjectionError('held');
    printed.push(result.output ?? '(no text output)');
    return true;
  };
  const commandArgs = invocationArgsFromLookup(resolved.lookup);
  // The command's own result decides: a command that refuses throws its refusal
  // (state, reason and next step); one that returns did what it says. Its
  // printed wording is never read for that.
  let handled: boolean;
  let refused: Refusal | undefined;
  try {
    const ownerOnly = commandVerbPolicy(resolved.command, commandArgs);
    if (ownerOnly?.ownerOnly) throw ownerOnlyVerbRefusal(resolved.command.name, ownerOnly);
    assertCommandEffect(resolved.command.name, commandArgs);
    if (deps.commandRegistry.get(resolved.command.name) !== resolved.command) throw new ToolInputProjectionError('stale');
    handled = await executeModelCommand(resolved.command.name, commandArgs);
  } catch (thrown) {
    refused = readRefusal(thrown);
    if (!refused) throw thrown;
    handled = true;
  }
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!handled) return error(`Unknown slash command /${resolved.command.name}.`);
  const printedText = printed.length > 0 ? printed.join('\n') : '(no text output)';
  const body = [
    `Command ${safeCommandDisplay(resolved.command.name)} ${refused ? 'was refused and did not apply' : 'ran and printed'}:`,
    `Resolved by ${resolved.lookup.source} ${resolved.lookup.resolvedBy}.`,
    ...(refused ? [formatRefusal(refused), ...(printed.length > 0 ? ['It printed:', printedText] : [])] : [printedText]),
  ].join('\n');
  return refused ? error(body) : output(body);
}
