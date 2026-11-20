import type { ToolDefinition } from '../../types/tools.js';
import { REPL_RUNTIMES, type ReplRuntime } from './runtimes.js';

/** Attempts a history call returns when it names no limit: the newest ones. */
export const REPL_HISTORY_PAGE = 20;

export const REPL_TOOL_SCHEMA: ToolDefinition = {
  name: 'repl',
  description: 'Evaluate one snippet inside the command sandbox and return its printed value and output. runtime: javascript or typescript (Bun), python (the contained python3), sql (a fresh in-memory SQLite database; prints the last result rows as JSON; bindings are named parameters $name), graphql (parses, prints the normal form and operations; a schema binding with SDL text also validates; nothing is executed). Each eval is stateless (no shared variables); bindings are JSON values exposed as globals. history lists this session\'s eval attempts.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['eval', 'history'], description: 'eval runs expression; history lists this session\'s eval attempts.' },
      runtime: { type: 'string', enum: [...REPL_RUNTIMES], description: 'Default: javascript.' },
      expression: { type: 'string', description: 'The code to evaluate in the chosen runtime (for sql, the statements). Required for eval.' },
      timeout_ms: { type: 'integer', minimum: 0, description: 'Optional execution timeout in ms. Omitted: 120000. 0 waits for completion or cancellation.' },
      offset: { type: 'integer', minimum: 0, description: 'History page offset, oldest first. Omitted: the newest page.' },
      limit: { type: 'integer', minimum: 0, description: 'History page size. Default: 20.' },
      bindings: { type: 'object', additionalProperties: true, description: 'Named JSON values the snippet can use: globals for javascript, typescript and python, $name parameters for sql, and a schema entry (SDL text) for graphql.' },
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
  readonly runtime?: ReplRuntime | undefined;
  readonly expression?: string | undefined;
  readonly bindings?: Record<string, unknown> | undefined;
}
