import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { captureModelReadingInput } from './agent-harness-model-reading-source.ts';
import { createHarnessFacade, registerHarnessFacade, type HarnessFacadeDeps } from './agent-harness-facade.ts';

type AgentDelegationAction = 'status' | 'routes' | 'route';

interface AgentDelegationToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly delegationRouteId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type AgentDelegationToolDeps = HarnessFacadeDeps;

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDelegationAction(value: unknown): AgentDelegationAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'overview' || action === 'policy' || action === 'decision' || action === 'decisions' || action === 'delegation_posture') return 'status';
  if (action === 'routes' || action === 'list' || action === 'catalog' || action === 'posture') return 'routes';
  if (action === 'route' || action === 'item' || action === 'card' || action === 'show' || action === 'inspect' || action === 'delegation_route') return 'route';
  return null;
}

function readAction(args: AgentDelegationToolArgs): AgentDelegationAction | null {
  const explicit = normalizeDelegationAction(args.action) ?? normalizeDelegationAction(args.mode);
  if (explicit) return explicit;
  // An action or mode that was given but is not one of ours is not a request to guess: answering with another view would read as the requested one.
  if (readString(args.action) || readString(args.mode)) return null;
  if (readString(args.delegationRouteId) || readString(args.id)) return 'route';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function routeId(args: AgentDelegationToolArgs): string {
  return readString(args.delegationRouteId) || readString(args.id);
}

function postureArgs(args: AgentDelegationToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'delegation_posture',
    query: args.query ?? args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function routeArgs(args: AgentDelegationToolArgs): Record<string, unknown> {
  const delegationRouteId = routeId(args);
  return compactArgs({
    mode: 'delegation_route',
    delegationRouteId,
    target: delegationRouteId ? undefined : args.target,
    query: delegationRouteId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

export function createAgentDelegationTool(deps: AgentDelegationToolDeps): Tool {
  return createHarnessFacade<AgentDelegationToolArgs>(deps, {
    definition: {
      name: 'delegation',
      description: 'Inspect build delegation routes and policy.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'routes', 'route'],
            description: 'Read-only delegation status, route catalog, or single route inspection.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Alias for delegationRouteId.' },
          delegationRouteId: { type: 'string', description: 'Delegation route id.' },
          target: { type: 'string', description: 'Lookup target or route search text.' },
          query: { type: 'string', description: 'Route search text.' },
          includeParameters: { type: 'boolean', description: 'Include required fields, evidence, and confirmed handoff routes.' },
          limit: { type: 'number', description: 'Maximum route rows returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    selected: isDelegationCatalogCall,
    route({ args, forward }) {
      const action = readAction(args);
      if (action === null) return error('Unknown delegation action. Use action (or mode) as one of: status, routes, route.');

      if (action === 'status' || action === 'routes') return forward(postureArgs(args));
      if (action === 'route') return forward(routeArgs(args));

      return error('Unknown delegation action. Use action:"status" for policy or action:"route" for one delegation route.');
    },
  });
}

function isDelegationCatalogCall(input: Record<string, unknown>): boolean {
  const args = captureModelReadingInput(input);
  return Boolean(readString(args.query) || readString(args.target));
}

export function registerAgentDelegationTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  registerHarnessFacade(registry, createAgentDelegationTool({ commandRegistry, commandContext, toolRegistry: registry }), commandContext, isDelegationCatalogCall);
}
