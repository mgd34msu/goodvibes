import type { CommunicationEvent, PluginEvent, McpEvent, TransportEvent } from '../events.js';
import type { IntegrationDomainState, IntegrationRecord, IntegrationStatus } from '../../domains/integrations.js';
import type { AutomationDomainState } from '../../domains/automation.js';
import type { RoutesDomainState } from '../../domains/routes.js';
import type { ControlPlaneDomainState, ControlPlaneClientRecord } from '../../domains/control-plane.js';
import type { DeliveryDomainState } from '../../domains/deliveries.js';
import type { WatcherDomainState, WatcherRecord } from '../../domains/watchers.js';
import type { SurfaceDomainState, SurfaceRecord } from '../../domains/surfaces.js';
import type { CommunicationDomainState, RuntimeCommunicationRecord } from '../../domains/communication.js';
import type { PluginDomainState, RuntimePlugin, PluginLifecycleState } from '../../domains/plugins.js';
import type { McpDomainState, McpServerRecord, McpServerLifecycleState } from '../../domains/mcp.js';
import type { AcpDomainState, AcpTransportState } from '../../domains/acp.js';
import type { DaemonDomainState, DaemonTransportState } from '../../domains/daemon.js';
import type { AutomationJob } from '../../../../automation/jobs.js';
import type { AutomationRun } from '../../../../automation/runs.js';
import type { AutomationSourceRecord } from '../../../../automation/sources.js';
import type { AutomationRouteBinding } from '../../../../automation/routes.js';
import type { AutomationSurfaceKind } from '../../../../automation/types.js';
import type { AutomationDeliveryAttempt } from '../../../../automation/delivery.js';
import type { SessionDomainState } from '../../domains/session.js';
import { emptyBindingIdsBySurface } from '../../domains/routes.js';
import { evictOldestEnded, now, uniq, updateDomainMetadata } from './shared.js';
import type { RetiredRunCounts } from '../../domains/automation.js';
import type { RetiredAttemptCounts } from '../../domains/deliveries.js';

export function updateCommunicationState(
  domain: CommunicationDomainState,
  event: CommunicationEvent,
): CommunicationDomainState {
  const timestamp = now();
  const records = new Map(domain.records);
  const base: RuntimeCommunicationRecord | undefined =
    event.type === 'COMMUNICATION_SENT' || event.type === 'COMMUNICATION_BLOCKED'
      ? {
          id: event.messageId,
          fromId: event.fromId,
          toId: event.toId,
          scope: event.scope,
          kind: event.kind,
          content: 'content' in event ? event.content : '',
          timestamp,
          status: event.type === 'COMMUNICATION_BLOCKED' ? 'blocked' : 'sent',
          ...(event.fromRole !== undefined ? { fromRole: event.fromRole } : {}),
          ...(event.toRole !== undefined ? { toRole: event.toRole } : {}),
          ...(event.cohort !== undefined ? { cohort: event.cohort } : {}),
          ...(event.contractId !== undefined ? { contractId: event.contractId } : {}),
          ...(event.parentAgentId !== undefined ? { parentAgentId: event.parentAgentId } : {}),
          ...('reason' in event && event.reason !== undefined ? { reason: event.reason } : {}),
        }
      : undefined;

  if (base) {
    records.set(event.messageId, base);
  } else {
    const existing = records.get(event.messageId);
    if (!existing) return domain;
    records.set(event.messageId, {
      ...existing,
      status: event.type === 'COMMUNICATION_DELIVERED' ? 'delivered' : existing.status,
    });
  }

  const recentRecordIds = uniq([event.messageId, ...domain.recentRecordIds]).slice(0, 200);
  const retainedRecords = new Map<string, RuntimeCommunicationRecord>();
  for (const id of recentRecordIds) {
    const record = records.get(id);
    if (record) retainedRecords.set(id, record);
  }
  return {
    ...updateDomainMetadata(domain, event.type),
    records: retainedRecords,
    recentRecordIds,
    totalSent: domain.totalSent + (event.type === 'COMMUNICATION_SENT' ? 1 : 0),
    totalDelivered: domain.totalDelivered + (event.type === 'COMMUNICATION_DELIVERED' ? 1 : 0),
    totalBlocked: domain.totalBlocked + (event.type === 'COMMUNICATION_BLOCKED' ? 1 : 0),
  };
}

function pluginStatusForEvent(event: PluginEvent): PluginLifecycleState {
  switch (event.type) {
    case 'PLUGIN_DISCOVERED':
      return 'discovered';
    case 'PLUGIN_LOADING':
      return 'loading';
    case 'PLUGIN_LOADED':
      return 'loaded';
    case 'PLUGIN_ACTIVE':
      return 'active';
    case 'PLUGIN_DEGRADED':
      return 'degraded';
    case 'PLUGIN_ERROR':
      return 'error';
    case 'PLUGIN_UNLOADING':
      return 'unloading';
    case 'PLUGIN_DISABLED':
      return 'disabled';
  }
}

export function updatePluginState(domain: PluginDomainState, event: PluginEvent): PluginDomainState {
  const plugins = new Map(domain.plugins);
  const existing = plugins.get(event.pluginId);
  const timestamp = now();
  const plugin: RuntimePlugin =
    existing ??
    {
      name: event.pluginId,
      displayName: event.pluginId,
      version: 'version' in event ? event.version : 'unknown',
      description: 'path' in event ? event.path : '',
      status: pluginStatusForEvent(event),
      enabled: true,
      active: false,
      toolCount: 'capabilities' in event ? event.capabilities.length : 0,
      config: {},
      hookInvocations: 0,
    };
  const next: RuntimePlugin = {
    ...plugin,
    status: pluginStatusForEvent(event),
    version: 'version' in event ? event.version : plugin.version,
    description: 'path' in event ? event.path : plugin.description,
    // `active` follows the status, so a plugin that moves on to error, degraded or unloading is not also listed as active.
    active: event.type === 'PLUGIN_ACTIVE',
    // Any event other than a disable means the plugin is being let run again.
    enabled: event.type !== 'PLUGIN_DISABLED',
    toolCount: 'capabilities' in event ? event.capabilities.length : plugin.toolCount,
    error:
      event.type === 'PLUGIN_ERROR'
        ? event.error
        : event.type === 'PLUGIN_DEGRADED'
          ? event.reason
          : event.type === 'PLUGIN_ACTIVE' || event.type === 'PLUGIN_LOADED'
            ? undefined
            : plugin.error,
    loadedAt: event.type === 'PLUGIN_LOADED' || event.type === 'PLUGIN_ACTIVE' ? timestamp : plugin.loadedAt,
    errorAt: event.type === 'PLUGIN_ERROR' || event.type === 'PLUGIN_DEGRADED' ? timestamp : plugin.errorAt,
  };
  plugins.set(event.pluginId, next);
  const activePluginNames = [...plugins.values()].filter((value) => value.active).map((value) => value.name);
  const erroredPluginNames = [...plugins.values()]
    .filter((value) => value.status === 'error' || value.status === 'degraded')
    .map((value) => value.name);
  return {
    ...updateDomainMetadata(domain, event.type),
    plugins,
    activePluginNames,
    erroredPluginNames,
    totalDiscovered: domain.totalDiscovered + (event.type === 'PLUGIN_DISCOVERED' ? 1 : 0),
    totalActive: activePluginNames.length,
    totalToolsContributed: [...plugins.values()].reduce((sum, value) => sum + (value.active ? value.toolCount : 0), 0),
    initialLoadComplete: domain.initialLoadComplete || event.type === 'PLUGIN_LOADED' || event.type === 'PLUGIN_ACTIVE',
    reloadInProgress: event.type === 'PLUGIN_LOADING' || event.type === 'PLUGIN_UNLOADING',
  };
}

function mcpStatusForEvent(event: McpEvent): McpServerLifecycleState {
  switch (event.type) {
    case 'MCP_CONFIGURED':
      return 'configured';
    case 'MCP_CONNECTING':
      return 'connecting';
    case 'MCP_CONNECTED':
      return 'connected';
    case 'MCP_DEGRADED':
    case 'MCP_SCHEMA_QUARANTINED':
    case 'MCP_SCHEMA_QUARANTINE_APPROVED':
      return 'degraded';
    case 'MCP_AUTH_REQUIRED':
      return 'auth_required';
    case 'MCP_RECONNECTING':
      return 'reconnecting';
    case 'MCP_DISCONNECTED':
      return 'disconnected';
    case 'MCP_POLICY_UPDATED':
      return 'configured';
  }
}

export function updateMcpState(domain: McpDomainState, event: McpEvent): McpDomainState {
  const servers = new Map(domain.servers);
  const existing = servers.get(event.serverId);
  const timestamp = now();
  const server: McpServerRecord =
    existing ??
    {
      name: event.serverId,
      displayName: event.serverId,
      status: mcpStatusForEvent(event),
      transport: event.type === 'MCP_CONFIGURED' && event.transport === 'http' ? 'http' : 'stdio',
      toolCount: 0,
      toolNames: [],
      callCount: 0,
      errorCount: 0,
      reconnectAttempts: 0,
      trustMode:
        event.type === 'MCP_POLICY_UPDATED'
          ? event.trustMode
          : event.type === 'MCP_CONFIGURED'
            ? event.trustMode ?? 'ask-on-risk'
            : 'ask-on-risk',
      role:
        event.type === 'MCP_POLICY_UPDATED'
          ? event.role
          : event.type === 'MCP_CONFIGURED'
            ? event.role ?? 'general'
            : 'general',
      allowedPaths:
        event.type === 'MCP_POLICY_UPDATED'
          ? [...event.allowedPaths]
          : event.type === 'MCP_CONFIGURED'
            ? [...(event.allowedPaths ?? [])]
            : [],
      allowedHosts:
        event.type === 'MCP_POLICY_UPDATED'
          ? [...event.allowedHosts]
          : event.type === 'MCP_CONFIGURED'
            ? [...(event.allowedHosts ?? [])]
            : [],
      schemaFreshness:
        event.type === 'MCP_SCHEMA_QUARANTINED'
          ? 'quarantined'
          : event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
            ? 'stale'
            : 'unknown',
      quarantineReason: event.type === 'MCP_SCHEMA_QUARANTINED' ? event.reason : undefined,
      quarantineDetail: event.type === 'MCP_SCHEMA_QUARANTINED' ? event.detail : undefined,
      quarantineApprovedBy: event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED' ? event.operatorId : undefined,
    };
  servers.set(event.serverId, {
    ...server,
    status:
      event.type === 'MCP_POLICY_UPDATED' ||
      event.type === 'MCP_SCHEMA_QUARANTINED' ||
      event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
        ? server.status
        : mcpStatusForEvent(event),
    transport:
      event.type === 'MCP_CONFIGURED'
        ? event.transport === 'sse' || event.transport === 'http'
          ? event.transport
          : 'stdio'
        : server.transport,
    toolCount: event.type === 'MCP_CONNECTED' ? event.toolCount : server.toolCount,
    connectedAt: event.type === 'MCP_CONNECTED' ? timestamp : server.connectedAt,
    reconnectAttempts: event.type === 'MCP_RECONNECTING' ? event.attempt : server.reconnectAttempts,
    trustMode: event.type === 'MCP_POLICY_UPDATED'
      ? event.trustMode
      : event.type === 'MCP_CONFIGURED'
        ? event.trustMode ?? server.trustMode
        : server.trustMode,
    role: event.type === 'MCP_POLICY_UPDATED'
      ? event.role
      : event.type === 'MCP_CONFIGURED'
        ? event.role ?? server.role
        : server.role,
    allowedPaths: event.type === 'MCP_POLICY_UPDATED'
      ? [...event.allowedPaths]
      : event.type === 'MCP_CONFIGURED'
        ? [...(event.allowedPaths ?? server.allowedPaths)]
        : server.allowedPaths,
    allowedHosts: event.type === 'MCP_POLICY_UPDATED'
      ? [...event.allowedHosts]
      : event.type === 'MCP_CONFIGURED'
        ? [...(event.allowedHosts ?? server.allowedHosts)]
        : server.allowedHosts,
    schemaFreshness:
      event.type === 'MCP_SCHEMA_QUARANTINED'
        ? 'quarantined'
        : event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
          ? 'stale'
          : event.type === 'MCP_CONNECTED'
            ? 'fresh'
            : server.schemaFreshness,
    // An approved or freshly connected schema is no longer quarantined, so its reason goes with it.
    quarantineReason:
      event.type === 'MCP_SCHEMA_QUARANTINED'
        ? event.reason
        : event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED' || event.type === 'MCP_CONNECTED'
          ? undefined
          : server.quarantineReason,
    quarantineDetail:
      event.type === 'MCP_SCHEMA_QUARANTINED'
        ? event.detail
        : event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED' || event.type === 'MCP_CONNECTED'
          ? undefined
          : server.quarantineDetail,
    quarantineApprovedBy:
      event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
        ? event.operatorId
        : server.quarantineApprovedBy,
    lastError:
      event.type === 'MCP_DEGRADED'
        ? event.reason
        : event.type === 'MCP_DISCONNECTED'
          ? event.reason
          : event.type === 'MCP_SCHEMA_QUARANTINED'
            ? event.detail ?? String(event.reason)
            : event.type === 'MCP_CONNECTED'
              ? undefined
              : server.lastError,
  });
  const connectedServerNames = [...servers.values()].filter((value) => value.status === 'connected').map((value) => value.name);
  return {
    ...updateDomainMetadata(domain, event.type),
    servers,
    connectedServerNames,
    availableToolCount: [...servers.values()].reduce((sum, value) => sum + (value.status === 'connected' ? value.toolCount : 0), 0),
    totalErrors:
      domain.totalErrors +
      (event.type === 'MCP_DEGRADED' || event.type === 'MCP_DISCONNECTED' || event.type === 'MCP_SCHEMA_QUARANTINED' ? 1 : 0),
  };
}

/** Returns the transport state for lifecycle events that directly change state, or null for observability-only events. */
function transportStateForEvent(event: TransportEvent): AcpTransportState | DaemonTransportState | null {
  switch (event.type) {
    case 'TRANSPORT_INITIALIZING':
      return 'initializing';
    case 'TRANSPORT_AUTHENTICATING':
      return 'authenticating';
    case 'TRANSPORT_CONNECTED':
      return 'connected';
    case 'TRANSPORT_SYNCING':
      return 'syncing';
    case 'TRANSPORT_DEGRADED':
      return 'degraded';
    case 'TRANSPORT_RECONNECTING':
      return 'reconnecting';
    case 'TRANSPORT_DISCONNECTED':
      return 'disconnected';
    case 'TRANSPORT_TERMINAL_FAILURE':
      return 'terminal_failure';
    // observability-only events, no state change.
    case 'TRANSPORT_RETRY_SCHEDULED':
    case 'TRANSPORT_RETRY_EXECUTED':
    case 'STREAM_SUBSCRIBER_CONNECTED':
    case 'STREAM_SUBSCRIBER_DISCONNECTED':
    // UX-enhancement observability events, no transport state change.
    case 'TRANSPORT_BACKPRESSURE':
    case 'TRANSPORT_CONNECTION_STATE':
    case 'TRANSPORT_RECONNECT_ATTEMPT':
      return null;
  }
}

/**
 * One ACP state for many subagent connections. Failures are reported beside
 * live connections instead of being overwritten by them, and a connection that
 * ends cleanly no longer counts.
 */
function aggregateAcpTransportState(states: ReadonlyMap<string, AcpTransportState>): AcpTransportState {
  const values = [...states.values()];
  if (values.length === 0) return 'disconnected';
  const failed = values.filter((value) => value === 'terminal_failure').length;
  if (failed === values.length) return 'terminal_failure';
  if (failed > 0 || values.includes('degraded')) return 'degraded';
  if (values.includes('reconnecting')) return 'reconnecting';
  if (values.includes('syncing')) return 'syncing';
  if (values.includes('connected')) return 'connected';
  if (values.includes('authenticating')) return 'authenticating';
  return 'initializing';
}

function nextAcpTransportStates(
  current: ReadonlyMap<string, AcpTransportState>,
  transportId: string,
  state: AcpTransportState,
): Map<string, AcpTransportState> {
  const next = new Map(current);
  if (state === 'disconnected') next.delete(transportId);
  else next.set(transportId, state);
  // A failure is kept only while it sits beside live connections, so a
  // finished run does not leave ACP reported as failing indefinitely.
  if (state === 'disconnected' && [...next.values()].every((value) => value === 'terminal_failure')) next.clear();
  return next;
}

export function updateTransportState(
  acp: AcpDomainState,
  daemon: DaemonDomainState,
  event: TransportEvent,
): Pick<import('../../state.js').RuntimeState, 'acp' | 'daemon'> {
  const nextTransportState = transportStateForEvent(event);
  // observability-only events have no transportId and no state to update.
  if (nextTransportState === null) return { acp, daemon };
  const transportId = 'transportId' in event ? event.transportId : '';
  // Transport ids are namespaced by their owner (`acp:<id>`, `daemon:<scheme>:<host>:<port>`).
  // A transport owned by neither is not the daemon's, so it must not flip the daemon's state.
  const isAcp = transportId.startsWith('acp:');
  const isDaemon = transportId.startsWith('daemon:');
  if (!isAcp && !isDaemon) return { acp, daemon };
  const transportStates = isAcp
    ? nextAcpTransportStates(acp.transportStates, transportId, nextTransportState as AcpTransportState)
    : acp.transportStates;
  const nextAcp = isAcp
    ? {
        ...updateDomainMetadata(acp, event.type),
        transportStates,
        managerTransportState: aggregateAcpTransportState(transportStates),
        initialized: acp.initialized || event.type === 'TRANSPORT_INITIALIZING',
      }
    : acp;
  const nextDaemon = isDaemon
    ? {
        ...updateDomainMetadata(daemon, event.type),
        transportState: nextTransportState as DaemonTransportState,
        isRunning:
          event.type === 'TRANSPORT_CONNECTED'
            ? true
            : event.type === 'TRANSPORT_DISCONNECTED' || event.type === 'TRANSPORT_TERMINAL_FAILURE'
              ? false
              : daemon.isRunning,
        reconnectAttempts: event.type === 'TRANSPORT_RECONNECTING' ? event.attempt : daemon.reconnectAttempts,
        lastConnectedAt: event.type === 'TRANSPORT_CONNECTED' ? now() : daemon.lastConnectedAt,
        lastError:
          event.type === 'TRANSPORT_DEGRADED'
            ? event.reason
            : event.type === 'TRANSPORT_DISCONNECTED'
              ? event.reason
              : event.type === 'TRANSPORT_TERMINAL_FAILURE'
                ? event.error
                : daemon.lastError,
      }
    : daemon;
  return { acp: nextAcp, daemon: nextDaemon };
}

export function updateIntegrationDomainFromRecord(domain: IntegrationDomainState, record: IntegrationRecord, source: string): IntegrationDomainState {
  const integrations = new Map(domain.integrations);
  const previous = integrations.get(record.id);
  integrations.set(record.id, record);
  const problemStatuses: IntegrationStatus[] = ['degraded', 'error'];
  const healthyIds = [...integrations.values()].filter((value) => value.status === 'healthy').map((value) => value.id);
  const problemIds = [...integrations.values()].filter((value) => problemStatuses.includes(value.status)).map((value) => value.id);
  return {
    ...updateDomainMetadata(domain, source),
    integrations,
    healthyIds,
    problemIds,
    totalOperations: domain.totalOperations + ((record.successCount ?? 0) - (previous?.successCount ?? 0)),
    totalErrors: domain.totalErrors + ((record.errorCount ?? 0) - (previous?.errorCount ?? 0)),
  };
}

export function updateAutomationDomainFromSource(domain: AutomationDomainState, sourceRecord: AutomationSourceRecord, source: string): AutomationDomainState {
  const sources = new Map(domain.sources);
  sources.set(sourceRecord.id, sourceRecord);
  const sourceIds = [...sources.values()].sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt).map((record) => record.id);
  return { ...updateDomainMetadata(domain, source), sources, sourceIds };
}

const ENDED_RUN_STATUSES: ReadonlySet<AutomationRun['status']> = new Set(['completed', 'failed', 'cancelled', 'missed']);

function deadLetteredIn(run: AutomationRun): number {
  return run.deliveryAttempts?.filter((attempt) => attempt.status === 'dead_lettered').length ?? 0;
}

function addRetiredRuns(current: RetiredRunCounts | undefined, dropped: readonly AutomationRun[]): RetiredRunCounts {
  const base = current ?? { runs: 0, succeeded: 0, failed: 0, cancelled: 0, deadLettered: 0 };
  return {
    runs: base.runs + dropped.length,
    succeeded: base.succeeded + dropped.filter((run) => run.status === 'completed').length,
    failed: base.failed + dropped.filter((run) => run.status === 'failed').length,
    cancelled: base.cancelled + dropped.filter((run) => run.status === 'cancelled').length,
    deadLettered: base.deadLettered + dropped.reduce((count, run) => count + deadLetteredIn(run), 0),
  };
}

/** Run totals over the retained runs plus what bounded eviction already counted. */
function runTotals(runs: readonly AutomationRun[], retired: RetiredRunCounts | undefined) {
  return {
    totalRuns: runs.length + (retired?.runs ?? 0),
    totalSucceeded: runs.filter((run) => run.status === 'completed').length + (retired?.succeeded ?? 0),
    totalFailed: runs.filter((run) => run.status === 'failed').length + (retired?.failed ?? 0),
    totalCancelled: runs.filter((run) => run.status === 'cancelled').length + (retired?.cancelled ?? 0),
    totalDeadLettered: runs.reduce((count, run) => count + deadLetteredIn(run), 0) + (retired?.deadLettered ?? 0),
  };
}

export function updateAutomationDomainFromJob(domain: AutomationDomainState, job: AutomationJob, source: string): AutomationDomainState {
  const jobs = new Map(domain.jobs);
  const sources = new Map(domain.sources);
  jobs.set(job.id, job);
  sources.set(job.source.id, job.source);
  const allRuns = [...domain.runs.values()];
  const totals = runTotals(allRuns, domain.retiredRuns);
  return {
    ...updateDomainMetadata(domain, source),
    jobs,
    jobIds: [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt).map((record) => record.id),
    sources,
    sourceIds: [...sources.values()].sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt).map((record) => record.id),
    totalJobs: jobs.size,
    ...totals,
  };
}

export function updateAutomationDomainFromRun(domain: AutomationDomainState, run: AutomationRun, source: string): AutomationDomainState {
  const runs = new Map(domain.runs);
  const sources = new Map(domain.sources);
  runs.set(run.id, run);
  sources.set(run.triggeredBy.id, run.triggeredBy);
  const dropped = evictOldestEnded(runs, (record) => ENDED_RUN_STATUSES.has(record.status), (record) => record.endedAt ?? record.queuedAt);
  const retiredRuns = dropped.length > 0 ? addRetiredRuns(domain.retiredRuns, dropped) : domain.retiredRuns;
  const allRuns = [...runs.values()];
  const totals = runTotals(allRuns, retiredRuns);
  return {
    ...updateDomainMetadata(domain, source),
    runs,
    runIds: allRuns.sort((a, b) => b.queuedAt - a.queuedAt || a.id.localeCompare(b.id)).map((record) => record.id),
    activeRunIds: allRuns.filter((record) => record.status === 'queued' || record.status === 'running').map((record) => record.id),
    failedRunIds: allRuns.filter((record) => record.status === 'failed').map((record) => record.id),
    sources,
    sourceIds: [...sources.values()].sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt).map((record) => record.id),
    totalJobs: domain.jobs.size,
    ...totals,
    ...(retiredRuns ? { retiredRuns } : {}),
  };
}

function buildBindingIdsBySurface(bindings: readonly AutomationRouteBinding[]): Readonly<Record<string, readonly string[]>> {
  const grouped = emptyBindingIdsBySurface();
  for (const binding of bindings) {
    grouped[binding.surfaceKind] ??= [];
    grouped[binding.surfaceKind]?.push(binding.id);
  }
  return grouped;
}

export function updateRoutesDomainFromBinding(domain: RoutesDomainState, binding: AutomationRouteBinding, source: string): RoutesDomainState {
  const bindings = new Map(domain.bindings);
  bindings.set(binding.id, binding);
  return routesDomainFromBindings(domain, bindings, source);
}

/** A removed binding leaves the mirror; an unknown id returns the domain unchanged. */
export function removeRoutesDomainBinding(domain: RoutesDomainState, bindingId: string, source: string): RoutesDomainState {
  if (!domain.bindings.has(bindingId)) return domain;
  const bindings = new Map(domain.bindings);
  bindings.delete(bindingId);
  return routesDomainFromBindings(domain, bindings, source);
}

function routesDomainFromBindings(domain: RoutesDomainState, bindings: Map<string, AutomationRouteBinding>, source: string): RoutesDomainState {
  const records = [...bindings.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
  return {
    ...updateDomainMetadata(domain, source),
    bindings,
    bindingIds: records.map((record) => record.id),
    bindingIdsBySurface: buildBindingIdsBySurface(records),
    activeBindingIds: records.map((record) => record.id),
    recentBindingIds: records.slice(0, 20).map((record) => record.id),
    totalBindings: records.length,
    totalResolved: records.filter((record) => record.sessionId || record.jobId || record.runId).length,
  };
}

export function updateRouteFailureState(domain: RoutesDomainState, _surfaceKind: AutomationSurfaceKind, _externalId: string, source: string): RoutesDomainState {
  return { ...updateDomainMetadata(domain, source), totalFailures: domain.totalFailures + 1 };
}

export function updateControlPlaneDomainFromClient(domain: ControlPlaneDomainState, client: ControlPlaneClientRecord, source: string): ControlPlaneDomainState {
  const clients = new Map(domain.clients);
  const previous = clients.get(client.id);
  clients.set(client.id, client);
  // Connection counters are cumulative, so dropping long-gone disconnected clients loses no total.
  evictOldestEnded(clients, (record) => !record.connected, (record) => record.lastSeenAt ?? 0);
  const records = [...clients.values()].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id));
  const active = records.filter((record) => record.connected);
  return {
    ...updateDomainMetadata(domain, source),
    clients,
    activeClients: new Map(active.map((record) => [record.id, record])),
    clientIds: records.map((record) => record.id),
    activeClientIds: active.map((record) => record.id),
    isRunning: domain.isRunning || active.length > 0,
    connectionState: active.length > 0 ? 'connected' : domain.isRunning ? 'disconnected' : domain.connectionState,
    totalConnections: domain.totalConnections + (client.connected && !previous?.connected ? 1 : 0),
    totalDisconnects: domain.totalDisconnects + (!client.connected && previous?.connected ? 1 : 0),
  };
}

export function patchControlPlaneDomain(domain: ControlPlaneDomainState, patch: Partial<ControlPlaneDomainState>, source: string): ControlPlaneDomainState {
  return {
    ...updateDomainMetadata(domain, source),
    ...patch,
    totalFailures: patch.connectionState === 'terminal_failure' ? domain.totalFailures + 1 : patch.totalFailures ?? domain.totalFailures,
  };
}

function addRetiredAttempts(current: RetiredAttemptCounts | undefined, dropped: readonly AutomationDeliveryAttempt[]): RetiredAttemptCounts {
  const base = current ?? { queued: 0, started: 0, succeeded: 0, deadLettered: 0 };
  return {
    queued: base.queued + dropped.length,
    started: base.started + dropped.filter((record) => record.startedAt !== undefined || record.status !== 'pending').length,
    succeeded: base.succeeded + dropped.filter((record) => record.status === 'sent').length,
    deadLettered: base.deadLettered + dropped.filter((record) => record.status === 'dead_lettered').length,
  };
}

export function updateDeliveryDomainFromAttempt(domain: DeliveryDomainState, attempt: AutomationDeliveryAttempt, source: string): DeliveryDomainState {
  const deliveryAttempts = new Map(domain.deliveryAttempts);
  deliveryAttempts.set(attempt.id, attempt);
  // Only attempts that reached their end are dropped; a failed one may still be retried.
  const dropped = evictOldestEnded(deliveryAttempts, (record) => record.status === 'sent' || record.status === 'dead_lettered', (record) => record.endedAt ?? record.startedAt ?? 0);
  const retired = dropped.length > 0 ? addRetiredAttempts(domain.retiredAttempts, dropped) : domain.retiredAttempts;
  const attempts = [...deliveryAttempts.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.id.localeCompare(b.id));
  return {
    ...updateDomainMetadata(domain, source),
    deliveryAttempts,
    attemptIds: attempts.map((record) => record.id),
    pendingAttemptIds: attempts.filter((record) => record.status === 'pending' || record.status === 'sending').map((record) => record.id),
    failedAttemptIds: attempts.filter((record) => record.status === 'failed').map((record) => record.id),
    deadLetterIds: attempts.filter((record) => record.status === 'dead_lettered').map((record) => record.id),
    totalQueued: attempts.length + (retired?.queued ?? 0),
    totalStarted: attempts.filter((record) => record.startedAt !== undefined || record.status !== 'pending').length + (retired?.started ?? 0),
    totalSucceeded: attempts.filter((record) => record.status === 'sent').length + (retired?.succeeded ?? 0),
    totalFailed: attempts.filter((record) => record.status === 'failed').length,
    totalDeadLettered: attempts.filter((record) => record.status === 'dead_lettered').length + (retired?.deadLettered ?? 0),
    ...(retired ? { retiredAttempts: retired } : {}),
  };
}

export function updateSurfaceDomainFromRecord(domain: SurfaceDomainState, record: SurfaceRecord, source: string): SurfaceDomainState {
  const surfaces = new Map(domain.surfaces);
  surfaces.set(record.id, record);
  const records = [...surfaces.values()].sort((a, b) => a.label.localeCompare(b.label) || a.configuredAt - b.configuredAt);
  return {
    ...updateDomainMetadata(domain, source),
    surfaces,
    surfaceIds: records.map((entry) => entry.id),
    enabledSurfaceIds: records.filter((entry) => entry.enabled).map((entry) => entry.id),
    problemSurfaceIds: records.filter((entry) => entry.state === 'degraded' || entry.state === 'error').map((entry) => entry.id),
    // A disabled surface is counted as disabled only, never also as healthy.
    totalHealthy: records.filter((entry) => entry.enabled && entry.state === 'healthy').length,
    totalDegraded: records.filter((entry) => entry.state === 'degraded' || entry.state === 'error').length,
    totalDisabled: records.filter((entry) => !entry.enabled || entry.state === 'disabled').length,
  };
}

export function updateWatcherDomainFromRecord(domain: WatcherDomainState, record: WatcherRecord, source: string): WatcherDomainState {
  const watchers = new Map(domain.watchers);
  watchers.set(record.id, record);
  return watcherDomainFromRecords(domain, watchers, source);
}

/** A removed watcher leaves the mirror; an unknown id returns the domain unchanged. */
export function removeWatcherDomainRecord(domain: WatcherDomainState, watcherId: string, source: string): WatcherDomainState {
  if (!domain.watchers.has(watcherId)) return domain;
  const watchers = new Map(domain.watchers);
  watchers.delete(watcherId);
  return watcherDomainFromRecords(domain, watchers, source);
}

function watcherDomainFromRecords(domain: WatcherDomainState, watchers: Map<string, WatcherRecord>, source: string): WatcherDomainState {
  const records = [...watchers.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return {
    ...updateDomainMetadata(domain, source),
    watchers,
    watcherIds: records.map((entry) => entry.id),
    activeWatcherIds: records.filter((entry) => entry.state === 'running' || entry.state === 'starting' || entry.state === 'degraded').map((entry) => entry.id),
    failedWatcherIds: records.filter((entry) => entry.state === 'failed').map((entry) => entry.id),
    totalStarted: records.filter((entry) => entry.state === 'running' || entry.state === 'starting').length,
    totalStopped: records.filter((entry) => entry.state === 'stopped').length,
    totalFailed: records.filter((entry) => entry.state === 'failed').length,
    totalHeartbeats: records.filter((entry) => entry.lastHeartbeatAt !== undefined).length,
    totalDegraded: records.filter((entry) => entry.state === 'degraded' || entry.sourceStatus === 'degraded').length,
    totalLagged: records.filter((entry) => entry.sourceStatus === 'lagging' || entry.sourceStatus === 'stale').length,
  };
}

export function syncSessionStatePatch(domain: SessionDomainState, patch: Partial<SessionDomainState>, source: string): SessionDomainState {
  return { ...updateDomainMetadata(domain, source), ...patch };
}
