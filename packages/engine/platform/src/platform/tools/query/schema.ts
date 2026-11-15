import type { ToolDefinition } from '../../types/tools.js';

export const QUERY_TOOL_SCHEMA: ToolDefinition = {
  name: 'query',
  description: 'Keep your own notes on questions, answers, and closure. Queries are stored in a file; asking one does not deliver it to an operator or any surface, and the answer is whatever you record.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['ask', 'list', 'show', 'answer', 'close'] },
      view: { type: 'string', enum: ['summary', 'full'] },
      queryId: { type: 'string' },
      prompt: { type: 'string' },
      askedBy: { type: 'string' },
      target: { type: 'string' },
      answer: { type: 'string' },
      resolution: { type: 'string' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface QueryToolInput {
  readonly mode: 'ask' | 'list' | 'show' | 'answer' | 'close';
  readonly view?: 'summary' | 'full' | undefined;
  readonly queryId?: string | undefined;
  readonly prompt?: string | undefined;
  readonly askedBy?: string | undefined;
  readonly target?: string | undefined;
  readonly answer?: string | undefined;
  readonly resolution?: string | undefined;
}
