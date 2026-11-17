import { buildMcpAttackPathReview } from './mcp/index.js';
import type { McpDecisionRecord, McpSecuritySnapshot } from './mcp/types.js';
import type { RuntimeServices } from './services.js';
import type { UiReadModel } from './ui-read-models-base.js';
import { combineSubscriptions } from './ui-read-model-helpers.js';
import type { SecurityPanelSnapshot } from './diagnostics/panels/security.js';
import type { PluginStatus } from '../plugins/manager.js';

export interface UiMcpServerSnapshot {
  readonly name: string;
  readonly role: string;
  readonly trustMode: string;
  readonly status: string;
  readonly schemaFreshness: string;
  readonly toolCount: number;
  readonly lastError?: string | undefined;
  readonly quarantineReason?: string | undefined;
  readonly quarantineDetail?: string | undefined;
}

export interface UiSecuritySnapshot {
  readonly audit: SecurityPanelSnapshot;
  readonly policy: {
    readonly preflightStatus: string;
    readonly preflightIssueCount: number;
    readonly lintFindingCount: number;
  };
  readonly deniedPermissions: number;
  readonly incidents: ReturnType<import('./forensics/index.js').ForensicsRegistry['getAll']>;
  readonly latestIncident: ReturnType<import('./forensics/index.js').ForensicsRegistry['latest']>;
  readonly mcpServers: readonly McpSecuritySnapshot[];
  readonly recentMcpDecisions: readonly McpDecisionRecord[];
  readonly attackPathReview: ReturnType<typeof buildMcpAttackPathReview>;
  readonly plugins: readonly PluginStatus[];
  readonly quarantinedPlugins: readonly PluginStatus[];
  readonly untrustedPlugins: readonly PluginStatus[];
}

export interface UiMcpSnapshot {
  readonly servers: readonly UiMcpServerSnapshot[];
  readonly connectedServerNames: readonly string[];
  readonly availableToolCount: number;
  /** Connection failures this session: a server degraded, disconnected or quarantined. */
  readonly totalErrors: number;
  readonly recentDecisions: readonly McpDecisionRecord[];
}

export interface UiLocalAuthSnapshot {
  readonly bootstrapCredentialPresent: boolean;
  readonly userCount: number;
  readonly sessionCount: number;
}

/**
 * The security read model. Reading it never audits or emits: the token audit
 * shown is the last audit of record, with its real time. `runAudit` runs one
 * (re-reading the paired devices first) and the snapshot follows.
 */
export interface UiSecurityReadModel extends UiReadModel<UiSecuritySnapshot> {
  runAudit(): { readonly totalTokens: number; readonly findings: number; readonly at: number };
}

export interface UiSecurityObservabilityReadModels {
  readonly security: UiSecurityReadModel;
  readonly mcp: UiReadModel<UiMcpSnapshot>;
  readonly localAuth: UiReadModel<UiLocalAuthSnapshot>;
}

export function createSecurityObservabilityReadModels(
  runtimeServices: RuntimeServices,
  options: import('./ui-read-models-observability-options.js').UiObservabilityReadModelOptions = {},
): UiSecurityObservabilityReadModels {
  const { runtimeStore } = runtimeServices;

  const security: UiSecurityReadModel = {
      getSnapshot() {
        const audit = runtimeServices.tokenAuditor.lastReport();
        const mcpServers = [...runtimeStore.getState().mcp.servers.values()].map((server): McpSecuritySnapshot => ({
          name: server.name,
          role: server.role,
          trustMode: server.trustMode,
          allowedPaths: server.allowedPaths,
          allowedHosts: server.allowedHosts,
          schemaFreshness: server.schemaFreshness,
          quarantineReason: server.quarantineReason,
          quarantineDetail: server.quarantineDetail,
          connected: server.status === 'connected' || server.status === 'degraded',
        }));
        const recentMcpDecisions = runtimeServices.mcpRegistry.listRecentSecurityDecisions(8);
        const attackPathReview = buildMcpAttackPathReview({
          servers: mcpServers,
          recentDecisions: recentMcpDecisions,
        });
        const plugins = runtimeServices.pluginManager.list();
        const policySnapshot = runtimeServices.policyRuntimeState.getSnapshot();
        const snapshot: SecurityPanelSnapshot = {
          managed: runtimeServices.tokenAuditor.isManaged,
          totalTokens: runtimeServices.tokenAuditor.tokenCount,
          results: audit?.results ?? [],
          blocked: audit?.blocked ?? [],
          scopeViolations: audit?.scopeViolations ?? [],
          rotationWarnings: audit?.rotationWarnings ?? [],
          rotationOverdue: audit?.rotationOverdue ?? [],
          lastAuditAt: audit?.capturedAt ?? null,
          capturedAt: new Date().toISOString(),
        };
        return {
          audit: snapshot,
          policy: {
            preflightStatus: policySnapshot.lastPreflightReview?.status ?? 'n/a',
            preflightIssueCount: policySnapshot.lastPreflightReview?.issueCount ?? 0,
            lintFindingCount: policySnapshot.lintFindings.length,
          },
          deniedPermissions: runtimeStore.getState().permissions.denialCount,
          incidents: options.forensicsRegistry?.getAll() ?? [],
          latestIncident: options.forensicsRegistry?.latest() ?? null,
          mcpServers,
          recentMcpDecisions,
          attackPathReview,
          plugins,
          quarantinedPlugins: plugins.filter((plugin) => plugin.quarantined),
          untrustedPlugins: plugins.filter((plugin) => plugin.trustTier === 'untrusted'),
        };
      },
      runAudit() {
        const report = runtimeServices.tokenAuditor.runAudit(Date.now());
        const findings = new Set([...report.scopeViolations, ...report.rotationOverdue, ...report.rotationWarnings, ...report.blocked]).size;
        return { totalTokens: report.results.length, findings, at: report.capturedAt };
      },
      subscribe(listener) {
        const unsubs: Array<() => void> = [
          runtimeServices.tokenAuditor.onAudit(listener),
          runtimeStore.subscribe(listener),
          runtimeServices.pluginManager.subscribe(listener),
          runtimeServices.policyRuntimeState.subscribe(listener),
        ];
        if (options.forensicsRegistry) {
          unsubs.push(options.forensicsRegistry.subscribe(listener));
        }
        return combineSubscriptions(...unsubs);
      },
  };
  return {
    security,
    mcp: {
      getSnapshot() {
        const state = runtimeStore.getState().mcp;
        const servers = [...state.servers.values()]
          .map((server): UiMcpServerSnapshot => ({
            name: server.name,
            role: server.role,
            trustMode: server.trustMode,
            status: server.status,
            schemaFreshness: server.schemaFreshness,
            toolCount: server.toolCount,
            lastError: server.lastError,
            quarantineReason: server.quarantineReason,
            quarantineDetail: server.quarantineDetail,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          servers,
          connectedServerNames: state.connectedServerNames,
          availableToolCount: state.availableToolCount,
          totalErrors: state.totalErrors,
          recentDecisions: runtimeServices.mcpRegistry.listRecentSecurityDecisions(8),
        };
      },
      subscribe(listener) {
        return combineSubscriptions(
          runtimeStore.subscribe(listener),
          runtimeServices.mcpRegistry.subscribeSecurityDecisions(() => listener()),
        );
      },
    },
    localAuth: {
      // The user store and bootstrap credential are files; nothing announces a change.
      pollOnly: true,
      getSnapshot() {
        const snapshot = runtimeServices.localUserAuthManager.inspect();
        return {
          bootstrapCredentialPresent: snapshot.bootstrapCredentialPresent,
          userCount: snapshot.userCount,
          sessionCount: snapshot.sessionCount,
        };
      },
      subscribe() {
        return () => {};
      },
    },
  };
}
