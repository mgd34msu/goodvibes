import { catalogRoutingInput } from './agent-harness-catalog-ingress.ts';
import { createHarnessFacade, registerHarnessFacade, type HarnessFacadeDeps } from './agent-harness-facade.ts';
import { createAgentHarnessResearchProjector, protectAgentHarnessResearchTool, isResearchReportEditor } from './agent-research-ingress.ts';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { captureModelReadingInput } from './agent-harness-model-reading-source.ts';
import { confirmParameter, requestParameter } from '@goodvibes/engine/terminal-shell/agent-turn/effect-admission';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';

/** The tool's name: what it does is the person's own screen in this program, its keys and its typed commands. */
export const SCREENS_KEYS_COMMANDS_TOOL = 'screens_keys_commands';

/**
 * This program's own screen, for a model: the places it can open in front of the person, its keys (read and press),
 * the commands typed into it and its command-line commands. None of these is a capability: they act on this
 * conversation's screen. Binding a key is the capability keys.bind (keys.reset puts it back); every other action is a
 * capability too (capability_find, capability_run).
 */
const ACTION_WORDS = ['surfaces', 'surface', 'open', 'shortcuts', 'keybindings', 'keybinding', 'run_keybinding', 'commands', 'command', 'run_command', 'cli_commands', 'cli_command'] as const;

type ScreensKeysCommandsAction = typeof ACTION_WORDS[number];

interface ScreensKeysCommandsArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly actionId?: unknown;
  readonly surfaceId?: unknown;
  readonly command?: unknown;
  readonly commandName?: unknown;
  readonly args?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly category?: unknown;
  readonly categoryId?: unknown;
  readonly fields?: unknown;
  readonly key?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function normalizeAction(value: unknown): ScreensKeysCommandsAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'surfaces' || action === 'ui_surfaces' || action === 'screens' || action === 'views' || action === 'places') return 'surfaces';
  if (action === 'surface' || action === 'ui_surface' || action === 'screen' || action === 'view' || action === 'place') return 'surface';
  if (action === 'open' || action === 'navigate' || action === 'open_surface' || action === 'open_ui_surface') return 'open';
  if (action === 'shortcuts' || action === 'shortcut_help' || action === 'help') return 'shortcuts';
  if (action === 'keybindings' || action === 'bindings' || action === 'keys') return 'keybindings';
  if (action === 'keybinding' || action === 'binding' || action === 'key') return 'keybinding';
  if (action === 'run_keybinding' || action === 'trigger_keybinding' || action === 'trigger_shortcut' || action === 'press') return 'run_keybinding';
  if (action === 'commands' || action === 'slash_commands' || action === 'command_catalog') return 'commands';
  if (action === 'command' || action === 'slash_command' || action === 'inspect_command') return 'command';
  if (action === 'run_command' || action === 'execute_command' || action === 'execute') return 'run_command';
  if (action === 'cli_commands' || action === 'cli_catalog') return 'cli_commands';
  if (action === 'cli_command' || action === 'inspect_cli_command') return 'cli_command';
  return null;
}

/**
 * The action, inferred from the fields only when none was named. A word that was
 * sent but is not an action gives null: inferring one (a misspelled `run` read
 * as an inspection) would report something other than what was asked.
 */
function readAction(args: ScreensKeysCommandsArgs): ScreensKeysCommandsAction | null {
  if (readString(args.action) || readString(args.mode)) return normalizeAction(args.action) ?? normalizeAction(args.mode);
  if (readString(args.surfaceId)) return 'surface';
  if (readString(args.command) || readString(args.commandName)) return 'command';
  if (readString(args.key) || readString(args.actionId)) return 'keybinding';
  return 'surfaces';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function lookupId(args: ScreensKeysCommandsArgs): string {
  return readString(args.actionId) || readString(args.id);
}

function surfaceLookup(args: ScreensKeysCommandsArgs): string {
  return readString(args.surfaceId) || readString(args.id);
}

function confirmedArgs(args: ScreensKeysCommandsArgs): Record<string, unknown> {
  return compactArgs({
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

function surfaceArgs(mode: 'ui_surface' | 'open_ui_surface', args: ScreensKeysCommandsArgs): Record<string, unknown> {
  const surfaceId = surfaceLookup(args);
  return compactArgs({
    mode,
    surfaceId,
    category: args.category,
    categoryId: args.categoryId,
    target: surfaceId ? args.target : (args.target ?? args.query),
    query: surfaceId ? undefined : args.query,
    includeParameters: mode === 'ui_surface' ? args.includeParameters : undefined,
    ...(mode === 'open_ui_surface' ? confirmedArgs(args) : {}),
  });
}

function keybindingArgs(mode: 'keybinding' | 'run_keybinding', args: ScreensKeysCommandsArgs): Record<string, unknown> {
  const actionId = lookupId(args);
  return compactArgs({
    mode,
    actionId,
    target: actionId ? undefined : args.target,
    query: actionId ? undefined : args.query,
    key: args.key,
    fields: args.fields,
    includeParameters: mode === 'keybinding' ? args.includeParameters : undefined,
    ...(mode === 'run_keybinding' ? confirmedArgs(args) : {}),
  });
}

function commandArgs(mode: 'command' | 'run_command' | 'cli_command', args: ScreensKeysCommandsArgs): Record<string, unknown> {
  return compactArgs({
    mode,
    command: args.command,
    commandName: args.commandName,
    args: args.args,
    target: args.command || args.commandName ? undefined : args.target,
    query: args.command || args.commandName ? undefined : args.query,
    includeParameters: mode === 'run_command' ? undefined : args.includeParameters,
    ...(mode === 'run_command' ? confirmedArgs(args) : {}),
  });
}

function isReportEdit(args: Record<string, unknown>): boolean {
  return isResearchReportEditor({ fields: args.fields });
}

const CATALOG_READS: readonly ScreensKeysCommandsAction[] = ['shortcuts', 'keybindings', 'keybinding', 'run_keybinding', 'cli_commands', 'cli_command'];

function isCatalogQuery(input: Record<string, unknown>): boolean {
  const routing = catalogRoutingInput(input);
  const action = readAction(routing);
  if (!action) return false;
  if (CATALOG_READS.includes(action)) captureModelReadingInput(input);
  return [...CATALOG_READS, 'commands', 'command', 'run_command'].includes(action)
    && [routing.query, routing.target].some((value) => typeof value === 'string' && value.trim().length > 0);
}

export function createScreensKeysCommandsTool(deps: HarnessFacadeDeps): Tool {
  return createHarnessFacade<ScreensKeysCommandsArgs>(deps, {
    definition: {
      name: SCREENS_KEYS_COMMANDS_TOOL,
      activity: { doing: 'Driving', did: 'drove', object: 'the screen, keys and commands' },
      description: 'This program\'s own screen in front of the person: list and open its places (screens), read and press its keys, read and run the commands typed into it, read its command-line commands. Binding a key is capability_run id:"keys.bind" (keys.reset puts it back); any other action: capability_find, then capability_run.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...ACTION_WORDS],
            description: 'Read the places, keys and commands, or act on the screen: open, run_keybinding and run_command need a current recorded effect admission; confirm and explicitUserRequest do not grant it.',
          },
          id: { type: 'string', description: 'A place (surface) id, or a key\'s action id.' },
          actionId: { type: 'string', description: 'A key\'s action id.' },
          surfaceId: { type: 'string', description: 'A place (surface) id.' },
          command: { type: 'string', description: 'A typed or command-line command.' },
          commandName: { type: 'string', description: 'A typed or command-line command\'s name.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Command arguments when commandName is used.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          category: { type: 'string', description: 'For open with surfaceId "places": the place to open.' },
          categoryId: { type: 'string', description: 'For open with surfaceId "places": the place to open (its id).' },
          fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Fields a pressed key\'s action reads.' },
          key: { type: 'string', description: 'A key to look up.' },
          includeParameters: { type: 'boolean', description: 'Include detailed schemas or route metadata.' },
          limit: { type: 'number', description: 'Maximum rows returned.' },
          offset: { type: 'number', description: 'Row to start a page at.' },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    selected: isCatalogQuery,
    protect: (tool) => protectAgentHarnessResearchTool(tool, deps.toolRegistry, isReportEdit),
    route({ args, forward: dispatch }) {
      const action = readAction(args);
      if (!action) return error(`Unknown ${SCREENS_KEYS_COMMANDS_TOOL} action "${readString(args.action) || readString(args.mode)}". Use one of: ${ACTION_WORDS.join(', ')}.`);

      if (action === 'surfaces') return dispatch(compactArgs({ mode: 'ui_surfaces', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      if (action === 'surface') return dispatch(surfaceArgs('ui_surface', args));
      if (action === 'open') return dispatch(surfaceArgs('open_ui_surface', args));
      if (action === 'shortcuts') return dispatch(compactArgs({ mode: 'shortcuts', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      if (action === 'keybindings') return dispatch(compactArgs({ mode: 'keybindings', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      if (action === 'keybinding') return dispatch(keybindingArgs('keybinding', args));
      if (action === 'run_keybinding') return dispatch(keybindingArgs('run_keybinding', args));
      if (action === 'commands') return dispatch(compactArgs({ mode: 'commands', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      if (action === 'command') return dispatch(commandArgs('command', args));
      if (action === 'run_command') return dispatch(commandArgs('run_command', args));
      if (action === 'cli_commands') return dispatch(compactArgs({ mode: 'cli_commands', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      return dispatch(commandArgs('cli_command', args));
    },
  });
}

export function registerScreensKeysCommandsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has(SCREENS_KEYS_COMMANDS_TOOL)) registerHarnessFacade(registry, createScreensKeysCommandsTool({ commandRegistry, commandContext, toolRegistry: registry }), commandContext,
    isCatalogQuery, createAgentHarnessResearchProjector(registry, isReportEdit));
}
