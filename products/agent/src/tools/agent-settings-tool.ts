import { isHarnessSettingsQuery } from './agent-harness-settings-catalog.ts';
import { captureCatalogData } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-data';
import { createHarnessFacade, registerHarnessFacade, type HarnessFacadeDeps } from './agent-harness-facade.ts';
import { createPreferredSettingsProjector, executeAdmittedPreferredSettings, settingsThrownFailure } from './agent-settings-admission.ts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentSettingsImportTool } from './agent-settings-import-tool.ts';
import { executeAdmittedAgentSettingsImport } from './agent-settings-import-admission.ts';
import { readSettingsAction, SETTINGS_ACTION_WORDS } from './agent-settings-action.ts';
import { confirmParameter } from '@goodvibes-jev/engine/terminal-shell/agent-turn/effect-admission';
import { readString } from '@goodvibes-jev/engine/terminal-shell/agent-turn/tool-args';

interface AgentSettingsToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly key?: unknown;
  readonly setting?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly category?: unknown;
  readonly prefix?: unknown;
  readonly value?: unknown;
  readonly includeHidden?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
  readonly confirm?: unknown;
}

interface AgentSettingsToolDeps extends HarnessFacadeDeps {
  readonly settingsImportTool?: Tool;
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function settingKey(args: AgentSettingsToolArgs): string {
  return readString(args.key) || readString(args.setting);
}

function confirmedArgs(args: AgentSettingsToolArgs): Record<string, unknown> {
  return compactArgs({
    confirm: args.confirm,
  });
}

function settingsListArgs(args: AgentSettingsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'settings',
    category: args.category,
    prefix: args.prefix,
    query: args.query ?? args.target,
    includeHidden: args.includeHidden,
    includeParameters: args.includeParameters,
    limit: args.limit,
    offset: args.offset,
  });
}

function settingsLookupArgs(mode: 'get_setting' | 'set_setting' | 'reset_setting', args: AgentSettingsToolArgs): Record<string, unknown> {
  const key = settingKey(args);
  return compactArgs({
    mode,
    key,
    target: key ? undefined : args.target,
    query: key ? undefined : args.query,
    category: args.category,
    prefix: args.prefix,
    value: mode === 'set_setting' ? args.value : undefined,
    includeHidden: args.includeHidden,
    ...confirmedArgs(args),
  });
}

function isSettingsQuery(input: Record<string, unknown>, context: CommandContext): boolean {
  const args = captureCatalogData(input) as AgentSettingsToolArgs;
  const action = readSettingsAction(args as Record<string, unknown>);
  return action === 'list' ? isHarnessSettingsQuery(settingsListArgs(args), context.platform.configManager)
    : action === 'get' && isHarnessSettingsQuery(settingsLookupArgs('get_setting', args), context.platform.configManager);
}

export function createAgentSettingsTool(deps: AgentSettingsToolDeps): Tool {
  const settingsImportTool = deps.settingsImportTool ?? createAgentSettingsImportTool(deps.commandContext);

  return createHarnessFacade<AgentSettingsToolArgs>(deps, {
    definition: {
      name: 'settings',
      activity: {
        doing: 'Adjusting', did: 'adjusted', object: 'settings',
        byAction: { read: { doing: 'Checking', did: 'checked', object: 'settings' } },
      },
      description: 'List, inspect, change, reset, or import settings.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...SETTINGS_ACTION_WORDS],
            description: 'list/get read; set/reset change one setting and import applies the captured import, each through recorded admission; preview_import only shows what import would apply.',
          },
          key: { type: 'string', description: 'Exact setting key.' },
          setting: { type: 'string', description: 'Alias for key.' },
          target: { type: 'string', description: 'Setting lookup text.' },
          query: { type: 'string', description: 'Setting search text.' },
          category: { type: 'string', description: 'Top-level setting category.' },
          prefix: { type: 'string', description: 'Setting key prefix.' },
          value: { description: 'Value for action:set.' },
          includeHidden: { type: 'boolean', description: 'Include scriptable or hidden settings.' },
          includeParameters: { type: 'boolean', description: 'Include full setting metadata.' },
          limit: { type: 'number', description: 'Settings per page (default 50, at most 100).' },
          offset: { type: 'number', description: 'Row to start the page at; a short page names the next offset.' },
          confirm: confirmParameter(),
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    selected: input => isSettingsQuery(input, deps.commandContext),
    async route({ args, rawArgs, options, forward }) {
      const action = readSettingsAction(args as Record<string, unknown>);
      if (!action) return error(`Unknown settings action "${readString(args.action) || readString(args.mode)}". Use one of: ${SETTINGS_ACTION_WORDS.join(', ')}.`);

      if (action === 'list') return forward(settingsListArgs(args));
      if (action === 'get') return forward(settingsLookupArgs('get_setting', args));
      // Writes and the import carry their own admission (registered as this tool's fallback projection).
      if (action === 'set' || action === 'reset') {
        try { return await executeAdmittedPreferredSettings(rawArgs, options); }
        catch (thrown) { return settingsThrownFailure('mutation', thrown); }
      }
      if (action === 'preview_import') return settingsImportTool.execute({ action: 'preview' }, options);
      if (action === 'import') {
        try { return await executeAdmittedAgentSettingsImport(deps.commandContext, rawArgs, options); }
        catch (thrown) { return settingsThrownFailure('import', thrown); }
      }

      return error(`Unknown settings action. Use one of: ${SETTINGS_ACTION_WORDS.join(', ')}.`);
    },
  });
}

export function registerAgentSettingsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('settings')) registerHarnessFacade(registry, createAgentSettingsTool({ commandRegistry, commandContext, toolRegistry: registry }), commandContext,
    input => isSettingsQuery(input, commandContext),
    createPreferredSettingsProjector(commandContext.platform, undefined, { registry, context: commandContext }));
}
