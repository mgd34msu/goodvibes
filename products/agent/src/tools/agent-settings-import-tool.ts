import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { randomUUID } from 'node:crypto';

/** The one capability that gives the Agent the terminal app's settings (the daemon's; the person's Setup row runs it too). */
export const COPY_FROM_TERMINAL_APP = 'settings.copy-from-terminal-app';

/**
 * The capability's inputs from a model's call: `security: "yes"` (also read from `includeSecurity: true`) copies the
 * settings that loosen a protection too; anything else leaves them as they are.
 */
export function copyFromTerminalAppInputs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return args.security === 'yes' || args.includeSecurity === true ? { security: 'yes' } : {};
}

/** Runs settings.copy-from-terminal-app as a nested capability_run of this call, so the same gate decides it. */
export function runCopyFromTerminalApp(registry: ToolRegistry, args: Readonly<Record<string, unknown>>, options: Parameters<Tool['execute']>[1]): ReturnType<Tool['execute']> {
  return registry.executeNested(randomUUID(), 'capability_run', { id: COPY_FROM_TERMINAL_APP, inputs: copyFromTerminalAppInputs(args) }, options);
}

export function createAgentSettingsImportTool(registry: ToolRegistry): Tool {
  return {
    definition: {
      name: 'import_goodvibes_settings',
      activity: { doing: 'Copying', did: 'copied', object: 'the terminal app\'s settings' },
      description: 'Give the Agent the settings the terminal app has: runs the capability settings.copy-from-terminal-app (the same as capability_run id:"settings.copy-from-terminal-app"). A setting that loosens a protection is copied only with security:"yes".',
      parameters: {
        type: 'object',
        properties: {
          security: { type: 'string', enum: ['no', 'yes'], description: 'yes: also copy the settings that loosen a protection; no (the default): leave them as they are.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      // It only routes to the capability (a nested capability_run judged by the capability's own risk): classed a read,
      // so the capability's question is the only one.
      category: 'read',
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown, options) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
      if (!assertCurrentToolInvocation(args, options)) return { success: false, error: 'Copying the terminal app\'s settings requires a current recorded invocation.' };
      return runCopyFromTerminalApp(registry, args, options);
    },
  };
}

export function registerAgentSettingsImportTool(registry: ToolRegistry): void {
  if (!registry.has('import_goodvibes_settings')) registry.register(createAgentSettingsImportTool(registry));
}
