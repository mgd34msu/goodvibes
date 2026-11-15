import type { ToolDefinition } from '../../types/tools.js';

export const REPL_TOOL_SCHEMA: ToolDefinition = {
  name: 'repl',
  description: 'Evaluate one JavaScript or TypeScript snippet with Bun inside the command sandbox and return its printed value and console output. Each eval is stateless (no shared variables); bindings are JSON values exposed as globals. history lists this session\'s eval attempts.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['eval', 'history'] },
      runtime: { type: 'string', enum: ['javascript', 'typescript'], description: 'Default: javascript.' },
      expression: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 0, description: 'Optional execution timeout in ms. Omitted: 120000. 0 waits for completion or cancellation.' },
      offset: { type: 'integer', minimum: 0, description: 'History page offset. Default: 0.' },
      limit: { type: 'integer', minimum: 0, description: 'Optional history page size. Omitted returns the full retained history.' },
      bindings: { type: 'object', additionalProperties: true },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface ReplToolInput {
  readonly mode: 'eval' | 'history';
  readonly timeout_ms?: number | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
  readonly runtime?: 'javascript' | 'typescript' | undefined;
  readonly expression?: string | undefined;
  readonly bindings?: Record<string, unknown> | undefined;
}
