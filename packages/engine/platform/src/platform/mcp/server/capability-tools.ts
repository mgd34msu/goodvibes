/**
 * The two tools `goodvibes-daemon mcp serve` offers by default: find and run
 * every GoodVibes capability through the daemon's `capabilities.find` and
 * `capabilities.run`, instead of one tool per method (that listing stays
 * behind `--categories`, `--allow-write` and `--allow-destructive`). An
 * outside agent's run is decided under the owner's permission mode by the
 * daemon, exactly as the same act from any other agent.
 */
import { CAPABILITY_FIND_METHOD_ID, CAPABILITY_RUN_METHOD_ID } from '../../control-plane/method-catalog-capabilities.js';
import { CAPABILITY_GROUPS_PROMPT } from '../../capabilities/groups.js';
import type { McpToolDefinition, OperatorMcpToolSet } from './tool-definitions.js';

export const CAPABILITY_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'capability_find',
    description: 'Find the GoodVibes capability that does what you need (settings, secrets, hooks, memory, schedules, mail, devices, sessions and everything else a person can do in GoodVibes): say the need in words; three to five come back with id, what each does, where it runs, its inputs and its risk. Nothing runs. Then call capability_run.',
    inputSchema: {
      type: 'object',
      properties: { need: { type: 'string', description: 'What you need done, in plain words.' } },
      required: ['need'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    operatorMethodId: CAPABILITY_FIND_METHOD_ID,
  },
  {
    name: 'capability_run',
    description: 'Run one GoodVibes capability by the id capability_find gave, with its inputs by name. The daemon checks the inputs and decides the call under the owner\'s permission mode (when the owner\'s mode is Ask me, the call waits on their answer). The answer says what happened: the run\'s answer, or the refusal with its reason.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The capability id (hooks.disable).' },
        inputs: { type: 'object', description: 'The inputs by name, as capability_find listed them.', additionalProperties: true },
        workingDirectory: { type: 'string', description: 'The project folder the capability acts on (a hooks file, a project secret); the folder this server was started in when absent.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    operatorMethodId: CAPABILITY_RUN_METHOD_ID,
  },
];

export const CAPABILITY_MCP_TOOL_SET: OperatorMcpToolSet = {
  tools: CAPABILITY_MCP_TOOLS,
  methodIdByToolName: new Map(CAPABILITY_MCP_TOOLS.map((tool) => [tool.name, tool.operatorMethodId])),
};

/** What `initialize` tells the client: the fourteen groups and how to reach them. */
export const CAPABILITY_MCP_INSTRUCTIONS = CAPABILITY_GROUPS_PROMPT;
