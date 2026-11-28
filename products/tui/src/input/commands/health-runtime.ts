import {
  collectServiceReadiness,
  collectSettingsHealthIssues,
  collectMcpLifecycleIssues,
  collectContinuityIssues,
} from '@goodvibes/engine/terminal-shell/health-findings';
import { capabilityBinding } from './capability-binding.ts';
import { renderSandboxDoctor } from '../../runtime/sandbox-public-gaps.ts';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { probeTermCaps } from '../../renderer/term-caps.ts';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines } from '@/runtime/index.ts';
import { estimateConversationTokens } from '@goodvibes/engine/platform/platform/core';
import { formatDoctorReport } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { CommandContext } from '../command-registry.ts';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readRemoteRunnersHealth, type HealthArea, type HealthCommandPolicy, type FailureReportView } from '@goodvibes/engine/terminal-shell/health-command';
import type { CommandReport } from '@goodvibes/engine/terminal-shell/command-actions';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { isSetupIssue } from '@goodvibes/engine/terminal-shell/setup-review';
import { buildIncidentMemoryAddOptions } from '@goodvibes/engine/platform/platform/state';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { formatRuntimeStateSnapshot, snapshotRuntimeState } from '@/runtime/index.ts';
import type { ReplaySnapshotInput } from '@/runtime/index.ts';
import { getMemorySpine } from './memory.ts';
import { buildSetupReviewSnapshot } from './local-setup-review.ts';
import { setupReviewLines } from '@goodvibes/engine/terminal-shell/setup-review';
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
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';


function renderSandboxHealthSummary(configManager: ConfigManager): string[] {
  return renderSandboxDoctor(configManager).split('\n').slice(1);
}

function maintenanceOf(ctx: CommandContext) {
  const session = requireReadModels(ctx).session.getSnapshot();
  const providerRegistry = ctx.provider.providerRegistry;
  const llmMessages =
    typeof ctx.session.conversationManager.getMessagesForLLM === 'function' ? ctx.session.conversationManager.getMessagesForLLM() : [];
  // Resolve the context window the same way Money, Spending does so the
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
 * The short status (the System place, Health, "See what needs attention"): one line when everything works, or
 * each thing that does not with the command that fixes it. Reads the same
 * snapshots the area checks read; no model request, no daemon write.
 */
async function healthReport(ctx: CommandContext): Promise<CommandReport> {
  const readModels = requireReadModels(ctx);
  const snapshot = await buildSetupReviewSnapshot(ctx);
  const accounts = await requireOperatorClient(ctx).providers.accountSnapshot();
  const settings = readModels.settings.getSnapshot();
  const items: { sentence: string; fix?: { label: string; line: string } }[] = [];
  // What fixes each is a control in a place, not a line to type.
  const placeFor: Readonly<Record<string, string>> = {
    plugins: ' The Plugins tab of Tools and extensions shows each one and why.',
    providers: ' Sign in on the Providers tab of Models and providers (s on the provider).',
    services: ' The Services tab of Models and providers checks each one; in System, Health, "check one area" reads Services again.',
    mcp: ' The Servers tab of Tools and extensions shows which servers need attention and how to fix each.',
  };
  for (const check of snapshot.checks.filter(isSetupIssue)) {
    items.push({ sentence: `${check.area}: ${check.message}.${placeFor[check.area] ?? ''}` });
  }
  for (const provider of accounts.providers) {
    // What fixes it is a control on the provider in Models and providers ("how to fix it"), not a line to type.
    for (const issue of provider.issues) items.push({ sentence: `${provider.providerId}: ${issue}. In Models and providers, the provider's "how to fix it" says what fixes it.` });
  }
  for (const issue of collectSettingsHealthIssues(settings, 'a staged managed bundle is waiting to be applied or rolled back')) {
    // What settles it is the Settings sync tab of the Devices and network place, not a line to type.
    items.push({ sentence: `Settings: ${issue}. The Devices and network place's Settings sync tab lists the settings that disagree.` });
  }
  if (readModels.localAuth.getSnapshot().bootstrapCredentialPresent) {
    // What removes it is "Remove the first-run sign-in file" in the System place, not a line to type.
    items.push({ sentence: 'The first-run sign-in file is still on disk. Once you have signed in, "Remove the first-run sign-in file" in System removes it.' });
  }
  const mcp = readModels.mcp.getSnapshot();
  for (const issue of collectMcpLifecycleIssues(mcp.servers, (id, kind, value) => `${id}: ${kind === 'error' ? value : `${kind} ${value}`}`)) {
    items.push({ sentence: `MCP server ${issue}.`, fix: { label: 'See which servers need attention', line: '/mcp review' } });
  }
  // The remote runners are the daemon's: read there, and said when they could not be read.
  const remote = await readRemoteRunnersHealth(ctx, capabilityBinding);
  if (remote.unreadable) items.push({ sentence: `Could not read the remote runners: ${remote.unreadable}.`, fix: { label: 'See the remote runners in the Work place', line: '/work' } });
  for (const issue of remote.issues) {
    items.push({ sentence: `Remote runner ${issue}.`, fix: { label: 'See the remote runners in the Work place', line: '/work' } });
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
      if (ctx.openPlace && ctx.invokedByModel !== true) {
        ctx.openPlace('models', { list: 'providers' });
        return 'Opened Models and providers: each provider, how it is signed in and how it is reached.';
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
        `  first-run sign-in file: ${auth.bootstrapCredentialPresent ? 'present (remove it with "Remove the first-run sign-in file" in System once you have signed in)' : 'removed'}`,
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
      const remote = await readRemoteRunnersHealth(ctx, capabilityBinding, (id, kind, value) => id + ': ' + (kind === 'error' ? value : kind + '=' + value));
      if (remote.unreadable) return ['Remote runners', `  Could not read them: ${remote.unreadable}.`].join('\n');
      return [
        'Remote runners (the daemon\'s)',
        `  supervised: ${remote.supervised}`,
        `  connections open now: ${remote.connections}`,
        `  degraded: ${remote.degraded}`,
        ...(remote.issues.length > 0 ? remote.issues.map((issue) => `  issue: ${issue}`) : ['  no runner needs recovering']),
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
        lines.push('  quota: no provider in use (name one in the Provider blank of "Check one area").');
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
        ...(summary.paused > 0 ? [`  issue: ${summary.paused} paused worktree(s) may need resume or merge review (Code and changes, Worktrees)`] : ['  no active worktree lifecycle issues detected']),
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
      throw commandRefusal('The asks waiting for you are listed in Waiting for you in this program; nothing was checked.', 'Open Waiting for you from the menu.');
  }
}

/** The failure report an id (or `latest`) names. */
function failureReport(ctx: CommandContext, id: string) {
  const registry = ctx.extensions.forensicsRegistry;
  if (!registry) throw commandRefusal('Failure reports are not recorded in this session.');
  const report = id === 'latest' ? registry.latest() : registry.getById(id);
  if (!report) throw commandRefusal(id === 'latest' ? 'No failure report was recorded this session.' : `No failure report is ${id}.`, 'This session\'s failures, on the Health tab of System, lists them.');
  return { registry, report };
}

function showFailure(ctx: CommandContext, id: string, view: FailureReportView): string {
  const { registry, report } = failureReport(ctx, id);
  if (view === 'json') return registry.exportAsJson(report.id) ?? `The report ${report.id} could not be written as JSON.`;
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
    throw commandRefusal(`${targetPath} already exists; nothing was written.`, 'Choose another file, or choose to replace it.');
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


/** This app's health, as the `health.*` capabilities read it (session-capabilities.ts binds it with `healthServicesOf`). */
export const healthPolicy: HealthCommandPolicy<CommandContext> = {
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
    elsewhere: 'the Agent (goodvibes-agent)',
};
