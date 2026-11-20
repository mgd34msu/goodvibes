import type { ToolDefinition } from '../../types/tools.js';

export const CONTROL_TOOL_SCHEMA: ToolDefinition = {
  name: 'control',
  description: 'List this product\'s own slash commands (name and one-line description) and panels, the built-in subscription providers, and the sandbox presets. A session without a command surface answers available: false.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['commands', 'panels', 'subscriptions', 'sandbox-presets'],
        description: 'What to list: commands (slash commands), panels, subscriptions (built-in subscription providers) or sandbox-presets.',
      },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface ControlToolInput {
  readonly mode: 'commands' | 'panels' | 'subscriptions' | 'sandbox-presets';
}
