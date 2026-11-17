import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import { selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
/**
 * agent-harness-connected-host-capabilities.ts, the connected-host capability
 * map the harness serves, and the route families behind it.
 *
 * Split out of agent-harness-metadata.ts when that module passed the 800-line
 * ceiling. The seam is the subject, not the line count: everything here is
 * about what a connected host can do and which platform operator route reaches it,
 * while what stays behind is the local command-policy table. Its sibling
 * agent-harness-connected-host-status.ts already owned the status half.
 */
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { resolveAgentConnectedHostConnection } from '../agent/routine-schedule-promotion.ts';
import { previewHarnessText } from '@goodvibes-jev/engine/terminal-shell/agent-turn/preview-text';
import { agentHarnessModes, hostActions, settingsActions } from './agent-harness-route-format.ts';
import { operatorBriefingRoutes } from '@goodvibes-jev/engine/terminal-shell/agent-turn/operator-briefing-tool';
import { OPERATOR_ACTION_IDS } from '@goodvibes-jev/engine/terminal-shell/agent-turn/operator-actions';
import { SOURCE_KINDS } from '@goodvibes-jev/engine/terminal-shell/agent-turn/knowledge-ingest-tool';
import { harnessDisplayPath } from './agent-harness-display-path.ts';
import { EFFECT_ADMISSION_SENTENCE } from '@goodvibes-jev/engine/terminal-shell/agent-turn/effect-admission';

/**
 * The one statement of who manages connected-host lifecycle and listeners,
 * shared by every catalog that describes it so none can contradict another.
 */
/** Who owns the connected host: the GoodVibes daemon, which this Agent reaches but does not manage. */
export const CONNECTED_HOST_OWNERSHIP = 'goodvibes-daemon';

export const CONNECTED_HOST_LIFECYCLE_STATEMENT = `Connected-host lifecycle and listener changes (start, stop, restart, install, upgrade, expose or mutate a listener) are daemon operations. The package CLI mirror blocks those tokens; Agent reaches the supported daemon service methods only through agent_operator_method. ${EFFECT_ADMISSION_SENTENCE}`;

export type ConnectedHostCapabilityResolution =
  | { readonly status: 'found'; readonly detail: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] };

/** The registered tool names, read once per call. */
function registeredToolNames(toolRegistry: ToolRegistry): ReadonlySet<string> {
  return new Set(toolRegistry.getToolDefinitions().map((tool) => tool.name));
}

function connectedHostCapabilityModelRoute(capability: Record<string, unknown>): string {
  const modelTools = Array.isArray(capability.modelTools)
    ? capability.modelTools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  if (modelTools.length > 0) return previewHarnessText(modelTools.join(' or '));
  return 'host action:"capability"';
}

function blockedConnectedHostModelRoute(): string {
  return hostActions('services', 'status');
}

export function connectedHostCapabilityMap(toolRegistry: ToolRegistry, registered: ReadonlySet<string> = registeredToolNames(toolRegistry)): readonly Record<string, unknown>[] {
  const withAvailability = (capability: Record<string, unknown> & { readonly modelTools: readonly string[] }): Record<string, unknown> => ({
    ...capability,
    access: 'tool',
    modelRoute: connectedHostCapabilityModelRoute(capability),
    harnessRoute: 'agent_harness mode:"connected_host_capability"',
    modelAccess: {
      inspectCapability: 'host action:"capability"',
      liveStatus: 'host action:"status"',
      endpointPosture: 'host action:"services"',
      routeFamilies: 'host action:"capabilities" includeParameters:true',
      operate: connectedHostCapabilityModelRoute(capability),
    },
    // modelTools are alternatives (the route text joins them with "or"), so one registered tool makes the capability reachable.
    available: capability.modelTools.some((toolName) => registered.has(toolName)),
  });
  return [
    withAvailability({
      id: 'operator-briefing',
      effect: 'read-only-network',
      modelTools: ['agent_operator_briefing'],
      workspaceCategories: ['home', 'work', 'host', 'automation'],
      slashCommandFamilies: ['approval', 'automation', 'schedule'],
      purpose: 'Read pending work, approvals, automation, schedules, and scheduler capacity from public operator routes.',
    }),
    withAvailability({
      id: 'operator-actions',
      effect: 'admitted-connected-host-state',
      modelTools: ['agent_operator_action'],
      workspaceCategories: ['automation', 'host'],
      allowedActions: OPERATOR_ACTION_IDS,
      purpose: 'Perform one explicit allowlisted approval, automation, run, or schedule action.',
    }),
    withAvailability({
      id: 'schedule-edit',
      effect: 'admitted-connected-host-state',
      modelTools: ['schedule', 'agent_schedule_edit'],
      workspaceCategories: ['automation', 'personal-ops'],
      slashCommandFamilies: ['schedule'],
      methodIds: ['automation.jobs.update'],
      purpose: 'Edit one explicit connected schedule name, cadence, or prompt.',
    }),
    withAvailability({
      id: 'agent-knowledge-read',
      effect: 'read-only-network',
      modelTools: ['agent_knowledge'],
      workspaceCategories: ['knowledge', 'research'],
      slashCommandFamilies: ['knowledge'],
      allowedActions: [
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
      ],
      purpose: 'Read isolated Agent Knowledge status, answers, search results, source/node/issue lists, items, map summaries, and connector diagnostics through the Agent route family.',
    }),
    withAvailability({
      id: 'agent-knowledge-ingest',
      effect: 'confirmed-agent-knowledge-write',
      modelTools: ['agent_knowledge_ingest'],
      workspaceCategories: ['knowledge', 'research'],
      slashCommandFamilies: ['knowledge'],
      sourceKinds: SOURCE_KINDS,
      purpose: 'Ingest explicit user-approved sources into isolated Agent Knowledge.',
    }),
    withAvailability({
      id: 'channels',
      effect: 'confirmed-external-delivery',
      modelTools: ['agent_channel_send'],
      workspaceCategories: ['onboarding-channels'],
      slashCommandFamilies: ['channels', 'channel'],
      targetKinds: ['channel', 'route', 'webhook', 'link'],
      purpose: 'Send one explicit message through a configured Agent delivery target.',
    }),
    withAvailability({
      id: 'notifications',
      effect: 'confirmed-external-delivery',
      modelTools: ['agent_notify'],
      workspaceCategories: ['onboarding-channels'],
      slashCommandFamilies: ['notify'],
      purpose: 'Send one explicit notification using configured notification routes.',
    }),
    withAvailability({
      id: 'reminders-and-schedules',
      effect: 'admitted-connected-host-state',
      modelTools: ['schedule', 'agent_autonomy_schedule', 'agent_reminder_schedule'],
      workspaceCategories: ['automation', 'routines'],
      slashCommandFamilies: ['schedule', 'reminder'],
      scheduleKinds: ['at', 'every', 'cron'],
      purpose: 'Create one connected reminder or autonomous Agent schedule from a direct user request.',
    }),
    withAvailability({
      id: 'voice-media',
      effect: 'provider-network-and-artifacts',
      modelTools: ['agent_media_generate'],
      workspaceCategories: ['onboarding-voice-media', 'documents'],
      slashCommandFamilies: ['media', 'image'],
      purpose: 'Generate media through configured Agent media providers and normal artifact storage.',
    }),
  ];
}

export function connectedHostRouteFamilies(): readonly Record<string, unknown>[] {
  return [
    {
      id: 'agent-knowledge',
      prefixes: ['/api/goodvibes-agent/knowledge/*'],
      modelTools: ['agent_knowledge', 'agent_knowledge_ingest'],
      modelRoute: 'agent_knowledge or agent_knowledge_ingest',
      boundary: 'Agent-owned knowledge segment only; no fallback to default or non-Agent knowledge.',
    },
    {
      id: 'operator-read',
      // The briefing tool's own route set, not a second copy of it: this report
      // exists to tell an operator what that tool reaches, and a hand-kept list
      // beside it is a claim nothing keeps true.
      routes: operatorBriefingRoutes().map((route) => route.path),
      modelTools: ['agent_operator_briefing'],
      modelRoute: 'agent_operator_briefing',
      boundary: 'Read-only public operator briefing routes.',
    },
    {
      id: 'operator-actions',
      routes: ['public operator action methods for approvals, automation jobs, automation runs, and schedules'],
      modelTools: ['agent_operator_action'],
      modelRoute: 'agent_operator_action',
      boundary: 'Allowlisted confirmed mutations only; no arbitrary route invocation.',
    },
    {
      id: 'delivery',
      routes: ['configured channel, notification, and delivery targets'],
      modelTools: ['agent_channel_send', 'agent_notify'],
      modelRoute: 'agent_channel_send or agent_notify',
      boundary: 'Explicit user-approved delivery only. Account creation is authorized separately and is recorded in the account register, not blocked here.',
    },
    {
      id: 'connected-schedules',
      routes: ['public schedule creation, patch, run, toggle, and delete routes'],
      modelTools: ['schedule', 'agent_autonomy_schedule', 'agent_reminder_schedule', 'agent_schedule_edit', 'agent_operator_action'],
      modelRoute: 'schedule action:"list|create|remind|edit|run|pause|resume|delete"',
      boundary: 'Connected schedules only, so scheduled work stays listable and cancellable; no unregistered local scheduler.',
    },
  ];
}

function normalizeCapabilityQuery(value: string): string {
  return value.trim().toLowerCase();
}

function recordTextMatches(record: Record<string, unknown>, query: string): boolean {
  if (!query) return false;
  const values = Object.values(record).flatMap((value) => Array.isArray(value) ? value : [value]);
  return values
    .filter((value): value is string | number | boolean => (
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ))
    .map((value) => String(value).toLowerCase())
    .some((value) => value === query || value.includes(query));
}

function relatedConnectedHostRouteFamilies(capability: Record<string, unknown>): readonly Record<string, unknown>[] {
  const modelTools = Array.isArray(capability.modelTools)
    ? capability.modelTools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const capabilityId = typeof capability.id === 'string' ? capability.id : '';
  return connectedHostRouteFamilies().filter((family) => {
    const familyTools = Array.isArray(family.modelTools)
      ? family.modelTools.filter((tool): tool is string => typeof tool === 'string')
      : [];
    if (familyTools.some((tool) => modelTools.includes(tool))) return true;
    return capabilityId.length > 0 && recordTextMatches(family, capabilityId);
  });
}

type CapabilityAccess = 'tool' | 'gated' | 'blocked';
type CapabilityEntry = { readonly access: CapabilityAccess; readonly capability: Record<string, unknown> };

const INSPECT_ROUTES = {
  inspectCapability: 'host action:"capability"',
  connectedHostInventory: 'host action:"capabilities" includeParameters:true',
  liveStatus: 'host action:"status"',
  endpointPosture: 'host action:"services"',
} as const;

/** The detail of one capability, built from its one `access` field so its routes cannot contradict each other. */
function connectedHostCapabilityDetail(entry: CapabilityEntry): Record<string, unknown> {
  const harnessRoute = 'agent_harness mode:"connected_host_capability"';
  if (entry.access === 'tool') {
    return {
      status: 'allowed',
      access: 'tool',
      capability: entry.capability,
      modelRoute: connectedHostCapabilityModelRoute(entry.capability),
      harnessRoute,
      relatedRouteFamilies: relatedConnectedHostRouteFamilies(entry.capability),
      modelAccess: { ...INSPECT_ROUTES, operate: connectedHostCapabilityModelRoute(entry.capability) },
      operatorMethodMode: 'Use host action:"methods" for the public operator and Agent Knowledge method catalog. Use action:"method" for one method.',
      servicePostureMode: 'Use host action:"services" for endpoint binding, network-facing posture, issue, and redacted-log diagnostics. Use action:"service" for one endpoint.',
      statusMode: 'Use host action:"status" for live read-only reachability, token posture, and Agent Knowledge route readiness.',
      boundary: 'Use only the listed first-class model tools, slash-command families, and workspace categories. Mutations still require explicit confirmation through those tools or command routes.',
    };
  }
  if (entry.access === 'gated') {
    return {
      status: 'gated',
      access: 'gated',
      capability: entry.capability,
      modelRoute: 'agent_operator_method',
      harnessRoute,
      available: entry.capability.available === true,
      modelAccess: { ...INSPECT_ROUTES, findMethod: 'host action:"methods"', operate: `agent_operator_method methodId:"<method>". ${EFFECT_ADMISSION_SENTENCE}` },
      boundary: 'Operable only through agent_operator_method on a method the daemon contract publishes, and only under a recorded effect admission for that call.',
    };
  }
  return {
    status: 'blocked',
    access: 'blocked',
    capability: entry.capability,
    modelRoute: blockedConnectedHostModelRoute(),
    harnessRoute,
    available: false,
    modelAccess: { ...INSPECT_ROUTES, operate: 'not exposed' },
    boundary: 'No route reaches this from the model; the capability says what to use instead.',
  };
}

function capabilityEntries(toolRegistry: ToolRegistry): readonly CapabilityEntry[] {
  const registered = registeredToolNames(toolRegistry);
  return [
    ...connectedHostCapabilityMap(toolRegistry, registered).map(capability => ({ access: 'tool' as const, capability })),
    ...gatedConnectedHostCapabilities(registered).map(capability => ({ access: 'gated' as const, capability })),
    ...blockedConnectedHostCapabilities().map(capability => ({ access: 'blocked' as const, capability })),
  ];
}

/** The capability ids, constant: an exact id is answered without reading the tool registry first. */
const CAPABILITY_IDS = ['operator-briefing', 'operator-actions', 'schedule-edit', 'agent-knowledge-read', 'agent-knowledge-ingest', 'channels',
  'notifications', 'reminders-and-schedules', 'voice-media', 'connected-host-lifecycle', 'arbitrary-connected-host-mutations',
  'non-agent-knowledge', 'hidden-background-work'] as const;

export async function describeConnectedHostCapability(toolRegistry: ToolRegistry, rawQuery: string,
  options: CatalogRankingOptions = {}): Promise<ConnectedHostCapabilityResolution | null> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const input = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const query = normalizeCapabilityQuery(input);
  if (!query) return null;
  const id = CAPABILITY_IDS.find((candidate) => candidate === query);
  const entries = capabilityEntries(toolRegistry);
  const exact = id ? entries.find((entry) => entry.capability.id === id) : undefined;
  if (exact) return { status: 'found', detail: connectedHostCapabilityDetail(exact) };
  const selected = await selectHarnessCatalog(entries, input,
    (entry) => ({ id: String(entry.capability.id), description: `${String(entry.capability.purpose ?? entry.capability.reason ?? '')} (${entry.access})` }),
    options, 'agent.connected-host-capability.select');
  options.signal?.throwIfAborted();
  return selected ? { status: 'found', detail: connectedHostCapabilityDetail(selected) } : null;
}

export function connectedHostSummary(
  context: CommandContext,
  toolRegistry: ToolRegistry,
  options: { readonly includeParameters?: boolean } = {},
): Record<string, unknown> {
  const shellPaths = context.workspace.shellPaths;
  const homeDirectory = shellPaths?.homeDirectory ?? context.platform.configManager.getHomeDirectory() ?? '';
  const connection = resolveAgentConnectedHostConnection(context.platform.configManager, homeDirectory);
  const routeFamilies = connectedHostRouteFamilies();
  const registered = registeredToolNames(toolRegistry);
  const capabilities = connectedHostCapabilityMap(toolRegistry, registered);
  const gatedCapabilities = gatedConnectedHostCapabilities(registered);
  const blockedCapabilities = blockedConnectedHostCapabilities();
  return {
    baseUrl: connection.baseUrl,
    operatorToken: connection.token ? 'configured' : 'missing',
    tokenPath: harnessDisplayPath(connection.tokenPath, homeDirectory),
    ownership: CONNECTED_HOST_OWNERSHIP,
    lifecycle: CONNECTED_HOST_LIFECYCLE_STATEMENT,
    modes: {
      servicePosture: agentHarnessModes('service_posture', 'service_endpoint'),
      operatorMethods: agentHarnessModes('operator_methods', 'operator_method'),
      liveStatus: agentHarnessModes('connected_host_status'),
      capabilityDetail: agentHarnessModes('connected_host_capability'),
      daemonAliases: agentHarnessModes('daemon', 'daemon_status'),
    },
    modelRoute: hostActions('capabilities', 'capability'),
    modelAccess: {
      inventory: 'host action:"capabilities" includeParameters:true',
      liveStatus: 'host action:"status"',
      capabilityDetail: 'host action:"capability" capabilityId:"..."',
      servicePosture: 'host action:"services"',
      daemonAliases: 'agent_harness mode:"daemon" or mode:"daemon_status"',
      daemonStatusAlias: 'agent_harness mode:"daemon_status"',
      lifecycle: `use setup or agent_operator_method for supported daemon service methods. ${EFFECT_ADMISSION_SENTENCE}`,
    },
    counts: {
      routeFamilies: routeFamilies.length,
      allowedCapabilities: capabilities.length,
      availableCapabilities: capabilities.filter((capability) => capability.available === true).length,
      gatedCapabilities: gatedCapabilities.length,
      blockedCapabilities: blockedCapabilities.length,
    },
    ...(options.includeParameters === true ? {
      routeFamilies,
      capabilities,
      gatedCapabilities,
      blockedCapabilities,
    } : {}),
  };
}

/**
 * Daemon operations the model can reach only through agent_operator_method,
 * each call under its own recorded effect admission. Available when that tool
 * is registered here.
 */
export function gatedConnectedHostCapabilities(registered?: ReadonlySet<string>): readonly Record<string, unknown>[] {
  const available = registered?.has('agent_operator_method') ?? false;
  return [
    {
      id: 'connected-host-lifecycle',
      access: 'gated',
      available,
      operations: ['start', 'stop', 'restart', 'install', 'upgrade', 'expose-listener', 'mutate-listener'],
      reason: 'Lifecycle changes are powerful daemon operations: run them through agent_operator_method on the daemon service method, under a recorded admission, never as a background side effect.',
    },
    {
      id: 'arbitrary-connected-host-mutations',
      access: 'gated',
      available,
      operations: ['route-discovery-mutation', 'account-creation', 'automation-definition-creation'],
      simpleActions: 'agent_operator_action for the allowlisted approval, automation, run and schedule actions',
      reason: 'Other daemon mutations resolve to one documented operator method and carry the call\'s recorded admission.',
    },
  ];
}

/** Things no route reaches from the model, with what to use instead. */
export function blockedConnectedHostCapabilities(): readonly Record<string, unknown>[] {
  return [
    {
      id: 'non-agent-knowledge',
      access: 'blocked',
      blocked: ['default-knowledge', 'non-agent-knowledge-segments', 'fallback-knowledge'],
      useInstead: 'agent_knowledge or agent_knowledge_ingest',
      reason: 'Agent model tools stay inside the isolated Agent Knowledge route family.',
    },
    {
      id: 'hidden-background-work',
      access: 'blocked',
      blocked: ['hidden-agent-jobs', 'implicit-delegated-review', 'untracked-local-schedulers'],
      useInstead: 'agent tool spawn/batch-spawn, schedules, automation jobs, or confirmed delegation with visible status/cancel routes',
      reason: 'Autonomy is allowed when it is visible, statused, and cancellable. Hidden jobs are blocked.',
    },
  ];
}
