import {
  collectRecommendationCandidates,
  rankRecommendationCandidates,
  unrankedRecommendations,
  type EcosystemRecommendation,
  type RecommendationCandidates,
} from './ecosystem/recommendations.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { isClassicOperation } from './decision-policy.js';
import type { RuntimeServices } from './services.js';
import type { UiReadModel } from './ui-read-models-base.js';
import { combineSubscriptions, createStoreBackedReadModel } from './ui-read-model-helpers.js';
import { countUndecidedApprovals } from './ui-read-models-core.js';
import type {
  ContinuitySnapshot as IntegrationContinuitySnapshot,
  SettingsSnapshot as IntegrationSettingsSnapshot,
  WorktreeSnapshot as IntegrationWorktreeSnapshot,
} from './integration/helpers.js';
import type { SessionReturnContextSummary } from './session-return-context.js';
import type { ManagedWorktreeMeta } from './worktree/registry.js';
import type { PluginStatus } from '../plugins/manager.js';
import { CodeIntelligence, type CodeIntelligenceDiagnostic, type CodeIntelligenceReadiness } from '../intelligence/facade.js';

/** `ready`: it answers now or starts on the first lookup; `degraded`: syntax only, or every configured server failed to start; `unavailable`: nothing can answer. */
export type IntelligenceFeatureStatus = 'ready' | 'degraded' | 'unavailable';

export interface UiIntelligenceSnapshot {
  /** Language-server diagnostics; syntax diagnostics from the built-in parser are always there, so this is never `unavailable`. */
  readonly diagnosticsStatus: IntelligenceFeatureStatus;
  /** Symbols and outlines come from the built-in parser. */
  readonly symbolSearchStatus: IntelligenceFeatureStatus;
  /** Hover, definitions and references need a language server. */
  readonly hoverStatus: IntelligenceFeatureStatus;
  readonly languageServers: readonly { readonly language: string; readonly state: 'running' | 'failed' | 'idle' }[];
  readonly errorCount: number;
  readonly warningCount: number;
  /** What the running language servers last published, keyed by absolute path. */
  readonly diagnostics: ReadonlyMap<string, readonly CodeIntelligenceDiagnostic[]>;
}

/**
 * Code intelligence readiness from the facades held in this process (no
 * server is started and nothing is parsed): the language servers' states and
 * the diagnostics the running ones published.
 */
export function readIntelligenceSnapshot(readiness: CodeIntelligenceReadiness = CodeIntelligence.readiness()): UiIntelligenceSnapshot {
  const states = [...readiness.languageServers.values()];
  const servers: IntelligenceFeatureStatus = states.some((state) => state !== 'failed')
    ? 'ready'
    : states.length > 0 ? 'degraded' : 'unavailable';
  let errorCount = 0;
  let warningCount = 0;
  for (const list of readiness.diagnostics.values()) {
    for (const diagnostic of list) {
      if (diagnostic.severity === 'error') errorCount += 1;
      else if (diagnostic.severity === 'warning') warningCount += 1;
    }
  }
  return {
    diagnosticsStatus: servers === 'ready' ? 'ready' : 'degraded',
    symbolSearchStatus: 'ready',
    hoverStatus: servers,
    languageServers: [...readiness.languageServers].map(([language, state]) => ({ language, state })).sort((a, b) => a.language.localeCompare(b.language)),
    errorCount,
    warningCount,
    diagnostics: readiness.diagnostics,
  };
}

/**
 * Where the recommendations stand: `idle` until something asks for them,
 * `pending` while Jev ranks them, `ready` with the ranked list (which may be
 * empty), `failed` when the ranking could not be read (startupIssues says
 * why), `off` with no decision model in use: nothing is ranked, and once
 * asked the list holds every live need's uninstalled entries in catalog order,
 * each marked unranked.
 */
export type UiMarketplaceRanking = 'idle' | 'pending' | 'ready' | 'failed' | 'off';

export interface UiMarketplaceSnapshot {
  readonly startupIssues: readonly string[];
  readonly recommendations: readonly EcosystemRecommendation[];
  readonly ranking: UiMarketplaceRanking;
}

/** The marketplace read model: a snapshot that never reads the disk or asks a model, and the explicit ranking. */
export interface UiMarketplaceReadModel extends UiReadModel<UiMarketplaceSnapshot> {
  /**
   * Collect the live needs and the uninstalled entries that could answer
   * them (one read of the catalogs), rank them with Jev when they changed
   * since the last ranking, and resolve with the snapshot once the ranking
   * settled. Never rejects; a failed ranking is `ranking: 'failed'`.
   */
  recommend(): Promise<UiMarketplaceSnapshot>;
}

export interface UiCockpitSnapshot {
  readonly runningTasks: number;
  readonly blockedTasks: number;
  readonly failedTasks: number;
  readonly activeContracts: number;
  readonly spawnGuardTrips: number;
  readonly blockedMessages: number;
  readonly pendingPermissions: number;
  readonly deniedPermissions: number;
  readonly preflightStatus: string;
  readonly preflightIssueCount: number;
  readonly lintFindingCount: number;
  readonly tokenBlockedCount: number;
  readonly tokenRotationOverdueCount: number;
  readonly tokenScopeViolationCount: number;
  readonly tokenRotationWarningCount: number;
  readonly incidentCount: number;
  readonly latestIncident: ReturnType<import('./forensics/index.js').ForensicsRegistry['latest']>;
  readonly elevatedMcp: number;
  readonly unhealthyMcp: number;
  readonly erroredPlugins: number;
  readonly failingIntegrations: number;
  readonly taskCount: number;
  readonly agentCount: number;
  readonly totalContracts: number;
  readonly communicationCount: number;
  readonly mcpServerCount: number;
  readonly pluginCount: number;
}

export interface UiHealthSnapshot {
  readonly degradedDomains: readonly string[];
  readonly providerProblems: readonly string[];
  readonly degradedMcpServers: readonly string[];
  readonly quarantinedMcpServers: readonly string[];
  readonly integrationProblems: readonly string[];
  readonly daemonTransportState: string;
  readonly acpTransportState: string;
  readonly recoveryState: string;
}

export interface UiSystemObservabilityReadModels {
  readonly intelligence: UiReadModel<UiIntelligenceSnapshot>;
  readonly marketplace: UiMarketplaceReadModel;
  readonly cockpit: UiReadModel<UiCockpitSnapshot>;
  readonly health: UiReadModel<UiHealthSnapshot>;
}

/** What decides the recommendations: the live needs and the entries each could use. */
function candidatesKey(candidates: readonly RecommendationCandidates[]): string {
  return JSON.stringify(candidates.map((candidate) => [candidate.need, candidate.reason, candidate.entries]));
}

/**
 * The marketplace read model. Startup issues are counted from the store on
 * every snapshot. Recommendations are ranked by Jev only when asked
 * (`recommend`): that collects the live needs and uninstalled entries once,
 * reuses the last ranking when they are unchanged, and otherwise ranks them;
 * every change of `ranking` notifies subscribers. A snapshot reads neither
 * the disk nor a model. A ranking overtaken by a newer one is discarded.
 */
function createMarketplaceReadModel(runtimeServices: RuntimeServices): UiMarketplaceReadModel {
  const { runtimeStore } = runtimeServices;
  const catalogOptions = {
    cwd: runtimeServices.shellPaths.workingDirectory,
    homeDir: runtimeServices.shellPaths.homeDirectory,
  };
  const listeners = new Set<() => void>();
  let recommendations: readonly EcosystemRecommendation[] = [];
  /** The list `recommend` built while no decision model was in use; never mixed with a ranked one. */
  let unranked: readonly EcosystemRecommendation[] = [];
  let ranking: UiMarketplaceRanking = 'idle';
  let rankedKey: string | undefined;
  let failureMessage: string | undefined;
  let inFlight: { readonly key: string; readonly done: Promise<void> } | undefined;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const snapshot = (): UiMarketplaceSnapshot => {
    const state = runtimeStore.getState();
    const startupIssues: string[] = [];
    if (state.permissions.denialCount >= 3) {
      startupIssues.push(`${state.permissions.denialCount} permission denials suggest a policy-pack or trust posture review.`);
    }
    const authRequiredServers = [...state.mcp.servers.values()].filter((server) => server.status === 'auth_required');
    if (authRequiredServers.length > 0) {
      startupIssues.push(`${authRequiredServers.length} MCP server${authRequiredServers.length === 1 ? '' : 's'} need auth or reconnect repair.`);
    }
    const staleSchemas = [...state.mcp.servers.values()].filter((server) => server.schemaFreshness !== 'fresh');
    if (staleSchemas.length > 0) {
      startupIssues.push(`${staleSchemas.length} MCP server schema${staleSchemas.length === 1 ? ' is' : 's are'} stale or quarantined.`);
    }
    if (isClassicOperation()) {
      startupIssues.push('No decision model is in use: recommendations are not ranked; each live need lists its uninstalled entries in catalog order.');
      return { startupIssues, recommendations: unranked, ranking: 'off' };
    }
    if (ranking === 'failed' && failureMessage) {
      startupIssues.push(`Marketplace recommendations could not be ranked (${failureMessage}); /marketplace recommend tries again.`);
    }
    return { startupIssues, recommendations, ranking };
  };

  const rank = (key: string, candidates: readonly RecommendationCandidates[]): Promise<void> => {
    rankedKey = key;
    ranking = 'pending';
    notify();
    return rankRecommendationCandidates(candidates).then(
      (ranked) => {
        if (rankedKey !== key) return;
        recommendations = ranked;
        failureMessage = undefined;
        ranking = 'ready';
        notify();
      },
      (err: unknown) => {
        // A ranking overtaken by a newer one says nothing about the current candidates.
        if (rankedKey !== key) return;
        failureMessage = summarizeError(err);
        logger.warn('Marketplace recommendations could not be ranked', { error: failureMessage });
        // Forget the key so the next request asks again.
        rankedKey = undefined;
        recommendations = [];
        ranking = 'failed';
        notify();
      },
    );
  };

  return {
    getSnapshot: snapshot,
    async recommend() {
      if (isClassicOperation()) {
        // Code only: the live needs and their uninstalled entries, one read of the catalogs, no model.
        unranked = unrankedRecommendations(collectRecommendationCandidates(runtimeStore, catalogOptions));
        notify();
        return snapshot();
      }
      const candidates = collectRecommendationCandidates(runtimeStore, catalogOptions);
      const key = candidatesKey(candidates);
      if (inFlight?.key === key) {
        await inFlight.done;
      } else if (key !== rankedKey || ranking !== 'ready') {
        const done = rank(key, candidates);
        inFlight = { key, done };
        try { await done; } finally { if (inFlight?.done === done) inFlight = undefined; }
      }
      return snapshot();
    },
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribeStore = runtimeStore.subscribe(listener);
      return () => {
        listeners.delete(listener);
        unsubscribeStore();
      };
    },
  };
}

export function createSystemObservabilityReadModels(
  runtimeServices: RuntimeServices,
  options: import('./ui-read-models-observability-options.js').UiObservabilityReadModelOptions = {},
): UiSystemObservabilityReadModels {
  const { runtimeStore } = runtimeServices;

  return {
    intelligence: createStoreBackedReadModel(runtimeServices, () => readIntelligenceSnapshot()),
    marketplace: createMarketplaceReadModel(runtimeServices),
    cockpit: {
      getSnapshot() {
        const state = runtimeStore.getState();
        const runningTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'running').length;
        const blockedTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'blocked').length;
        const failedTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'failed').length;
        const audit = runtimeServices.tokenAuditor.auditAll();
        const incidents = options.forensicsRegistry?.getAll() ?? [];
        const plugins = runtimeServices.pluginManager.list();
        const failingIntegrations = [...state.integrations.integrations.values()].filter((record) => record.status === 'error').length;
        const elevatedMcp = [...state.mcp.servers.values()].filter((server) => server.trustMode === 'allow-all').length;
        const unhealthyMcp = [...state.mcp.servers.values()].filter((server) => (
          server.status === 'degraded'
          || server.status === 'auth_required'
          || server.status === 'reconnecting'
          || server.status === 'disconnected'
        )).length;
        const preflight = runtimeServices.policyRuntimeState.getSnapshot().lastPreflightReview;
        const lintFindingCount = runtimeServices.policyRuntimeState.getSnapshot().lintFindings.length;
        return {
          runningTasks,
          blockedTasks,
          failedTasks,
          activeContracts: state.contracts.activeContractIds.length,
          spawnGuardTrips: state.contracts.spawnGuardTrips,
          blockedMessages: state.communication.totalBlocked,
          // The broker holds every owner ask until it is decided.
          pendingPermissions: runtimeServices.approvalBroker
            ? countUndecidedApprovals(runtimeServices.approvalBroker)
            : 0,
          deniedPermissions: state.permissions.denialCount,
          preflightStatus: preflight?.status ?? 'n/a',
          preflightIssueCount: preflight?.issueCount ?? 0,
          lintFindingCount,
          tokenBlockedCount: audit.blocked.length,
          tokenRotationOverdueCount: audit.rotationOverdue.length,
          tokenScopeViolationCount: audit.scopeViolations.length,
          tokenRotationWarningCount: audit.rotationWarnings.length,
          incidentCount: incidents.length,
          latestIncident: options.forensicsRegistry?.latest() ?? null,
          elevatedMcp,
          unhealthyMcp,
          erroredPlugins: plugins.filter((plugin) => plugin.quarantined || !plugin.active).length,
          failingIntegrations,
          taskCount: state.tasks.tasks.size,
          agentCount: state.agents.agents.size,
          totalContracts: state.contracts.totalContracts,
          communicationCount: state.communication.records.size,
          mcpServerCount: state.mcp.servers.size,
          pluginCount: plugins.length,
        };
      },
      subscribe(listener) {
        // Every source the snapshot reads that announces change: the approval
        // broker (a raised ask never touches the store), plugins and policy state.
        // The token auditor has no change event.
        const unsubs: Array<() => void> = [
          runtimeStore.subscribe(listener),
          runtimeServices.pluginManager.subscribe(listener),
          runtimeServices.policyRuntimeState.subscribe(listener),
          ...(runtimeServices.approvalBroker ? [runtimeServices.approvalBroker.subscribe(() => listener())] : []),
        ];
        if (options.forensicsRegistry) {
          unsubs.push(options.forensicsRegistry.subscribe(listener));
        }
        return combineSubscriptions(...unsubs);
      },
    },
    health: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const providerProblems = [...runtimeServices.providerRegistry.health().keys()];
      const degradedMcpServers = [...state.mcp.servers.values()]
        .filter((server) => server.status === 'degraded' || server.status === 'auth_required' || server.schemaFreshness === 'quarantined')
        .map((server) => server.name);
      const quarantinedMcpServers = [...state.mcp.servers.values()]
        .filter((server) => server.schemaFreshness === 'quarantined')
        .map((server) => server.name);
      const degradedDomains: string[] = [];
      if (providerProblems.length > 0) degradedDomains.push('providerHealth');
      if (degradedMcpServers.length > 0) degradedDomains.push('mcp');
      if (state.integrations.problemIds.length > 0) degradedDomains.push('integrations');
      if (state.daemon.transportState === 'degraded' || state.daemon.transportState === 'terminal_failure') degradedDomains.push('daemon');
      if (state.acp.managerTransportState === 'degraded' || state.acp.managerTransportState === 'terminal_failure') degradedDomains.push('acp');
      if (state.session.recoveryState === 'failed') degradedDomains.push('session');
      return {
        degradedDomains,
        providerProblems,
        degradedMcpServers,
        quarantinedMcpServers,
        integrationProblems: state.integrations.problemIds,
        daemonTransportState: state.daemon.transportState,
        acpTransportState: state.acp.managerTransportState,
        recoveryState: state.session.recoveryState,
      };
    }),
  };
}
