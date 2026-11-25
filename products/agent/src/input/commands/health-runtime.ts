import {
  collectServiceReadiness,
  collectSettingsHealthIssues,
  collectMcpLifecycleIssues,
  collectContinuityIssues,
  formatHealthStatusValue,
} from '@goodvibes/engine/terminal-shell/health-findings';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines } from '@/runtime/index.ts';
import { estimateConversationTokens } from '@goodvibes/engine/platform/platform/core';
import { formatDoctorReport } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { CommandContext } from '../command-registry.ts';
import { readRemoteRunnersHealth, type HealthArea, type HealthCommandPolicy } from '@goodvibes/engine/terminal-shell/health-command';
import { capabilityBinding } from './capability-binding.ts';
import type { CommandReport } from '@goodvibes/engine/terminal-shell/command-actions';
import { isSetupIssue } from '@goodvibes/engine/terminal-shell/setup-review';
import { formatRuntimeStateSnapshot, snapshotRuntimeState } from '@/runtime/index.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { handleCompatCommand } from '../../cli/agent-knowledge-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { requireShellPaths } from './runtime-services.ts';
import { refuseCliParseErrors } from './cli-command-output.ts';
import { buildSetupReviewSnapshot } from './local-setup-review.ts';
import { setupReviewLines } from '@goodvibes/engine/terminal-shell/setup-review';
import { describeApprovalsUnavailable } from '../../runtime/client/approvals-view.ts';
import { isOpenApprovalStatus } from '@goodvibes/engine/platform/platform/control-plane';
import { buildProviderAccountSnapshot } from '@/runtime/index.ts';
import {
  requireMemoryGovernor,
  requireProvider,
  requireProviderApi,
  requireReadModels,
  requireServiceRegistry,
  requireSubscriptionManager,
  requireSessionMemoryStore,
} from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';

async function loadProviderAccountSnapshot(ctx: CommandContext) {
  return await buildProviderAccountSnapshot({
    providerRegistry: requireProvider(ctx).providerRegistry,
    serviceRegistry: requireServiceRegistry(ctx),
    subscriptionManager: requireSubscriptionManager(ctx),
    // Without a store only the environment is read.
    secretsManager: ctx.platform.secretsManager ?? { get: async () => null },
  });
}

/**
 * "Approvals waiting" (the System place, Health, "Check one area"), the asks waiting for this owner, from the daemon's
 * record unioned with whatever this process still holds.
 *
 * Written so an unreachable host and an empty list can never print the same
 * thing. When the daemon's record was not read, the reason is the FIRST line,
 * before any rows, and the rows that follow are labelled as this process's
 * own, a person scanning the output sees the caveat before the list, not
 * after it.
 */
async function renderApprovalsHealth(ctx: CommandContext): Promise<string> {
  const view = ctx.ops.approvalsView;
  if (!view) {
    return [
      'Approvals waiting',
      '  the approvals view is not wired in this runtime, so no list can be shown.',
      '  This is not "no approvals waiting", nothing was read.',
    ].join('\n');
  }

  const snapshot = await view.refresh();
  const unavailable = describeApprovalsUnavailable(snapshot);
  const pending = snapshot.approvals.filter((approval) => isOpenApprovalStatus(approval.status));

  const rows = pending.map((approval) => {
    const tool = typeof approval.request?.tool === 'string' && approval.request.tool.length > 0 ? approval.request.tool : 'unnamed tool';
    const session = approval.sessionId ? ` session ${approval.sessionId}` : '';
    return `  ${approval.status} ${tool}${session} (${approval.id})`;
  });

  return [
    'Approvals waiting',
    ...(unavailable === null ? [] : [`  ${unavailable}`]),
    `  source ${snapshot.hostRecordRead ? 'connected host record + this process' : 'this process only'}`,
    // How current the list is, which is a different claim from where it came
    // from: on the push channel a transition is here the moment the daemon
    // records it; without it the list is as fresh as the last re-read.
    `  updates ${snapshot.liveUpdates ? 'live from the connected host' : 'periodic re-read (no live stream)'}`,
    `  waiting ${pending.length}`,
    `  raised in this process and not on the host ${snapshot.localOnlyCount}`,
    ...(rows.length > 0
      ? rows
      : [
          snapshot.hostRecordRead
            ? '  nothing is waiting on the connected host or in this process'
            : '  nothing is waiting in this process; the host was not read, so it may still hold asks',
        ]),
  ].join('\n');
}

function maintenanceOf(ctx: CommandContext) {
  const session = requireReadModels(ctx).session.getSnapshot();
  // The known window, resolved as the footer meter and /context resolve it, so every
  // diagnostics surface shows the same usage and remaining tokens.
  const providerRegistry = requireProvider(ctx).providerRegistry;
  const llmMessages =
    typeof ctx.session.conversationManager.getMessagesForLLM === 'function' ? ctx.session.conversationManager.getMessagesForLLM() : [];
  return evaluateSessionMaintenance({
    configManager: ctx.platform.configManager,
    currentTokens: estimateConversationTokens(llmMessages),
    contextWindow: providerRegistry.getKnownContextWindowForModel(providerRegistry.getCurrentModel()) ?? 0, // 0: unknown window, no usage percentage
    messageCount: llmMessages.length,
    sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
    session: session.session,
  });
}

/**
 * The short status (the System place, Health, "See what needs attention"): one line when everything works, or
 * each thing that does not with the command that fixes it. Reads the same
 * snapshots the area checks read; no model request, no host write.
 */
async function healthReport(ctx: CommandContext): Promise<CommandReport> {
  const readModels = requireReadModels(ctx);
  const snapshot = await buildSetupReviewSnapshot(ctx);
  const accounts = await loadProviderAccountSnapshot(ctx);
  const items: { sentence: string; fix?: { label: string; line: string } }[] = [];
  const fixFor: Readonly<Record<string, { label: string; line: string }>> = {
    providers: { label: 'Sign in to a provider', line: '/setup sign-in' },
    integrations: { label: 'In System, Health, check one area: Services', line: '/setup' },
    mcp: { label: 'See which servers need attention', line: '/mcp review' },
  };
  for (const check of snapshot.checks.filter(isSetupIssue)) {
    items.push({ sentence: `${check.area}: ${check.message}.`, ...(fixFor[check.area] ? { fix: fixFor[check.area] } : {}) });
  }
  for (const provider of accounts.providers) {
    // What fixes it is a control on the provider in Models and providers ("how to fix it"), not a line to type.
    for (const issue of provider.issues) items.push({ sentence: `${provider.providerId}: ${issue}. In Models and providers, the provider's "how to fix it" says what fixes it.` });
  }
  for (const issue of collectSettingsHealthIssues(readModels.settings.getSnapshot(), 'a pending managed settings bundle is waiting to be applied or rolled back')) {
    items.push({ sentence: `Settings: ${issue}.`, fix: { label: 'See the setting', line: '/settings open' } });
  }
  const mcp = readModels.mcp.getSnapshot();
  for (const issue of collectMcpLifecycleIssues(mcp.servers, (id, kind, value) => `${id}: ${kind === 'error' ? value : `${kind === 'schema' ? 'tool-definition review' : kind} ${formatHealthStatusValue(value)}`}`)) {
    items.push({ sentence: `MCP server ${issue}.`, fix: { label: 'See which servers need attention', line: '/mcp review' } });
  }
  const maintenance = maintenanceOf(ctx);
  if (maintenance.compactRecommended) items.push({ sentence: `The conversation fills the context window: ${maintenance.summary}`, fix: { label: 'Compact it', line: '/compact' } });
  if (items.length === 0) return { verdict: 'ok', headline: 'Everything is working.', items: [] };
  return { verdict: 'attention', headline: `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} attention:`, items };
}

/** One area in detail, for "Check one area". */
async function checkArea(ctx: CommandContext, area: HealthArea): Promise<string> {
  switch (area) {
    case 'provider': {
      const providerApi = requireProviderApi(ctx);
      const currentModel = await providerApi.getCurrentModel().catch(() => null);
      const accounts = await loadProviderAccountSnapshot(ctx);
      return [
        'Model providers',
        `  selected model ${currentModel?.registryKey ?? 'unknown'}`,
        `  providers ${providerApi.listProviderIds().length}`,
        `  configured accounts ${accounts.configuredCount}`,
        `  account issues ${accounts.issueCount}`,
        ...(accounts.issueCount > 0
          ? accounts.providers.flatMap((provider) => provider.issues.map((issue) => `  ${provider.providerId} ${issue}`))
          : ['  no provider account issues detected']),
      ].join('\n');
    }
    case 'approvals':
      return renderApprovalsHealth(ctx);
    case 'services': {
      const { configured, issues } = await collectServiceReadiness(requireServiceRegistry(ctx), ' ');
      return [
        'Connected host integrations',
        `  configured integrations ${configured}`,
        `  issues ${issues.length}`,
        ...(issues.length > 0 ? issues.map((issue) => `  ${issue}`) : ['  all configured host integrations passed readiness checks']),
      ].join('\n');
    }
    case 'accounts': {
      const accounts = await loadProviderAccountSnapshot(ctx);
      return [
        'Provider accounts',
        `  providers ${accounts.providers.length}`,
        `  configured ${accounts.configuredCount}`,
        `  issues ${accounts.issueCount}`,
        ...accounts.providers.flatMap((provider) => [
          ...provider.issues.map((issue) => `  ${provider.providerId} ${issue}`),
          ...(provider.fallbackRisk ? [`  ${provider.providerId} ${provider.fallbackRisk}`] : []),
        ]),
      ].join('\n');
    }
    case 'auth': {
      const auth = requireReadModels(ctx).localAuth.getSnapshot();
      return [
        'Connected host sign-in',
        `  users visible ${auth.userCount}`,
        `  sessions visible ${auth.sessionCount}`,
        `  first-run sign-in file ${auth.bootstrapCredentialPresent ? 'present (remove it with "Remove the first-run sign-in file" in System)' : 'removed'}`,
        '  The Agent reads the host\'s sign-in; its users and first-run file are changed on the host.',
      ].join('\n');
    }
    case 'settings': {
      const settings = requireReadModels(ctx).settings.getSnapshot();
      const issues = collectSettingsHealthIssues(settings, 'pending managed settings bundle is awaiting apply or rollback');
      return [
        'Settings',
        `  available ${settings.available ? 'yes' : 'no'}`,
        `  managed locks ${settings.managedLockCount}`,
        `  conflicts ${settings.conflictCount}`,
        `  recent failures ${settings.recentFailureCount}`,
        `  pending managed bundle ${settings.hasStagedManagedBundle ? 'present' : 'none'}`,
        ...(issues.length > 0 ? issues.map((issue) => `  issue ${issue}`) : ['  no active settings-control issues detected']),
      ].join('\n');
    }
    case 'remote': {
      // The remote runners are the daemon's: read there, and said when they could not be read.
      const remote = await readRemoteRunnersHealth(ctx, capabilityBinding,
        (id, kind, value) => id + ' ' + (kind === 'error' ? value : kind + ' ' + formatHealthStatusValue(value)));
      if (remote.unreadable) return ['Remote runners', `  Could not read them: ${remote.unreadable}.`].join('\n');
      return [
        'Remote runners (the daemon\'s)',
        `  supervised ${remote.supervised}`,
        `  connections open now ${remote.connections}`,
        `  degraded ${remote.degraded}`,
        ...(remote.issues.length > 0 ? remote.issues.map((issue) => `  issue ${issue}`) : ['  no runner needs recovering']),
        '  They are started, stopped and recovered on the Runners tab of the Work place.',
      ].join('\n');
    }
    case 'memory': {
      // Live MemoryGovernor snapshot, the same data ops.memory.get serves.
      let snapshot: ReturnType<ReturnType<typeof requireMemoryGovernor>['snapshot']>;
      try {
        snapshot = requireMemoryGovernor(ctx).snapshot();
      } catch {
        throw commandRefusal('No memory governor runs in this program, so there is no memory reading.');
      }
      return [
        'Memory use',
        `  tier ${snapshot.tier}`,
        `  rss ${snapshot.rssMb} MB of ${snapshot.budgetMb} MB budget (${snapshot.usedPct}%)`,
        `  heap used ${snapshot.heapUsedMb} MB${snapshot.heapTotalMb !== undefined ? ` of ${snapshot.heapTotalMb} MB` : ''}`,
        `  expensive work ${snapshot.refusingExpensiveWork ? 'refused (critical pressure)' : 'admitted'}`,
        `  tier thresholds ${snapshot.thresholds.elevatedPct}% elevated, ${snapshot.thresholds.highPct}% high, ${snapshot.thresholds.criticalPct}% critical`,
        `  leak tripwire ${snapshot.tripwire.armed ? `ARMED (${snapshot.tripwire.rateMbPerSec} MB/s sustained ${snapshot.tripwire.sustainedSec}s)` : 'not armed'}`,
        `  caches ${snapshot.caches.length}`,
        ...snapshot.caches.map(
          (cache) => `    ${cache.id} ${cache.entries} entries${cache.estimatedBytes !== undefined ? ` (~${Math.round(cache.estimatedBytes / 1024)} KiB)` : ''}, ${cache.name}`,
        ),
        `  paused background jobs ${snapshot.pausedJobs.length === 0 ? 'none' : snapshot.pausedJobs.join(', ')}`,
        '  The budget is the setting memory.budgetMb (/settings open memory.budgetMb).',
      ].join('\n');
    }
    case 'mcp': {
      const mcp = requireReadModels(ctx).mcp.getSnapshot();
      const issues = collectMcpLifecycleIssues(
        mcp.servers,
        (id, kind, value) => id + ' ' + (kind === 'error' ? value : (kind === 'schema' ? 'tool-definition review' : kind) + ' ' + formatHealthStatusValue(value)),
      );
      return [
        'MCP servers',
        `  servers ${mcp.servers.length}`,
        `  connected ${mcp.connectedServerNames.length}`,
        `  tools ${mcp.availableToolCount}`,
        `  connection failures ${mcp.totalErrors}`,
        ...(issues.length > 0 ? issues.map((issue) => `  issue ${issue}`) : ['  no active MCP lifecycle issues detected']),
      ].join('\n');
    }
    case 'continuity': {
      const continuity = requireReadModels(ctx).continuity.getSnapshot();
      const returnMode = String(ctx.platform.configManager.get('behavior.returnContextMode') ?? 'off');
      const issues = collectContinuityIssues(continuity, returnMode);
      return [
        'Picking up where you left off',
        `  return context mode ${returnMode}`,
        `  last session pointer ${continuity.lastSessionPointer ?? 'none'}`,
        `  recovery file ${continuity.recoveryFilePresent ? 'present' : 'clear'}`,
        ...(continuity.returnContext
          ? [`  recovery activity ${continuity.returnContext.activityLabel}`, `  recovery status ${continuity.returnContext.statusLabel}`]
          : []),
        ...(issues.length > 0 ? issues.map((issue) => `  issue ${issue}`) : ['  no active session continuity issues detected']),
      ].join('\n');
    }
    case 'maintenance':
      return ['Conversation size', ...formatSessionMaintenanceLines(maintenanceOf(ctx), 'guided')].join('\n');
    case 'setup': {
      const snapshot = await buildSetupReviewSnapshot(ctx);
      return [
        'Setup',
        ...setupReviewLines(snapshot.checks, ' '),
        ...(snapshot.hostIntegrationIssues.length > 0
          ? ['', '  Connected host integration issues', ...snapshot.hostIntegrationIssues.map((issue) => `    - ${issue}`)]
          : []),
      ].join('\n');
    }
    case 'intelligence':
    case 'metrics':
    case 'worktrees':
    case 'sandbox':
    case 'terminal':
      throw commandRefusal(`The Agent does not check ${area}; nothing was checked.`, `It is checked in the terminal app: the System place, Health, "Check one area".`);
  }
}

/** This Agent's health, as the `health.*` capabilities read it (session-capabilities.ts binds it with `healthServicesOf`). */
export const healthPolicy: HealthCommandPolicy<CommandContext> = {
    report: healthReport,
    check: (ctx, area) => checkArea(ctx, area),
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
    async compat(ctx, json) {
      const cli = parseGoodVibesCli(['compat', ...(json ? ['--json'] : [])], 'goodvibes-agent');
      refuseCliParseErrors(cli.errors);
      const shellPaths = requireShellPaths(ctx);
      const runtime: CliCommandRuntime = {
        cli,
        configManager: ctx.platform.configManager,
        workingDirectory: shellPaths.workingDirectory,
        homeDirectory: shellPaths.homeDirectory,
      };
      const result = await handleCompatCommand(runtime);
      if (result.exitCode !== 0) throw commandRefusal(result.output, undefined, 'COMMAND_FAILED');
      return result.output;
    },
    elsewhere: 'the terminal app (goodvibes)',
};
