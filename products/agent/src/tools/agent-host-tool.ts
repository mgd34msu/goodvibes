import { catalogRoutingInput } from './agent-harness-catalog-ingress.ts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createHarnessFacade, registerHarnessFacade, type HarnessFacadeDeps } from './agent-harness-facade.ts';

type AgentHostAction =
  | 'status'
  | 'capabilities'
  | 'capability'
  | 'services'
  | 'service'
  | 'methods'
  | 'method';

interface AgentHostToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly capabilityId?: unknown;
  readonly endpointId?: unknown;
  readonly methodId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type AgentHostToolDeps = HarnessFacadeDeps;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHostAction(value: unknown): AgentHostAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'health' || action === 'readiness' || action === 'daemon_status' || action === 'connected_host_status') return 'status';
  if (action === 'capabilities' || action === 'capability_map' || action === 'map' || action === 'inventory' || action === 'connected_host' || action === 'daemon' || action === 'host' || action === 'boundaries') return 'capabilities';
  if (action === 'capability' || action === 'show_capability' || action === 'inspect_capability' || action === 'connected_host_capability') return 'capability';
  if (action === 'services' || action === 'service_posture' || action === 'service_status' || action === 'endpoints' || action === 'endpoint_list') return 'services';
  if (action === 'service' || action === 'endpoint' || action === 'service_endpoint') return 'service';
  if (action === 'methods' || action === 'operator_methods' || action === 'operator_contract' || action === 'operations' || action === 'actions') return 'methods';
  if (action === 'method' || action === 'operator_method' || action === 'operation') return 'method';
  return null;
}

function readAction(args: AgentHostToolArgs): AgentHostAction {
  const explicit = normalizeHostAction(args.action) ?? normalizeHostAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.methodId)) return 'method';
  if (readString(args.endpointId)) return 'service';
  if (readString(args.capabilityId) || readString(args.target) || readString(args.query)) return 'capability';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function isHostCatalogQuery(input: Record<string, unknown>): boolean {
  const routing = catalogRoutingInput(input);
  return ['methods', 'method'].includes(readAction(routing))
    && [routing.query, routing.target].some((value) => typeof value === 'string' && value.trim().length > 0);
}

export function createAgentHostTool(deps: AgentHostToolDeps): Tool {
  return createHarnessFacade<AgentHostToolArgs>(deps, {
    definition: {
      name: 'host',
      activity: { doing: 'Checking', did: 'checked', object: 'the assistant service' },
      description: 'Inspect GoodVibes host status, services, and methods.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'capabilities', 'capability', 'services', 'service', 'methods', 'method'],
            description: 'Read host status, capabilities, services, and method posture.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          capabilityId: { type: 'string', description: 'Connected-host capability id.' },
          endpointId: { type: 'string', description: 'Service endpoint id.' },
          methodId: { type: 'string', description: 'Daemon operator method id.' },
          target: { type: 'string', description: 'Lookup target for a capability, endpoint, or method.' },
          query: { type: 'string', description: 'Search text for capabilities or methods.' },
          includeParameters: { type: 'boolean', description: 'Include detailed method schemas, route families, probes, or diagnostics.' },
          limit: { type: 'number', description: 'Maximum methods to return for action:methods.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    selected: isHostCatalogQuery,
    route({ args, forward: dispatch }) {
      const requestedVerb = readString(args.action) || readString(args.mode);
      if (requestedVerb && !normalizeHostAction(args.action) && !normalizeHostAction(args.mode)) {
        return { success: false, error: `Unknown host action "${requestedVerb}". The host tool only reads: use action status, capabilities, capability, services, service, methods or method. It cannot restart or change the connected host.` };
      }
      const action = readAction(args);

      if (action === 'status') {
        return dispatch(compactArgs({
          mode: 'connected_host_status',
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'capabilities') {
        return dispatch(compactArgs({
          mode: 'connected_host',
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'capability') {
        return dispatch(compactArgs({
          mode: 'connected_host_capability',
          capabilityId: args.capabilityId,
          target: args.target,
          query: args.query,
        }));
      }
      if (action === 'services') {
        return dispatch(compactArgs({
          mode: 'service_posture',
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'service') {
        return dispatch(compactArgs({
          mode: 'service_endpoint',
          endpointId: args.endpointId,
          target: args.target,
          query: args.query,
        }));
      }
      if (action === 'methods') {
        return dispatch(compactArgs({
          mode: 'operator_methods',
          query: args.query ?? args.target,
          includeParameters: args.includeParameters,
          limit: args.limit,
        }));
      }
      return dispatch(compactArgs({
        mode: 'operator_method',
        methodId: args.methodId,
        target: args.target,
        query: args.query,
      }));
    },
  });
}

export function registerAgentHostTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  registerHarnessFacade(registry, createAgentHostTool({ commandRegistry, commandContext, toolRegistry: registry }), commandContext, isHostCatalogQuery);
}
