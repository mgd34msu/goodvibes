import { type CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { captureStatefulCatalogRequest } from './agent-harness-stateful-catalog-source.ts';
import type { CommandContext } from '../input/command-registry.ts';
import {
  buildCliServicePosture,
  probeCliServiceEndpoint,
  type CliServiceEndpointPosture,
  type CliServicePosture,
} from '../cli/service-posture.ts';
import type { RuntimeEndpointId } from '../cli/endpoints.ts';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';

export interface AgentHarnessServicePostureArgs {
  readonly endpointId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

type ServiceEndpointLookupSource = 'endpointId' | 'target' | 'query';

type ServiceEndpointResolution =
  | { readonly status: 'found'; readonly endpoint: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

const SERVICE_ENDPOINT_IDS: readonly RuntimeEndpointId[] = ['controlPlane', 'httpListener', 'web'];

function resolveHomeDirectory(context: CommandContext): string {
  return context.workspace.shellPaths?.homeDirectory
    ?? context.platform.configManager.getHomeDirectory()
    ?? '';
}

function resolveWorkingDirectory(context: CommandContext): string {
  return context.workspace.shellPaths?.workingDirectory
    ?? context.platform.configManager.getWorkingDirectory()
    ?? '';
}

function servicePostureRuntime(context: CommandContext) {
  return {
    configManager: context.platform.configManager,
    workingDirectory: resolveWorkingDirectory(context),
    homeDirectory: resolveHomeDirectory(context),
  };
}

function servicePostureOptions(args: AgentHarnessServicePostureArgs) {
  const includeDetails = args.includeParameters === true;
  return {
    probe: includeDetails,
    logTailBytes: includeDetails ? 4096 : 0,
  };
}

function summarizeLog(posture: CliServicePosture, includeTail: boolean): Record<string, unknown> {
  return {
    path: posture.log.path,
    exists: posture.log.exists,
    size: posture.log.size,
    modifiedAt: posture.log.modifiedAt,
    readError: posture.log.readError ?? null,
    ...(includeTail && posture.log.tail !== undefined ? { tail: posture.log.tail } : {}),
  };
}

function describeEndpoint(
  endpoint: CliServiceEndpointPosture,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    id: endpoint.id,
    label: endpoint.label,
    enabled: endpoint.enabled,
    binding: endpoint.binding,
    bindPosture: endpoint.bindPosture,
    networkFacing: endpoint.networkFacing,
    ...(endpoint.reachable !== undefined ? { reachable: endpoint.reachable } : {}),
    modelRoute: serviceEndpointModelRoute(),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      policy: {
        effect: 'read-only',
        modelOperation: 'Inspect endpoint binding, network-facing posture, and optional reachability only.',
        lifecycle: 'Use setup or confirmed GoodVibes daemon operator methods for service lifecycle/listener changes.',
        settings: 'Use settings action:"list|get" for endpoint settings; raw danger toggles stay protected.',
      },
    } : {}),
  };
}


function serviceEndpointModelRoute(): string {
  return 'host action:"service" or settings action:"get"';
}

function endpointLookupFromArgs(args: AgentHarnessServicePostureArgs): { readonly source: ServiceEndpointLookupSource; readonly input: string } | null {
  const endpointId = readString(args.endpointId);
  if (endpointId) return { source: 'endpointId', input: endpointId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}


const MISSING_ENDPOINT_LOOKUP = 'service_endpoint requires endpointId, target, or query. Valid endpoint ids are controlPlane, httpListener, and web.';

async function matchEndpoint(
  endpoints: readonly CliServiceEndpointPosture[],
  lookup: { readonly source: ServiceEndpointLookupSource; readonly input: string },
  catalogOptions: CatalogRankingOptions = {},
): Promise<{ readonly endpoint: CliServiceEndpointPosture; readonly resolvedBy: string } | null> {
  const normalized = lookup.input.toLowerCase();
  const exact = endpoints.find((endpoint) => endpoint.id === lookup.input);
  if (exact) return { endpoint: exact, resolvedBy: 'id' };
  const insensitive = endpoints.find((endpoint) => endpoint.id.toLowerCase() === normalized);
  if (insensitive) return { endpoint: insensitive, resolvedBy: 'case-insensitive-id' };
  const label = endpoints.find((endpoint) => endpoint.label.toLowerCase() === normalized);
  if (label) return { endpoint: label, resolvedBy: 'label' };
  const selected = await selectHarnessCatalog(endpoints, lookup.input, endpoint => ({ id: endpoint.id, description: endpoint.label }), catalogOptions, 'agent.service.endpoint');
  return selected ? { endpoint: selected, resolvedBy: 'search' } : null;
}

export function servicePostureCatalogStatus(): Record<string, unknown> {
  return {
    modes: ['service_posture', 'service_endpoint'],
    endpointIds: SERVICE_ENDPOINT_IDS,
    readOnly: true,
    lifecycle: 'Service posture is diagnostic; lifecycle/listener changes require setup or confirmed daemon operator methods.',
  };
}

export async function servicePostureSummary(
  context: CommandContext,
  args: AgentHarnessServicePostureArgs,
  options: CatalogRankingOptions = {},
): Promise<Record<string, unknown>> {
  const request = captureStatefulCatalogRequest(context, args, options);
  args = request.input;
  const includeDetails = args.includeParameters === true;
  const posture = await buildCliServicePosture(servicePostureRuntime(context), { ...servicePostureOptions(args), ...request.options });
  request.assertCurrent();
  return {
    ownership: 'goodvibes-daemon',
    readOnly: true,
    lifecycle: 'GoodVibes Agent reports service posture here. Lifecycle/listener changes require setup or confirmed daemon operator methods.',
    modelRoute: serviceEndpointModelRoute(),
    config: posture.config,
    // The connected host's lifecycle is not observed from here: no installed/running
    // booleans are reported. Whether it answers is `endpoints[].reachable`; whether it
    // is installed and running is the daemon's own `services.status`.
    managed: { owner: 'connected-host', lifecycle: 'not managed by goodvibes-agent', status: 'agent_operator_method methodId:"services.status"' },
    endpoints: posture.endpoints.map((endpoint) => describeEndpoint(endpoint, { includeParameters: includeDetails })),
    log: summarizeLog(posture, includeDetails),
    issues: posture.issues,
    advisories: posture.advisories,
    ...(includeDetails ? { modelAccess: {
      endpointLookup: 'Use host action:"service" with endpointId, target, or query to inspect one endpoint.',
      settings: 'Use settings action:"list" includeHidden:true for endpoint setting descriptors. Host-owned listener settings remain read-only.',
      liveHostStatus: 'Use host action:"status" for token posture and Agent Knowledge route readiness.',
    } } : {}),
  };
}

/**
 * One endpoint: the lookup is checked first, the posture is read without the
 * log tail (this answer never shows it) and only the resolved endpoint is
 * probed.
 */
export async function describeHarnessServiceEndpoint(
  context: CommandContext,
  args: AgentHarnessServicePostureArgs,
  options: CatalogRankingOptions = {},
): Promise<ServiceEndpointResolution> {
  const lookup = endpointLookupFromArgs(args);
  if (!lookup) return { status: 'missing_lookup', usage: MISSING_ENDPOINT_LOOKUP };
  const runtime = servicePostureRuntime(context);
  const posture = await buildCliServicePosture(runtime, { signal: options.signal, probe: false, logTailBytes: 0 });
  const match = await matchEndpoint(posture.endpoints, lookup, options);
  if (!match) {
    return {
      status: 'missing_lookup',
      usage: `Unknown service endpoint ${lookup.input}. Valid endpoint ids are controlPlane, httpListener, and web.`,
    };
  }
  const endpoint = await probeCliServiceEndpoint(runtime, match.endpoint);
  options.signal?.throwIfAborted();
  return { status: 'found', endpoint: describeEndpoint(endpoint, { includeParameters: true, lookup: { ...lookup, resolvedBy: match.resolvedBy } }) };
}
