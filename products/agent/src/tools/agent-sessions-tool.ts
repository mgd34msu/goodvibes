import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createHarnessFacade, registerHarnessFacade, type HarnessFacadeDeps } from './agent-harness-facade.ts';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';

type AgentSessionsAction = 'list' | 'get';

interface AgentSessionsToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly sessionId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type AgentSessionsToolDeps = HarnessFacadeDeps;

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

const UNKNOWN_SESSIONS_ACTION = 'Unknown sessions action. Use one of: list, search, status, get.';

function normalizeSessionsAction(value: unknown): AgentSessionsAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (['list', 'search', 'status', 'summary', 'catalog', 'sessions', 'bookmarks'].includes(action)) return 'list';
  if (['get', 'show', 'inspect', 'session'].includes(action)) return 'get';
  return null;
}

function readAction(args: AgentSessionsToolArgs): AgentSessionsAction | null {
  // A word that was sent but is not an action is refused (null), not replaced by an inferred one.
  if (readString(args.action) || readString(args.mode)) return normalizeSessionsAction(args.action) ?? normalizeSessionsAction(args.mode);
  if (readString(args.sessionId) || readString(args.id)) return 'get';
  return 'list';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function listArgs(args: AgentSessionsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'sessions',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function getArgs(args: AgentSessionsToolArgs): Record<string, unknown> {
  const sessionId = readString(args.sessionId) || readString(args.id);
  return compactArgs({
    mode: 'session',
    sessionId,
    target: sessionId ? undefined : args.target,
    query: sessionId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

export function createAgentSessionsTool(deps: AgentSessionsToolDeps): Tool {
  return createHarnessFacade<AgentSessionsToolArgs>(deps, {
    definition: {
      name: 'sessions',
      activity: { doing: 'Looking at', did: 'looked at', object: 'past conversations' },
      description: 'Read saved sessions, bookmarks, and transcript continuity.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'search', 'status', 'get'],
            description: 'List/search sessions or inspect one saved session.',
          },
          id: { type: 'string', description: 'Alias for sessionId.' },
          sessionId: { type: 'string', description: 'Saved session id.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detail, snippets, and route metadata.' },
          limit: { type: 'number', description: 'Maximum sessions returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    route({ args, forward }) {
      const action = readAction(args);
      if (!action) return error(UNKNOWN_SESSIONS_ACTION);
      if (action === 'list') return forward(listArgs(args));
      if (action === 'get') return forward(getArgs(args));
      return error(UNKNOWN_SESSIONS_ACTION);
    },
  });
}

export function registerAgentSessionsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  registerHarnessFacade(registry, createAgentSessionsTool({ commandRegistry, commandContext, toolRegistry: registry }), commandContext);
}
