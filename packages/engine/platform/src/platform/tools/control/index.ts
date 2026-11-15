import type { Tool } from '../../types/tools.js';
import { CONTROL_TOOL_SCHEMA, type ControlToolInput } from './schema.js';
import { listBuiltinSubscriptionProviders } from '../../config/subscription-providers.js';
import { listSandboxPresets } from '../../runtime/sandbox/manager.js';

/** Every command the engine's control tool can name; a product keeps the ones it registers. */
export const PACKAGED_COMMANDS = [
  'setup',
  'security',
  'marketplace',
  'bridge',
  'remote',
  'teleport',
  'subscription',
  'sandbox',
  'knowledge',
  'teamwork',
  'install',
  'update',
  'login',
  'logout',
] as const;

const CONTROL_PANELS = [
  'cockpit',
  'security',
  'remote',
  'knowledge',
  'marketplace',
  'sandbox',
  'subscription',
  'orchestration',
  'incident',
  'hooks',
  'mcp',
] as const;

export interface ControlToolOptions {
  /** The commands this product really has. Defaults to the full engine list for a direct createControlTool() call; registerAllTools defaults to none. */
  readonly commands?: readonly string[] | (() => readonly string[]) | undefined;
  /** The panels this product really has. A function is read on every call, for a list that exists only after the tool is registered. */
  readonly panels?: readonly string[] | (() => readonly string[]) | undefined;
}

/** A control tool listing the product's own commands and panels, so the model is never told about ones it lacks. */
export function createControlTool(options: ControlToolOptions = {}): Tool {
  const read = (source: ControlToolOptions['commands'], fallback: readonly string[]): readonly string[] =>
    typeof source === 'function' ? source() : (source ?? fallback);
  return {
    definition: {
      name: 'control',
      description: 'Inspect packaged product-control surfaces such as commands, panels, subscriptions, and sandbox presets.',
      parameters: CONTROL_TOOL_SCHEMA.parameters,
      // Every mode reads; none changes state.
      sideEffects: [],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as ControlToolInput;

      if (input.mode === 'commands') {
        const commands = read(options.commands, PACKAGED_COMMANDS);
        return { success: true, output: JSON.stringify({ count: commands.length, commands }) };
      }
      if (input.mode === 'panels') {
        const panels = read(options.panels, CONTROL_PANELS);
        return { success: true, output: JSON.stringify({ count: panels.length, panels }) };
      }
      if (input.mode === 'subscriptions') {
        return {
          success: true,
          output: JSON.stringify({
            count: listBuiltinSubscriptionProviders().length,
            providers: listBuiltinSubscriptionProviders().map((entry) => ({
              provider: entry.provider,
              label: entry.displayName,
              overrideAmbientApiKeys: entry.oauth.overrideAmbientApiKeys,
            })),
          }),
        };
      }
      if (input.mode === 'sandbox-presets') {
        return {
          success: true,
          output: JSON.stringify({
            count: listSandboxPresets().length,
            presets: listSandboxPresets().map((preset) => ({
              id: preset.id,
              label: preset.label,
              replIsolation: preset.config.replIsolation,
              mcpIsolation: preset.config.mcpIsolation,
              windowsMode: preset.config.windowsMode,
              vmBackend: preset.config.vmBackend,
            })),
          }),
        };
      }

      return { success: false, error: `Unknown mode: ${input.mode}` };
    },
  };
}

export const controlTool: Tool = createControlTool();
