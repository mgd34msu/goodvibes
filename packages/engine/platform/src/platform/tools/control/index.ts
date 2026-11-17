import type { Tool } from '../../types/tools.js';
import { CONTROL_TOOL_SCHEMA, type ControlToolInput } from './schema.js';
import { listBuiltinSubscriptionProviders } from '../../config/subscription-providers.js';
import { listSandboxPresets } from '../../runtime/sandbox/manager.js';

/** One command or panel as the product names it. */
export interface ControlSurfaceEntry {
  readonly name: string;
  readonly description?: string | undefined;
}

type ControlSurfaceList = readonly ControlSurfaceEntry[] | (() => readonly ControlSurfaceEntry[]);

export interface ControlToolOptions {
  /**
   * The product's own commands, read from its command registry. A function is
   * read on every call, for a registry that exists only after the tool is
   * registered. Absent: this composition has no command surface.
   */
  readonly commands?: ControlSurfaceList | undefined;
  /** The product's own panels, read from its view registry. Absent: this product has no panels. */
  readonly panels?: ControlSurfaceList | undefined;
}

/**
 * A control tool listing the product's own commands and panels. The engine
 * keeps no command or panel names: the product supplies them, so the answer is
 * the product's whole list, and a composition without a surface says so.
 */
export function createControlTool(options: ControlToolOptions = {}): Tool {
  const list = (kind: 'commands' | 'panels', source: ControlSurfaceList | undefined) => {
    if (source === undefined) {
      return {
        success: true,
        output: JSON.stringify({
          available: false,
          reason: kind === 'commands'
            ? 'This session has no slash-command surface (it is not running in a terminal app), so there are no commands to list.'
            : 'This product has no panels.',
        }),
      };
    }
    const entries = typeof source === 'function' ? source() : source;
    return { success: true, output: JSON.stringify({ available: true, count: entries.length, [kind]: entries }) };
  };
  return {
    definition: {
      ...CONTROL_TOOL_SCHEMA,
      // Every mode reads; none changes state.
      sideEffects: [],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as ControlToolInput;

      if (input.mode === 'commands') return list('commands', options.commands);
      if (input.mode === 'panels') return list('panels', options.panels);
      if (input.mode === 'subscriptions') {
        const providers = listBuiltinSubscriptionProviders();
        return {
          success: true,
          output: JSON.stringify({
            count: providers.length,
            providers: providers.map((entry) => ({
              provider: entry.provider,
              label: entry.displayName,
              overrideAmbientApiKeys: entry.oauth.overrideAmbientApiKeys,
            })),
          }),
        };
      }
      if (input.mode === 'sandbox-presets') {
        const presets = listSandboxPresets();
        return {
          success: true,
          output: JSON.stringify({
            count: presets.length,
            presets: presets.map((preset) => ({
              id: preset.id,
              label: preset.label,
              summary: preset.summary,
              mcpIsolation: preset.config.mcpIsolation,
            })),
          }),
        };
      }

      return { success: false, error: `Unknown mode: ${input.mode}. Use one of: commands, panels, subscriptions, sandbox-presets.` };
    },
  };
}
