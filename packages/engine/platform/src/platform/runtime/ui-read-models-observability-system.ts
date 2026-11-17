import {
  collectRecommendationCandidates,
  rankRecommendationCandidates,
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

export interface UiMarketplaceSnapshot {
  readonly startupIssues: readonly string[];
  readonly recommendations: readonly EcosystemRecommendation[];
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
  readonly marketplace: UiReadModel<UiMarketplaceSnapshot>;
  readonly cockpit: UiReadModel<UiCockpitSnapshot>;
  readonly health: UiReadModel<UiHealthSnapshot>;
}

/** What decides the recommendations: the live needs and the entries each could use. */
function candidatesKey(candidates: readonly RecommendationCandidates[]): string {
  return JSON.stringify(candidates.map((candidate) => [candidate.need, candidate.reason, candidate.entries]));
}

/** How long after a failed ranking the same candidates wait before Jev is asked again. */
const RANKING_RETRY_MS = 60_000;

/**
 * The marketplace read model. Startup issues are counted from the store on
 * every snapshot. Recommendations are read by Jev, which is asynchronous, so
 * the snapshot carries the last ranked list: each snapshot collects the live
 * needs and uninstalled entries (code, as before), and when they differ from
 * the ones last ranked a ranking starts; its result replaces the list and
 * notifies subscribers. A ranking overtaken by a newer one is discarded.
 * A failed ranking leaves the list empty, says so in the startup issues, and
 * is tried again for the same candidates once RANKING_RETRY_MS has passed.
 */
function createMarketplaceReadModel(
  runtimeServices: RuntimeServices,
  now: () => number = Date.now,
): UiReadModel<UiMarketplaceSnapshot> {
  const { runtimeStore } = runtimeServices;
  const catalogOptions = {
    cwd: runtimeServices.shellPaths.workingDirectory,
    homeDir: runtimeServices.shellPaths.homeDirectory,
  };
  const listeners = new Set<() => void>();
  let recommendations: readonly EcosystemRecommendation[] = [];
  let rankedKey: string | undefined;
  let failure: { readonly key: string; readonly at: number; readonly message: string } | undefined;

  const publish = (key: string, next: readonly EcosystemRecommendation[]): void => {
    if (rankedKey !== key) return;
    failure = undefined;
    recommendations = next;
    for (const listener of [...listeners]) listener();
  };

  const rankingFailed = (key: string, err: unknown): void => {
    // A ranking overtaken by a newer one says nothing about the current candidates.
    if (rankedKey !== key) return;
    const message = summarizeError(err);
    logger.warn('Marketplace recommendations could not be ranked', { error: message });
    // Forget the key so the next snapshot can ask again (after the retry delay), and say why the list is empty.
    rankedKey = undefined;
    failure = { key, at: now(), message };
    recommendations = [];
    for (const listener of [...listeners]) listener();
  };

  const refreshRecommendations = (): void => {
    const candidates = collectRecommendationCandidates(runtimeStore, catalogOptions);
    const key = candidatesKey(candidates);
    if (key === rankedKey) return;
    if (failure && failure.key !== key) failure = undefined;
    if (failure && failure.key === key && now() - failure.at < RANKING_RETRY_MS) return;
    rankedKey = key;
    rankRecommendationCandidates(candidates).then(
      (ranked) => publish(key, ranked),
      (err: unknown) => rankingFailed(key, err),
    );
  };

  return {
    getSnapshot() {
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
        rankedKey = undefined; failure = undefined; recommendations = [];
        startupIssues.push('Classic mode: semantic marketplace recommendations are not evaluated. Browse the catalog and choose entries explicitly.');
      } else {
        refreshRecommendations();
        if (failure) startupIssues.push(`Marketplace recommendations could not be ranked (${failure.message}); they are tried again automatically.`);
      }
      return { startupIssues, recommendations };
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
    marketplace: createMarketplaceReadModel(runtimeServices, options.now),
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
