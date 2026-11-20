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
        description: 'How much of each server servers and security return: descriptor (a summary, the default), preview, or full (the whole record).',
      },
      qualifiedName: { type: 'string', description: 'mcp:<server>:<tool>, as mode:"tools" lists it.' },
      input: {
        type: 'object',
        description: 'Arguments for mode:"call", shaped by the tool\'s own schema (read it with mode:"schema").',
        additionalProperties: true,
      },
      serverName: { type: 'string', description: 'The server to act on: required for approve-quarantine, set-trust and set-role; for servers, tools and security it narrows the list to that server.' },
      trustMode: {
        type: 'string',
        enum: ['constrained', 'ask-on-risk', 'allow-all', 'blocked'],
        description: 'The trust mode set-trust gives the server.',
      },
      role: {
        type: 'string',
        enum: ['general', 'docs', 'filesystem', 'git', 'database', 'browser', 'deploy', 'automation'],
        description: 'The role set-role gives the server, which decides how its tools are treated (deploy is stored as ops).',
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
