/**
 * `agent_knowledge`: reads of the owner's knowledge, the daemon's one store (capabilities/builtin/knowledge.ts; what
 * the Agent kept as Agent Knowledge is carried into it). Each action runs its `knowledge.*` capability as a nested
 * `capability_run` call, judged by that capability's own risk (every one here only reads), the one gate a model's
 * daemon call goes through; this call only routes it and is classed a read.
 */
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { AgentInProcessHost } from './in-process-host.js';
import type { AgentKnowledgeConnectionRuntime } from './knowledge-runtime.js';
import { daemonCapabilityRunner } from './capability-tools.js';
import { readString } from './tool-args.js';

export type AgentKnowledgeToolAction =
  | 'status'
  | 'ask'
  | 'search'
  | 'sources'
  | 'nodes'
  | 'issues'
  | 'item'
  | 'map'
  | 'connectors'
  | 'connector'
  | 'connector_doctor';
export type AgentKnowledgeAskMode = 'concise' | 'standard' | 'detailed';

const ACTIONS: readonly AgentKnowledgeToolAction[] = [
  'status',
  'ask',
  'search',
  'sources',
  'nodes',
  'issues',
  'item',
  'map',
  'connectors',
  'connector',
  'connector_doctor',
];
const ASK_MODES: readonly AgentKnowledgeAskMode[] = ['concise', 'standard', 'detailed'];

function isAction(value: unknown): value is AgentKnowledgeToolAction {
  return typeof value === 'string' && ACTIONS.some(action => action === value);
}

function readLimit(value: unknown, fallback: number, max = 25): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return Math.min(value, max);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, max);
  }
  return fallback;
}

function readMode(value: unknown): AgentKnowledgeAskMode {
  return value === 'concise' || value === 'standard' || value === 'detailed' ? value : 'standard';
}

/** The search capability prints at most this many rows, so a search asks for no more than it can show. */
const SEARCH_ROWS_PRINTED = 10;

/** The knowledge capability one action runs and its inputs, or why the call cannot be made. */
function capabilityOf(args: Record<string, unknown>): { readonly id: string; readonly inputs: Record<string, string> } | { readonly problem: string } {
  const action = args.action;
  if (!isAction(action)) return { problem: `Unknown Agent Knowledge action. Valid values ${ACTIONS.join(', ')}.` };
  if (action === 'status') return { id: 'knowledge.status', inputs: {} };
  if (action === 'ask') {
    const query = readString(args.query);
    if (!query) return { problem: 'query is required for Agent Knowledge ask.' };
    return { id: 'knowledge.ask', inputs: { question: query, mode: readMode(args.mode), limit: String(readLimit(args.limit, 8)) } };
  }
  if (action === 'search') {
    const query = readString(args.query);
    if (!query) return { problem: 'query is required for Agent Knowledge search.' };
    return { id: 'knowledge.search', inputs: { words: query, limit: String(readLimit(args.limit, SEARCH_ROWS_PRINTED, SEARCH_ROWS_PRINTED)) } };
  }
  if (action === 'sources' || action === 'nodes' || action === 'issues') {
    return { id: 'knowledge.list', inputs: { kind: action, limit: String(readLimit(args.limit, 25, 500)) } };
  }
  if (action === 'item') {
    const id = readString(args.id);
    if (!id) return { problem: 'id is required for Agent Knowledge item lookup.' };
    return { id: 'knowledge.get', inputs: { item: id } };
  }
  if (action === 'map') {
    const about = readString(args.query);
    return { id: 'knowledge.map', inputs: { ...(about ? { about } : {}), limit: String(readLimit(args.limit, 50, 500)) } };
  }
  if (action === 'connectors') return { id: 'knowledge.connectors', inputs: {} };
  const connector = readString(args.connectorId) || readString(args.id);
  if (!connector) return { problem: 'connectorId or id is required for Agent Knowledge connector lookup.' };
  return { id: action === 'connector' ? 'knowledge.connector' : 'knowledge.connector-doctor', inputs: { connector } };
}

export function createAgentKnowledgeTool(
  _shellPaths: ShellPathService,
  _configManager: AgentKnowledgeConnectionRuntime['configManager'],
  _inProcess?: AgentInProcessHost | undefined,
): Tool {
  const run = daemonCapabilityRunner();
  return {
    definition: {
      name: 'agent_knowledge',
      activity: { doing: 'Searching', did: 'searched', object: 'knowledge' },
      description: 'Read your knowledge: status, ask, search, sources, nodes, issues, item, map, connectors, connector, connector_doctor.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Read-only knowledge action.',
          },
          query: {
            type: 'string',
            description: 'Question/query for ask, search, or map filtering.',
          },
          id: {
            type: 'string',
            description: 'Knowledge source, node, or issue id for action item.',
          },
          connectorId: {
            type: 'string',
            description: 'Connector id for connector or connector_doctor.',
          },
          limit: {
            type: 'number',
            description: 'Maximum result count. ask: default 8, at most 25. search: default 10, at most 10. sources, nodes, issues: default 25, at most 500. map: default 50, at most 500.',
          },
          mode: {
            type: 'string',
            enum: [...ASK_MODES],
            description: 'Answer detail mode for ask.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      // Reads routed to the daemon's knowledge capabilities, each a nested capability_run call.
      sideEffects: ['state'],
      category: 'read',
    },
    execute: async (rawArgs, options) => {
      const call = capabilityOf(rawArgs);
      if ('problem' in call) return { success: false, error: call.problem };
      options?.signal?.throwIfAborted();
      if (!assertCurrentToolInvocation(rawArgs, options)) return { success: false, error: `${call.id} was not read: it runs only as an admitted tool call.` };
      const answer = await run(call.id, call.inputs, options);
      return answer.ok ? { success: true, output: answer.text || `${call.id}: nothing to show.` } : { success: false, error: answer.error };
    },
  };
}

export function registerAgentKnowledgeTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentKnowledgeConnectionRuntime['configManager'],
  inProcess?: AgentInProcessHost | undefined,
): void {
  registry.register(createAgentKnowledgeTool(shellPaths, configManager, inProcess));
}
