import type { ToolDefinition } from '../../types/tools.js';

export const MCP_TOOL_SCHEMA: ToolDefinition = {
  name: 'mcp',
  description: 'Call tools on connected MCP servers, and inspect servers, tools, security posture and quarantine state.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['call', 'servers', 'tools', 'schema', 'security', 'auth', 'approve-quarantine', 'set-trust', 'set-role'],
        description: 'call runs a tool on a connected server (qualifiedName and input); tools lists the callable names; schema shows one tool\'s arguments.',
      },
      view: {
        type: 'string',
        enum: ['descriptor', 'preview', 'full'],
      },
      qualifiedName: { type: 'string', description: 'mcp:<server>:<tool>, as mode:"tools" lists it.' },
      input: {
        type: 'object',
        description: 'Arguments for mode:"call", shaped by the tool\'s own schema (read it with mode:"schema").',
        additionalProperties: true,
      },
      serverName: { type: 'string' },
      trustMode: {
        type: 'string',
        enum: ['constrained', 'ask-on-risk', 'allow-all', 'blocked'],
      },
      role: {
        type: 'string',
        enum: ['general', 'docs', 'filesystem', 'git', 'database', 'browser', 'deploy', 'automation'],
      },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface McpToolInput {
  readonly mode: 'call' | 'servers' | 'tools' | 'schema' | 'security' | 'auth' | 'approve-quarantine' | 'set-trust' | 'set-role';
  readonly view?: 'descriptor' | 'preview' | 'full' | undefined;
  readonly qualifiedName?: string | undefined;
  readonly input?: Readonly<Record<string, unknown>> | undefined;
  readonly serverName?: string | undefined;
  readonly trustMode?: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked' | undefined;
  readonly role?: 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'deploy' | 'automation' | undefined;
}
