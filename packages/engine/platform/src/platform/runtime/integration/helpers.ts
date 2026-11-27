import type { PanelManagerLike } from '../host-ui.js';
import type { ConfigManager } from '../../config/index.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { SubscriptionManager } from '../../config/subscriptions.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { AutomationManager } from '../../automation/index.js';
import type { ApprovalBroker, SharedSessionBroker } from '../../control-plane/index.js';
import type { DistributedRuntimeManager } from '../remote/distributed-runtime.js';
import type { RemoteRunnerRegistry } from '../remote/runner-registry.js';
import type { RemoteSupervisor } from '../remote/supervisor.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { RuntimeStore } from '../store/index.js';
import type { RuntimeEventBus } from '../events/index.js';
import { BUILTIN_GATEWAY_METHODS } from '../../control-plane/method-catalog.js';
import { isOpenApprovalStatus } from '../../control-plane/approval-lifecycle.js';
import { buildProviderAccountSnapshot } from '../provider-accounts/registry.js';
import type { ProviderAccountSnapshot } from '../provider-accounts/registry.js';
import type { UserAuthManager } from '../../security/user-auth.js';
import { getSettingsControlPlaneSnapshot } from '../settings/control-plane.js';
import {
  checkRecoveryFile,
  readLastSessionPointer,
  type RecoveryFileInfo,
  type SessionPersistenceOptions,
} from '../session-persistence.js';
import type { SessionSurface } from '../session-surface.js';
import { listPersistedWorktreeMeta, summarizeWorktreeOwnership, type ManagedWorktreeMeta, type WorktreeOwnershipSummary } from '../worktree/registry.js';
import { inspectInboundTls, inspectOutboundTls } from '../network/index.js';
import type { ManagedRollbackRecord, SettingsConflictRecord, StagedManagedBundle } from '../settings/control-plane-store.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';
import { getSecuritySettingsReport, type SecuritySettingReport } from '../security-settings.js';
import { readIntelligenceSnapshot } from '../ui-read-models-observability-system.js';
import { effectivePermissionMode } from '../../gate/presets.js';
import { describePermissionModeInForce } from '../../permissions/decision-model-readiness.js';
import { currentRecordReach, keepReachable, keepReachableNaming } from '@goodvibes/engine/daemon-api';

/** The records a route binding names, by kind (its session, its schedule, its run). */
const BINDING_RECORDS: readonly (readonly [string, (binding: { readonly sessionId?: string | undefined; readonly jobId?: string | undefined; readonly runId?: string | undefined }) => string | undefined])[] = [
  ['session', (binding) => binding.sessionId],
  ['schedule', (binding) => binding.jobId],
  ['schedule-run', (binding) => binding.runId],
];

/**
 * The HTTP routes the daemon serves, read from the method catalog that serves
 * them, and the families they fall in: one source, so a route added to the
 * catalog is in the review the moment it is served. Built once per process.
 */
let catalogReviewCache: { readonly apiFamilies: readonly string[]; readonly routes: readonly string[] } | undefined;
function catalogReview(): { readonly apiFamilies: readonly string[]; readonly routes: readonly string[] } {
  if (catalogReviewCache) return catalogReviewCache;
  const served = BUILTIN_GATEWAY_METHODS.filter((method) => method.http !== undefined);
  catalogReviewCache = Object.freeze({
    apiFamilies: Object.freeze([...new Set(served.map((method) => method.category))].sort()),
    routes: Object.freeze([...new Set(served.map((method) => `${method.http!.method} ${method.http!.path}`))]),
  });
  return catalogReviewCache;
}

/**
 * Everything the service needs that is NOT about where files live. The storage
 * scope is bolted on separately below, because it comes in two mutually
 * exclusive shapes.
 */
export interface IntegrationHelpersServices {
  readonly runtimeStore: RuntimeStore;
  readonly runtimeBus: RuntimeEventBus;
  readonly configManager?: ConfigManager | undefined;
  readonly featureFlags?: FeatureFlagManager | undefined;
  readonly getConversationTitle?: (() => string | undefined) | undefined;
  readonly automationManager: AutomationManager;
  readonly approvalBroker: ApprovalBroker;
  readonly sessionBroker: SharedSessionBroker;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly panelManager: PanelManagerLike;
  readonly localUserAuthManager: UserAuthManager;
  readonly providerRegistry: ProviderRegistry;
  readonly serviceRegistry: ServiceRegistry;
  readonly subscriptionManager: SubscriptionManager;
  readonly secretsManager: SecretsManager;
}

/**
 * The service's storage scope: a declare-once `SessionSurface`. Every
 * persistence read this service performs resolves through the SAME
 * surface-scoped paths the product writes with.
 */
export interface IntegrationHelpersSurfaceScope {
  readonly surface: SessionSurface;
}

export type IntegrationHelpersContext = IntegrationHelpersServices & IntegrationHelpersSurfaceScope;

export interface PanelSnapshot {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly open: boolean;
}

export interface SettingsSnapshotUnavailable {
  readonly available: false;
  readonly reason: string;
}

export interface SettingsSnapshotAvailable {
  readonly available: true;
  readonly liveKeyCount: number;
  readonly profileCount: number;
  readonly managedLockCount: number;
  readonly resolvedCounts: Readonly<Record<string, number>>;
  readonly conflicts: readonly SettingsConflictRecord[];
  readonly recentFailures: readonly { readonly surface: string; readonly message: string; readonly timestamp: number }[];
  readonly stagedManagedBundle?: StagedManagedBundle | undefined;
  readonly rollbackHistory: readonly ManagedRollbackRecord[];
}

export type SettingsSnapshot = SettingsSnapshotUnavailable | SettingsSnapshotAvailable;

export interface ContinuitySnapshot {
  readonly sessionId: string;
  readonly status: string;
  readonly recoveryState: string;
  readonly lastSessionPointer: string | null;
  /**
   * Whether a crash snapshot would be OFFERED right now, `checkRecoveryFile`'s
   * answer, not a bare `existsSync`. A snapshot a live process is still
   * rewriting, or one its own session already superseded with a clean save,
   * reports false while its file sits on disk. That is the question worth
   * asking here; "a file exists somewhere" is not.
   */
  readonly recoveryFilePresent: boolean;
  readonly recoveryFile: RecoveryFileInfo | null;
}

export interface WorktreeSnapshot {
  readonly summary: WorktreeOwnershipSummary;
  readonly records: readonly ManagedWorktreeMeta[];
}

/** Approvals raised and not yet decided, cancelled or expired. */
function countUndecidedApprovals(approvals: readonly { readonly status: string }[]): number {
  return approvals.filter((approval) => isOpenApprovalStatus(approval.status)).length;
}

export class IntegrationHelperService {
  constructor(private readonly context: IntegrationHelpersContext) {}

  getRuntimeStore(): RuntimeStore {
    return this.context.runtimeStore;
  }

  getContext(): IntegrationHelpersContext {
    return this.context;
  }

  /** The scope every session-persistence call in this service passes along: the construction-time surface. */
  private persistenceOptions(): SessionPersistenceOptions {
    return { surface: this.context.surface };
  }

  /** The project root, carried by the surface. */
  private projectWorkingDirectory(): string {
    return this.context.surface.workingDirectory;
  }

  buildReview(): {
    readonly apiFamilies: readonly string[];
    readonly routes: readonly string[];
    readonly sessions: number;
    readonly tasks: number;
    readonly pendingApprovals: number;
    readonly remoteContracts: number;
    readonly panels: number;
  } {
    const state = this.context.runtimeStore.getState();
    const panelSnapshots = this.listPanels();
    const { apiFamilies, routes } = catalogReview();
    return {
      apiFamilies,
      routes,
      // Open shared sessions the session broker holds, not whether this process has one.
      sessions: this.context.sessionBroker.listSessions(Number.MAX_SAFE_INTEGER, { includeClosed: false }).length,
      tasks: state.tasks.tasks.size,
      pendingApprovals: countUndecidedApprovals(this.context.approvalBroker.listApprovals(Number.MAX_SAFE_INTEGER)),
      remoteContracts: this.context.remoteRunnerRegistry.listContracts().length,
      panels: panelSnapshots.length,
    };
  }

  getSessionSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    return {
      id: state.session.id,
      conversationSessionId: state.session.conversationSessionId,
      title: this.context.getConversationTitle?.() ?? '',
      status: state.session.status,
      recoveryState: state.session.recoveryState,
      projectRoot: state.session.projectRoot,
      isResumed: state.session.isResumed,
      resumedFromId: state.session.resumedFromId,
      compactionState: state.session.compactionState,
      lastCompactedAt: state.session.lastCompactedAt,
      lineage: state.session.lineage,
    };
  }

  /** `limit` keeps the newest tasks only, so a long-lived daemon does not send its whole history; the totals stay whole. */
  getTaskSnapshot(limit?: number): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    // A caller that is not the owner himself is listed and counted only the tasks it may reach (control-plane/caller-reach.ts),
    // before the newest `limit` are cut: the counts say no more than the list does.
    const reachable = currentRecordReach() !== undefined;
    const all = [...keepReachable([...state.tasks.tasks.values()], 'task', (task) => task.id)];
    const counted = (status: string): number => all.filter((task) => task.status === status).length;
    return {
      queued: reachable ? counted('queued') : state.tasks.queuedIds.length,
      running: reachable ? counted('running') : state.tasks.runningIds.length,
      blocked: reachable ? counted('blocked') : state.tasks.blockedIds.length,
      totals: reachable ? {
        created: all.length,
        completed: counted('completed'),
        failed: counted('failed'),
        cancelled: counted('cancelled'),
      } : {
        created: state.tasks.totalCreated,
        completed: state.tasks.totalCompleted,
        failed: state.tasks.totalFailed,
        cancelled: state.tasks.totalCancelled,
      },
      tasks: (limit === undefined ? all : all.slice(-Math.max(1, limit))).map((task) => ({
        id: task.id,
        kind: task.kind,
        title: task.title,
        description: task.description,
        status: task.status,
        owner: task.owner,
        // A client rebuilds a RuntimeTask from these rows; without them a task
        // panel cannot tell whether to offer cancel or list the child tasks.
        cancellable: task.cancellable,
        parentTaskId: task.parentTaskId,
        childTaskIds: [...task.childTaskIds],
        queuedAt: task.queuedAt,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        error: task.error,
      })),
    };
  }

  getAutomationSnapshot(): Record<string, unknown> {
    const jobs = this.context.automationManager.listJobs();
    const runs = this.context.automationManager.listRuns().slice(0, 50);
    return {
      totals: {
        jobs: jobs.length,
        enabled: jobs.filter((job) => job.enabled).length,
        paused: jobs.filter((job) => !job.enabled).length,
        runs: runs.length,
      },
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        status: job.status,
        schedule: job.schedule,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        runCount: job.runCount,
        failureCount: job.failureCount,
      })),
      recentRuns: runs.map((run) => ({
        id: run.id,
        jobId: run.jobId,
        status: run.status,
        trigger: run.triggeredBy.kind,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        agentId: run.agentId,
        error: run.error,
      })),
    };
  }

  getRouteSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    // A binding is of the session, schedule and run it names: a caller that is not the owner himself is shown and
    // counted only those it may reach every one of (control-plane/caller-reach.ts).
    const kept = keepReachableNaming([...state.routes.bindings.values()], BINDING_RECORDS);
    const counted = currentRecordReach() !== undefined;
    const keptIds = new Set(kept.map((binding) => binding.id));
    return {
      totalBindings: counted ? kept.length : state.routes.bindingIds.length,
      activeBindings: counted ? state.routes.activeBindingIds.filter((id) => keptIds.has(id)).length : state.routes.activeBindingIds.length,
      recentBindings: counted ? state.routes.recentBindingIds.filter((id) => keptIds.has(id)).length : state.routes.recentBindingIds.length,
      bindings: kept.map((binding) => ({
        id: binding.id,
        kind: binding.kind,
        surfaceKind: binding.surfaceKind,
        surfaceId: binding.surfaceId,
        externalId: binding.externalId,
        threadId: binding.threadId,
        channelId: binding.channelId,
        sessionId: binding.sessionId,
        jobId: binding.jobId,
        runId: binding.runId,
        lastSeenAt: binding.lastSeenAt,
      })),
    };
  }

  getApprovalSnapshot(approvalId?: string): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    // One named record is returned whatever its rank, so a reader following a
    // single ask is not blind to it once newer asks push it past the first 50.
    const approvals = approvalId === undefined
      ? this.context.approvalBroker.listApprovals(50)
      : [this.context.approvalBroker.getApproval(approvalId)].filter((record) => record !== null);
    return {
      // The gate reports a request only after its decision, so the store flag
      // never reads true while a prompt is open; the broker holds it until decided.
      // Of the questions the caller may reach (control-plane/caller-reach.ts): another project's waiting ask is not said.
      awaitingDecision: countUndecidedApprovals([...keepReachable(this.context.approvalBroker.listApprovals(Number.MAX_SAFE_INTEGER), 'approval', (record) => record.id)]) > 0,
      // The mode in force, read the way the gate reads it (jev-decides is ask-me while no decision model works).
      mode: this.context.configManager ? describePermissionModeInForce(this.context.configManager).mode : effectivePermissionMode(undefined),
      lastDecision: state.permissions.lastDecision,
      approvalCount: state.permissions.approvalCount,
      denialCount: state.permissions.denialCount,
      promptCount: state.permissions.promptCount,
      totalChecks: state.permissions.totalChecks,
      approvals,
    };
  }

  /** The newest sessions; `readable` keeps only those the caller may read (a hosted one: its owners and admins). */
  getSessionBrokerSnapshot(readable?: (session: { readonly id: string; readonly kind: string }) => boolean): Record<string, unknown> {
    // A caller that is not the owner himself: only the sessions it may reach and read, before the newest 50 are cut
    // (control-plane/caller-reach.ts); the entries this build could not read are the owner's to repair.
    const reachable = currentRecordReach() !== undefined;
    const listed = reachable || readable ? this.context.sessionBroker.listSessions(Number.MAX_SAFE_INTEGER) : this.context.sessionBroker.listSessions(50);
    const sessions = keepReachable(readable ? listed.filter((session) => readable(session)) : listed, 'session', (session) => session.id).slice(0, 50);
    const unreadable = reachable ? [] : this.context.sessionBroker.unreadableEntries();
    return {
      totals: {
        sessions: sessions.length,
        active: sessions.filter((session) => session.status === 'active').length,
        closed: sessions.filter((session) => session.status === 'closed').length,
      },
      sessions,
      // Named here, not only in the log, so an operator or agent reading the list learns which entries to repair.
      ...(unreadable.length > 0 ? { unreadable } : {}),
    };
  }

  getDeliverySnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    // A delivery is its schedule run's: a caller that is not the owner himself is listed and counted only the
    // deliveries of runs it may reach (control-plane/caller-reach.ts), before the newest 100 are cut.
    const reachable = currentRecordReach() !== undefined;
    const kept = keepReachable([...state.deliveries.deliveryAttempts.values()], 'schedule-run', (attempt) => attempt.runId);
    const attempts = [...kept]
      .sort((a, b) => (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0))
      .slice(0, 100);
    if (reachable) {
      const status = (value: string): number => kept.filter((attempt) => attempt.status === value).length;
      return {
        totals: { queued: kept.length, started: kept.filter((attempt) => attempt.startedAt !== undefined).length,
          succeeded: status('sent'), failed: status('failed'), deadLettered: status('dead_lettered') },
        attempts,
      };
    }
    return {
      totals: {
        queued: state.deliveries.totalQueued,
        started: state.deliveries.totalStarted,
        succeeded: state.deliveries.totalSucceeded,
        failed: state.deliveries.totalFailed,
        deadLettered: state.deliveries.totalDeadLettered,
      },
      attempts,
    };
  }

  getRemoteSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    const remoteRegistry = this.context.remoteRunnerRegistry;
    const supervisor = this.context.remoteSupervisor.getSnapshot(this.context.runtimeStore);
    const contracts = remoteRegistry.listContracts();
    const pools = remoteRegistry.listPools();
    const artifacts = remoteRegistry.listArtifacts();
    const acpLastError = [...state.acp.connections.values()].find((connection) => connection.lastError)?.lastError;
    return {
      daemon: {
        transportState: state.daemon.transportState,
        isRunning: state.daemon.isRunning,
        // Automation runs queued or running in this process: the live count of jobs at work.
        runningJobCount: state.automation.activeRunIds.length,
        ...(state.daemon.lastError ? { lastError: state.daemon.lastError } : {}),
      },
      acp: {
        transportState: state.acp.managerTransportState,
        activeConnectionIds: state.acp.activeConnectionIds,
        totalSpawned: state.acp.totalSpawned,
        totalFailed: state.acp.totalFailed,
        ...(acpLastError ? { lastError: acpLastError } : {}),
      },
      registry: {
        pools: pools.length,
        contracts: contracts.length,
        artifacts: artifacts.length,
        poolEntries: pools.map((pool) => ({
          id: pool.id,
          label: pool.label,
          trustClass: pool.trustClass,
          preferredTemplate: pool.preferredTemplate,
          maxRunners: pool.maxRunners,
          runnerIds: pool.runnerIds,
        })),
        contractEntries: contracts.map((contract) => ({
          id: contract.id,
          runnerId: contract.runnerId,
          label: contract.label,
          template: contract.template,
          ...(contract.poolId ? { poolId: contract.poolId } : {}),
          ...(contract.taskId ? { taskId: contract.taskId } : {}),
          sourceTransport: contract.sourceTransport,
          trustClass: contract.trustClass,
          executionProtocol: contract.capabilityCeiling.executionProtocol,
          reviewMode: contract.capabilityCeiling.reviewMode,
          communicationLane: contract.capabilityCeiling.communicationLane,
          // A local runner (sub-agent or graph node in this process) has no transport.
          transportState: contract.transport?.state ?? 'local',
          ...(contract.transport?.lastError ? { lastError: contract.transport.lastError } : {}),
        })),
        artifactEntries: artifacts.map((artifact) => ({
          id: artifact.id,
          runnerId: artifact.runnerId,
          createdAt: artifact.createdAt,
          status: artifact.task.status,
          summary: artifact.task.summary,
          ...(artifact.task.error ? { error: artifact.task.error } : {}),
        })),
      },
      supervisor: {
        sessions: supervisor.sessions.length,
        degraded: supervisor.degradedConnections,
        capturedAt: supervisor.capturedAt,
        entries: supervisor.sessions.map((entry) => ({
          runnerId: entry.runnerId,
          label: entry.label,
          transportState: entry.transportState,
          heartbeat: entry.heartbeat.status,
          ...(entry.taskId ? { taskId: entry.taskId } : {}),
        })),
      },
      distributed: {
        pairRequests: this.context.distributedRuntime.listPairRequests(100),
        peers: this.context.distributedRuntime.listPeers(undefined, 500),
        work: this.context.distributedRuntime.listWork(500),
        audit: this.context.distributedRuntime.listAudit(100),
      },
    };
  }

  getHealthSnapshot(): Record<string, unknown> {
    const state = this.context.runtimeStore.getState();
    const degradedDomains: string[] = [];
    const providerProblems = [...this.context.providerRegistry.health().keys()];
    const degradedMcpServers = [...state.mcp.servers.values()]
      .filter((server) => server.status === 'degraded' || server.status === 'auth_required' || server.schemaFreshness === 'quarantined')
      .map((server) => server.name);
    const quarantinedServers = [...state.mcp.servers.values()]
      .filter((server) => server.schemaFreshness === 'quarantined')
      .map((server) => server.name);
    if (providerProblems.length > 0) degradedDomains.push('providerHealth');
    if (degradedMcpServers.length > 0) degradedDomains.push('mcp');
    if (state.integrations.problemIds.length > 0) degradedDomains.push('integrations');
    if (state.daemon.transportState === 'degraded' || state.daemon.transportState === 'terminal_failure') degradedDomains.push('daemon');
    if (state.acp.managerTransportState === 'degraded' || state.acp.managerTransportState === 'terminal_failure') degradedDomains.push('acp');
    if (state.session.recoveryState === 'failed') degradedDomains.push('session');
    return {
      overall: degradedDomains.length > 0 ? 'degraded' : 'healthy',
      degradedDomains,
      providerProblems,
      mcpProblems: {
        degraded: degradedMcpServers,
        quarantined: quarantinedServers,
      },
      integrationProblems: state.integrations.problemIds,
      ...(this.context.configManager ? {
        network: {
          controlPlane: inspectInboundTls(this.context.configManager, 'controlPlane'),
          httpListener: inspectInboundTls(this.context.configManager, 'httpListener'),
          outbound: inspectOutboundTls(this.context.configManager),
        },
      } : {}),
    };
  }

  async getAccountsSnapshot(): Promise<ProviderAccountSnapshot> {
    return await buildProviderAccountSnapshot({
      providerRegistry: this.context.providerRegistry,
      serviceRegistry: this.context.serviceRegistry,
      subscriptionManager: this.context.subscriptionManager,
      secretsManager: this.context.secretsManager,
    });
  }

  getSettingsSnapshot(): SettingsSnapshot {
    if (!this.context.configManager) {
      return { available: false, reason: 'configManager unavailable' };
    }
    const snapshot = getSettingsControlPlaneSnapshot(this.context.configManager);
    return {
      available: true,
      liveKeyCount: snapshot.liveKeyCount,
      profileCount: snapshot.profileCount,
      managedLockCount: snapshot.managedLockCount,
      resolvedCounts: snapshot.resolvedCounts,
      conflicts: snapshot.conflicts,
      recentFailures: snapshot.recentFailures,
      stagedManagedBundle: snapshot.stagedManagedBundle,
      rollbackHistory: snapshot.rollbackHistory,
    };
  }

  getSecuritySettingsReport(): readonly SecuritySettingReport[] {
    return getSecuritySettingsReport(this.context.configManager);
  }

  getLocalAuthSnapshot(): Record<string, unknown> {
    const snapshot = this.context.localUserAuthManager.inspect();
    return {
      userStorePath: snapshot.userStorePath,
      bootstrapCredentialPath: snapshot.bootstrapCredentialPath,
      bootstrapCredentialPresent: snapshot.bootstrapCredentialPresent,
      userCount: snapshot.userCount,
      sessionCount: snapshot.sessionCount,
      users: snapshot.users,
      sessions: snapshot.sessions,
    };
  }

  getContinuitySnapshot(): ContinuitySnapshot {
    const state = this.context.runtimeStore.getState();
    const options = this.persistenceOptions();
    const recovery = checkRecoveryFile(options);
    return {
      sessionId: state.session.id,
      status: state.session.status,
      recoveryState: state.session.recoveryState,
      lastSessionPointer: readLastSessionPointer(options),
      recoveryFilePresent: Boolean(recovery),
      recoveryFile: recovery ?? null,
    };
  }

  getWorktreeSnapshot(): WorktreeSnapshot {
    const records = listPersistedWorktreeMeta({ workingDirectory: this.projectWorkingDirectory() });
    return {
      summary: summarizeWorktreeOwnership(records),
      records,
    };
  }

  getIntelligenceSnapshot(): Record<string, unknown> {
    const intelligence = readIntelligenceSnapshot();
    return {
      diagnosticsStatus: intelligence.diagnosticsStatus,
      symbolSearchStatus: intelligence.symbolSearchStatus,
      hoverStatus: intelligence.hoverStatus,
      languageServers: intelligence.languageServers,
      errorCount: intelligence.errorCount,
      warningCount: intelligence.warningCount,
    };
  }

  listPanels(): PanelSnapshot[] {
    const manager = this.context.panelManager;
    const openIds = new Set([
      ...manager.getTopPane().panels.map((panel) => panel.id),
      ...manager.getBottomPane().panels.map((panel) => panel.id),
    ]);
    return manager
      .getRegisteredTypes()
      .map((registration) => ({
        id: registration.id,
        name: registration.name,
        category: registration.category,
        description: registration.description,
        open: openIds.has(registration.id),
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  openPanel(id: string, pane?: 'top' | 'bottom'): boolean {
    const manager = this.context.panelManager;
    const known = manager.getRegisteredTypes().some((registration) => registration.id === id);
    if (!known) return false;
    // The host says whether the view appeared; a known id it could not show is not opened.
    return manager.open(id, pane);
  }
}
