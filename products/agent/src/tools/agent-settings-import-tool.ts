import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import {
  previewAgentWorkspaceTuiSettingsImport,
} from '../input/agent-workspace-settings.ts';
import { settingsThrownFailure } from './agent-settings-admission.ts';
import { createAgentSettingsImportProjector, executeAdmittedAgentSettingsImport, isAgentSettingsImportMutation } from './agent-settings-import-admission.ts';

interface AgentSettingsImportArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

function output(value: unknown): { readonly success: true; readonly output: string } {
  return {
    success: true,
    output: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  };
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

export function createAgentSettingsImportTool(commandContext: CommandContext): Tool {
  return {
    definition: {
      name: 'import_goodvibes_settings',
      description: 'Preview or apply shared GoodVibes settings import.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['preview', 'import', 'apply'],
            description: 'preview inspects sources; apply/import uses current recorded settings admission.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          confirm: { type: 'boolean', description: 'Optional legacy context; never grants authority.' },
          explicitUserRequest: { type: 'string', description: 'Optional request context; never grants authority.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown, options) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentSettingsImportArgs;
      if (isAgentSettingsImportMutation('import_goodvibes_settings', args as Record<string, unknown>)) {
        try { return await executeAdmittedAgentSettingsImport(commandContext, args as Record<string, unknown>, options); }
        catch (thrown) { return settingsThrownFailure('import', thrown); }
      }
      // Every word that applies the import is a mutation above; anything else previews.
      const preview = previewAgentWorkspaceTuiSettingsImport(commandContext);
      if (!preview) return error('GoodVibes settings import is unavailable in this runtime.');
      return output({
        status: 'preview',
        action: 'import_goodvibes_settings',
        preview,
        next: 'Use action:"import" to apply the captured import through recorded settings admission.',
      });
    },
  };
}

export function registerAgentSettingsImportTool(registry: ToolRegistry, commandContext: CommandContext): void {
  if (!registry.has('import_goodvibes_settings')) registry.register(createAgentSettingsImportTool(commandContext), {
    inputProjection: createAgentSettingsImportProjector(commandContext, undefined, registry),
  });
}
