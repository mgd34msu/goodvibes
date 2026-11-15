import type { ToolDefinition } from '../../types/tools.js';

export const QUERY_TOOL_SCHEMA: ToolDefinition = {
  name: 'query',
  description: 'Leave the owner a question and carry on working. The question goes to the owner\'s inbox, which he reads and answers later from either terminal app, the web UI or a push notification on his phone when push is on. Read the answer with show (or list) later in this session; nothing waits for it.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['ask', 'show', 'list', 'withdraw'],
        description: 'ask posts a question and returns its id at once; show reads one question and its answer; list reads this session\'s questions; withdraw takes back a question that no longer matters.',
      },
      question: { type: 'string', description: '(ask) The question, one line the owner can answer; at most 200 characters.' },
      detail: { type: 'string', description: '(ask) Context the owner needs to answer: what you found, what each choice means.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 8,
        description: '(ask) Short answers the owner can pick from; he can always answer in his own words instead.',
      },
      key: { type: 'string', description: '(ask) Your own name for the question; asking again under the same key while it is open returns the first question instead of a second one.' },
      questionId: { type: 'string', description: '(show, withdraw) The id ask returned.' },
      status: { type: 'string', enum: ['open', 'closed', 'all'], description: '(list) Default: all.' },
      reason: { type: 'string', description: '(withdraw) Why the question no longer needs an answer.' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface QueryToolInput {
  readonly mode: 'ask' | 'show' | 'list' | 'withdraw';
  readonly question?: string | undefined;
  readonly detail?: string | undefined;
  readonly options?: readonly string[] | undefined;
  readonly key?: string | undefined;
  readonly questionId?: string | undefined;
  readonly status?: 'open' | 'closed' | 'all' | undefined;
  readonly reason?: string | undefined;
}
