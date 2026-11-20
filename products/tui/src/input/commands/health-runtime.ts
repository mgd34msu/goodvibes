import {
  collectServiceReadiness,
  collectSettingsHealthIssues,
  collectRemoteRecoveryIssues,
  collectMcpLifecycleIssues,
  collectContinuityIssues,
} from '@goodvibes-jev/engine/terminal-shell/health-findings';
import { renderSandboxDoctor } from '../../runtime/sandbox-public-gaps.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { probeTermCaps } from '../../renderer/term-caps.ts';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines } from '@/runtime/index.ts';
import { estimateConversationTokens } from '@goodvibes-jev/engine/platform/platform/core';
import { formatDoctorReport } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHealthCommand, type HealthArea, type FailureReportView } from '@goodvibes-jev/engine/terminal-shell/health-command';
import type { CommandReport } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { isSetupIssue } from '@goodvibes-jev/engine/terminal-shell/setup-review';
import { buildIncidentMemoryAddOptions } from '@goodvibes-jev/engine/platform/platform/state';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { formatRuntimeStateSnapshot, snapshotRuntimeState } from '@/runtime/index.ts';
import type { ReplaySnapshotInput } from '@/runtime/index.ts';
import { getMemorySpine } from './memory.ts';
import { buildSetupReviewSnapshot } from './local-setup-review.ts';
import { setupReviewLines } from '@goodvibes-jev/engine/terminal-shell/setup-review';
import { getSettingsControlPlaneSnapshot } from '@/runtime/index.ts';
import {
  requireOpsApi,
  requireOperatorClient,
  requireReplayEngine,
  requireReadModels,
  requireServiceRegistry,
  requireSessionMemoryStore,
} from './runtime-services.ts';
import { getOperatorRpc, describeOperatorRpcError } from './operator-rpc.ts';
import { formatQuotaSnapshotLine, renderMetricMap, telemetryScopeRefusalLine } from './health-metrics-format.ts';
import { createMemoryDiagnosticsGateway, renderMemoryDiagnostics } from '../../core/memory-diagnostics-gateway.ts';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';


function renderSandboxHealthSummary(configManager: ConfigManager): string[] {
  return renderSandboxDoctor(configManager).split('\n').slice(1);
}

function maintenanceOf(ctx: CommandContext) {
  const session = requireReadModels(ctx).session.getSnapshot();
  const providerRegistry = ctx.provider.providerRegistry;
  const llmMessages =
    typeof ctx.session.conversationManager.getMessagesForLLM === 'function' ? ctx.session.conversationManager.getMessagesForLLM() : [];
  // Resolve the context window the same way the Usage modal does so the
  // maintenance usage %/remaining agree across every diagnostics surface.
  const contextWindow = providerRegistry.getKnownContextWindowForModel(providerRegistry.getCurrentModel()) ?? 0; // 0: unknown window, no usage percentage
  return evaluateSessionMaintenance({
    configManager: ctx.platform.configManager,
    currentTokens: estimateConversationTokens(llmMessages),
    contextWindow,
    messageCount: llmMessages.length,
    sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
    session: session.session,
  });
}

/**
 * The short status `/health` prints bare: one line when everything works, or
 * each thing that does not with the command that fixes it. Reads the same
 * snapshots the area checks read; no model request, no daemon write.
 */
async function healthReport(ctx: CommandContext): Promise<CommandReport> {
  const readModels = requireReadModels(ctx);
  const snapshot = await buildSetupReviewSnapshot(ctx);
  const accounts = await requireOperatorClient(ctx).providers.accountSnapshot();
  const settings = readModels.settings.getSnapshot();
  const items: { sentence: string; fix?: { label: string; line: string } }[] = [];
  const fixFor: Readonly<Record<string, { label: string; line: string }>> = {
    providers: { label: 'Sign in to a provider', line: '/setup sign-in' },
    services: { label: 'See which services are not ready', line: '/health check services' },
    plugins: { label: 'See the held-back plugins', line: '/plugin' },
    mcp: { label: 'See which servers need attention', line: '/mcp review' },
  };
  for (const check of snapshot.checks.filter(isSetupIssue)) {
    items.push({ sentence: `${check.area}: ${check.message}.`, ...(fixFor[check.area] ? { fix: fixFor[check.area] } : {}) });
  }
  for (const provider of accounts.providers) {
    for (const issue of provider.issues) items.push({ sentence: `${provider.providerId}: ${issue}.`, fix: { label: 'Fix the account', line: `/accounts repair ${provider.providerId}` } });
  }
  for (const issue of collectSettingsHealthIssues(settings, 'a staged managed bundle is waiting to be applied or rolled back')) {
    items.push({ sentence: `Settings: ${issue}.`, fix: { label: 'See the settings in conflict', line: '/settings-sync' } });
  }
  if (readModels.localAuth.getSnapshot().bootstrapCredentialPresent) {
    items.push({ sentence: 'The first-run sign-in file is still on disk.', fix: { label: 'Remove it once you have signed in', line: '/local-auth' } });
  }
  const mcp = readModels.mcp.getSnapshot();
  for (const issue of collectMcpLifecycleIssues(mcp.servers, (id, kind, value) => `${id}: ${kind === 'error' ? value : `${kind} ${value}`}`)) {
    items.push({ sentence: `MCP server ${issue}.`, fix: { label: 'See which servers need attention', line: '/mcp review' } });
  }
  const remote = readModels.remote.getSnapshot().supervisor;
  for (const issue of collectRemoteRecoveryIssues(remote.sessions, (id, kind, value) => `${id}: ${kind === 'error' ? value : `${kind} ${value}`}`)) {
    items.push({ sentence: `Remote runner ${issue}.`, fix: { label: 'See the remote runners', line: '/remote' } });
  }
  const maintenance = maintenanceOf(ctx);
  if (maintenance.compactRecommended) items.push({ sentence: `The conversation fills the context window: ${maintenance.summary}`, fix: { label: 'Compact it', line: '/compact' } });
  if (items.length === 0) return { verdict: 'ok', headline: 'Everything is working.', items: [] };
  return { verdict: 'attention', headline: `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} attention:`, items };
}

/** One area in detail, for "Check one area". */
async function checkArea(ctx: CommandContext, area: HealthArea, providerArg: string): Promise<string> {
  const readModels = requireReadModels(ctx);
  switch (area) {
    case 'setup': {
      const snapshot = await buildSetupReviewSnapshot(ctx);
      return [
        'Setup',
        ...setupReviewLines(snapshot.checks),
        ...(snapshot.serviceIssues.length > 0 ? ['', '  Service issues:', ...snapshot.serviceIssues.map((issue) => `    - ${issue}`)] : []),
      ].join('\n');
    }
    case 'provider': {
      if (ctx.openModal && ctx.invokedByModel !== true) {
        ctx.openModal('providers-modal');
        return 'Opened the providers screen: each provider\'s state, latency and routes.';
      }
      const accounts = await requireOperatorClient(ctx).providers.accountSnapshot();
      return [
        'Model providers',
        `  model in use: ${ctx.session.runtime.provider}/${ctx.session.runtime.model}`,
        `  providers: ${accounts.providers.length}, configured: ${accounts.configuredCount}, with problems: ${accounts.issueCount}`,
        ...accounts.providers.flatMap((provider) => provider.issues.map((issue) => `  ${provider.providerId}: ${issue}`)),
      ].join('\n');
    }
    case 'memory': {
      // The MemoryGovernor snapshot (ops.memory.get): tier, budget vs RSS,
      // per-cache footprints, paused jobs, tripwire, read-only, honest 501
      // when a daemon predates the governor verb.
      const resolution = createMemoryDiagnosticsGateway({
        configManager: ctx.platform.configManager,
        homeDirectory: () => requireShellPaths(ctx).homeDirectory,
      });
      return await renderMemoryDiagnostics(resolution);
    }
    case 'services': {
      const { configured, issues } = await collectServiceReadiness(requireServiceRegistry(ctx), ': ');
      return [
        'Services',
        `  configured: ${configured}`,
        `  issues: ${issues.length}`,
        ...(issues.length > 0 ? issues.map((issue) => `  ${issue}`) : ['  all configured services passed readiness checks']),
      ].join('\n');
    }
    case 'sandbox':
      return ['Sandbox', ...renderSandboxHealthSummary(ctx.platform.configManager)].join('\n');
    case 'accounts': {
      const accounts = await requireOperatorClient(ctx).providers.accountSnapshot();
      return [
        'Provider accounts',
        `  providers: ${accounts.providers.length}`,
        `  configured: ${accounts.configuredCount}`,
        `  issues: ${accounts.issueCount}`,
        ...accounts.providers.flatMap((provider) => [
          ...provider.issues.map((issue) => `  ${provider.providerId}: ${issue}`),
          ...(provider.fallbackRisk ? [`  ${provider.providerId}: ${provider.fallbackRisk}`] : []),
        ]),
      ].join('\n');
    }
    case 'auth': {
      const auth = readModels.localAuth.getSnapshot();
      return [
        'Local sign-in',
        `  users: ${auth.userCount}`,
        `  sessions: ${auth.sessionCount}`,
        `  first-run sign-in file: ${auth.bootstrapCredentialPresent ? 'present (remove it with /local-auth once you have signed in)' : 'removed'}`,
      ].join('\n');
    }
    case 'settings': {
      const settings = readModels.settings.getSnapshot();
      const issues = collectSettingsHealthIssues(settings, 'staged managed bundle is awaiting apply or rollback');
      return [
        'Settings',
        `  available: ${settings.available ? 'yes' : 'no'}`,
        `  managed locks: ${settings.managedLockCount}`,
        `  conflicts: ${settings.conflictCount}`,
        `  recent failures: ${settings.recentFailureCount}`,
        `  staged bundle: ${settings.hasStagedManagedBundle ? 'present' : 'none'}`,
        ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active settings-control issues detected']),
      ].join('\n');
    }
    case 'intelligence': {
      const intelligence = readModels.intelligence.getSnapshot();
      const issues: string[] = [];
      if (intelligence.diagnosticsStatus !== 'ready') issues.push(`diagnostics=${intelligence.diagnosticsStatus}`);
      if (intelligence.symbolSearchStatus !== 'ready') issues.push(`symbols=${intelligence.symbolSearchStatus}`);
      if (intelligence.hoverStatus !== 'ready') issues.push(`hover=${intelligence.hoverStatus}`);
      return [
        'Code intelligence',
        `  diagnostics: ${intelligence.diagnosticsStatus}`,
        `  symbols: ${intelligence.symbolSearchStatus}`,
        `  hover: ${intelligence.hoverStatus}`,
        `  language servers: ${intelligence.languageServers.length > 0 ? intelligence.languageServers.map((server) => `${server.language}=${server.state}`).join(', ') : 'none configured'}`,
        `  errors: ${intelligence.errorCount}`,
        `  warnings: ${intelligence.warningCount}`,
        ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active intelligence readiness issues detected']),
      ].join('\n');
    }
    case 'remote': {
      const snapshot = readModels.remote.getSnapshot().supervisor;
      const issues = collectRemoteRecoveryIssues(snapshot.sessions, (id, kind, value) => id + ': ' + (kind === 'error' ? value : kind + '=' + value));
      return [
        'Remote runners',
        `  sessions: ${snapshot.sessions.length}`,
        `  active connections: ${snapshot.activeConnections}`,
        `  degraded: ${snapshot.degradedConnections}`,
        ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active remote recovery issues detected']),
      ].join('\n');
    }
    case 'mcp': {
      const mcp = readModels.mcp.getSnapshot();
      const issues = collectMcpLifecycleIssues(mcp.servers, (id, kind, value) => id + ': ' + (kind === 'error' ? value : kind + '=' + value));
      return [
        'MCP servers',
        `  servers: ${mcp.servers.length}`,
        `  connected: ${mcp.connectedServerNames.length}`,
        `  tools: ${mcp.availableToolCount}`,
        `  connection failures: ${mcp.totalErrors}`,
        ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active MCP lifecycle issues detected']),
      ].join('\n');
    }
    case 'metrics': {
      const rpc = getOperatorRpc(ctx);
      if (!rpc.available) throw commandRefusal(`Runtime counters are read from the daemon, and none is connected: ${rpc.reason}`);
      const lines: string[] = ['Runtime counters and quota'];
      // Process-wide runtime metrics snapshot (runtime.metrics.get). Requires
      // the read:telemetry scope; a scope refusal is rendered as such, never
      // as zero counters.
      try {
        const metrics = await rpc.platformClient.operator.invoke('runtime.metrics.get', {});
        lines.push(...renderMetricMap('counters', metrics.counters as Record<string, unknown>));
        lines.push(...renderMetricMap('gauges', metrics.gauges as Record<string, unknown>));
        lines.push(...renderMetricMap('histograms', metrics.histograms as Record<string, unknown>));
        const byModel = Object.keys(metrics.toolFormat?.byModel ?? {}).length;
        const byClass = Object.keys(metrics.toolFormat?.byClass ?? {}).length;
        lines.push(`  tool-format telemetry: ${byModel} model(s), ${byClass} class(es)`);
      } catch (error) {
        const scopeLine = telemetryScopeRefusalLine(error, 'runtime metrics');
        lines.push(scopeLine ?? `  runtime metrics: ${describeOperatorRpcError(error)}`);
      }
      // Remaining rate-limit quota (quota.snapshot.get). hasSignal:false is an
      // honest "no observation yet", never a fabricated full quota.
      const provider = (providerArg || ctx.session.runtime.provider || '').trim();
      if (provider) {
        try {
          const quota = await rpc.platformClient.operator.invoke('quota.snapshot.get', { provider });
          lines.push(formatQuotaSnapshotLine(provider, quota));
        } catch (error) {
          const scopeLine = telemetryScopeRefusalLine(error, `quota (${provider})`);
          lines.push(scopeLine ?? `  quota (${provider}): ${describeOperatorRpcError(error)}`);
        }
      } else {
        lines.push('  quota: no provider in use (name one: /health check metrics --provider <id>).');
      }
      return lines.join('\n');
    }
    case 'continuity': {
      const continuity = readModels.continuity.getSnapshot();
      const returnMode = String(ctx.platform.configManager.get('behavior.returnContextMode') ?? 'off');
      const issues = collectContinuityIssues(continuity, returnMode);
      return [
        'Picking up where you left off',
        `  return context mode: ${returnMode}`,
        `  last session pointer: ${continuity.lastSessionPointer ?? 'none'}`,
        `  recovery file: ${continuity.recoveryFilePresent ? 'present' : 'clear'}`,
        ...(continuity.returnContext
          ? [`  recovery activity: ${continuity.returnContext.activityLabel}`, `  recovery status: ${continuity.returnContext.statusLabel}`]
          : []),
        ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active session continuity issues detected']),
      ].join('\n');
    }
    case 'maintenance':
      return ['Conversation size', ...formatSessionMaintenanceLines(maintenanceOf(ctx), 'guided')].join('\n');
    case 'worktrees': {
      const summary = readModels.worktrees.getSnapshot().summary;
      return [
        'Worktrees',
        `  total: ${summary.total}`,
        `  active: ${summary.active}`,
        `  paused: ${summary.paused}`,
        ...(summary.paused > 0 ? [`  issue: ${summary.paused} paused worktree(s) may need resume or merge review (/worktree)`] : ['  no active worktree lifecycle issues detected']),
      ].join('\n');
    }
    case 'terminal': {
      const caps = probeTermCaps(process.stdout as NodeJS.WriteStream);
      const issues: string[] = [];
      if (caps.capability === 'none') issues.push('terminal reports no color support; UI rendering will be degraded (no ANSI colors)');
      if (caps.capability === 'basic16') issues.push('terminal limited to 16 ANSI colors; gradient and true-color UI elements will be approximated');
      if (!caps.syncedOutput) issues.push('DEC Synchronized Output (mode 2026) is disabled; screen-tearing may be visible on slow connections');
      // Direct terminal writes the output guard intercepted (routed to the activity log instead of the transcript).
      const intercepted = ctx.session.runtime.terminalWritesIntercepted ?? 0;
      return [
        'This terminal',
        `  color capability: ${caps.capability}`,
        `  synced output (mode 2026): ${caps.syncedOutput ? 'enabled' : 'disabled'}`,
        `  NO_COLOR env: ${process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '' ? 'set (forces none)' : 'unset'}`,
        `  TERM env: ${process.env['TERM'] ?? '(unset)'}`,
        `  direct writes intercepted this session: ${intercepted}${intercepted > 0 ? ' (details in the activity log)' : ''}`,
        ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no terminal capability issues detected']),
      ].join('\n');
    }
    case 'approvals':
      throw commandRefusal('The asks waiting for you are listed by /approval in this program; nothing was checked.', 'Run /approval.');
  }
}

/** The failure report an id (or `latest`) names. */
function failureReport(ctx: CommandContext, id: string) {
  const registry = ctx.extensions.forensicsRegistry;
  if (!registry) throw commandRefusal('Failure reports are not recorded in this session.');
  const report = id === 'latest' ? registry.latest() : registry.getById(id);
  if (!report) throw commandRefusal(id === 'latest' ? 'No failure report was recorded this session.' : `No failure report is ${id}.`, '/health failure lists them.');
  return { registry, report };
}

function showFailure(ctx: CommandContext, id: string, view: FailureReportView): string {
  const { registry, report } = failureReport(ctx, id);
  if (view === 'report') return registry.exportAsJson(report.id) ?? `The report ${report.id} could not be written as JSON.`;
  if (view === 'bundle') {
    const json = registry.exportBundleAsJson(report.id, { replaySnapshot: requireReplayEngine(ctx).getSnapshot() as ReplaySnapshotInput });
    if (!json) throw commandRefusal(`The bundle of ${report.id} could not be built.`);
    return json;
  }
  const bundle = registry.buildBundle(report.id);
  const lines = [
    `Failure report ${report.id}`,
    `  when: ${new Date(report.generatedAt).toISOString()}`,
    `  kind: ${report.classification}`,
    `  what failed: ${report.summary}`,
    ...(report.errorMessage ? [`  error: ${report.errorMessage}`] : []),
    ...(report.stopReason ? [`  stop reason: ${report.stopReason}`] : []),
    ...(report.taskId ? [`  task: ${report.taskId}`] : []),
    ...(report.turnId ? [`  turn: ${report.turnId}`] : []),
    ...(bundle
      ? [
          `  root cause: ${bundle.evidence.rootCause ?? 'not found'}`,
          `  denied permissions: ${bundle.evidence.deniedPermissionCount}`,
          `  budget breaches: ${bundle.evidence.budgetBreachCount}`,
          `  replay mismatches: ${bundle.replay.mismatchCount}`,
        ]
      : []),
    ...(report.causalChain.length > 0 ? ['  how it happened:', ...report.causalChain.map((entry) => `  ${entry.isRootCause ? '  ● ' : '  · '}${entry.description}`)] : []),
  ];
  return lines.join('\n');
}

function saveFailure(ctx: CommandContext, input: { readonly report: string; readonly path: string; readonly replay: boolean; readonly replace: boolean }): string {
  const { registry, report } = failureReport(ctx, input.report);
  const json = input.replay
    ? registry.exportBundleAsJson(report.id, { replaySnapshot: requireReplayEngine(ctx).getSnapshot() as ReplaySnapshotInput })
    : registry.exportBundleAsJson(report.id);
  if (!json) throw commandRefusal(`The bundle of ${report.id} could not be built; nothing was written.`);
  const targetPath = requireShellPaths(ctx).resolveWorkspacePath(input.path);
  if (existsSync(targetPath) && !input.replace) {
    throw commandRefusal(`${targetPath} already exists; nothing was written.`, `Write over it: /health save-failure ${input.path} --report ${report.id} --replace`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${json}\n`, 'utf-8');
  return `Saved failure report ${report.id}${input.replay ? ' with its replay snapshot' : ''} to ${targetPath}.`;
}

async function keepFailure(ctx: CommandContext, id: string): Promise<string> {
  const { registry, report } = failureReport(ctx, id);
  const memory = getMemorySpine(ctx);
  if (!memory) throw commandRefusal('Memory is not available in this session; nothing was kept.');
  const bundle = registry.buildBundle(report.id);
  if (!bundle) throw commandRefusal(`The bundle of ${report.id} could not be built; nothing was kept.`);
  // One durable record per report: the id tag is what a repeat looks for.
  const incidentTag = `incident:${report.id}`;
  const existing = await memory.list({ cls: 'incident', tags: [incidentTag], limit: 1 });
  if (existing[0]) return `Failure report ${report.id} is already kept in memory as ${existing[0].id}; nothing was added.`;
  const options = buildIncidentMemoryAddOptions(bundle);
  const record = await memory.add({ ...options, tags: [...(options.tags ?? []), incidentTag] });
  return `Kept failure report ${report.id} in memory as ${record.id}.`;
}

export function registerHealthRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createHealthCommand<CommandContext>({
    report: healthReport,
    check: checkArea,
    async diagnose(ctx, symptom) {
      return formatDoctorReport(await requireReadModels(ctx).doctor.diagnose(symptom)).join('\n');
    },
    runtimeState(ctx, domains) {
      // This app's runtime store as the platform's snapshot reader shows it: JSON-safe, credential-masked, bounded.
      const store = ctx.platform.runtimeStore;
      if (!store) throw commandRefusal('The runtime store is not available in this session.');
      const snapshot = snapshotRuntimeState(store, domains.length > 0 ? { domains: [...domains] } : {});
      return formatRuntimeStateSnapshot(snapshot, `Runtime State (${new Date(snapshot.capturedAt).toISOString()})`);
    },
    failures: { show: showFailure, save: saveFailure, keep: keepFailure },
    async stopAgent(ctx, agentId, note) {
      try {
        requireOpsApi(ctx).agents.cancel(agentId, note || undefined);
      } catch (error) {
        throw commandRefusal(`Agent ${agentId} was not stopped: ${summarizeError(error)}`);
      }
      return `Asked agent ${agentId} to stop.`;
    },
    elsewhere: 'the Agent (goodvibes-agent)',
  }));
}
