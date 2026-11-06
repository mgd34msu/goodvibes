import {
  createCommandServiceAccessors,
  createCommandPathAccessors,
  requireContextValue,
} from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
export { requireShellPaths, requirePluginPathOptions } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
export const {
  requireSession,
  requireProvider,
  requireWorkspace,
  requirePlatform,
  requireOps,
  requireExtensions,
  requireReadModels,
  requireKeybindingsManager,
  requireProfileManager,
  requireBookmarkManager,
  requireSessionManager,
  requireSecretsManager,
  requireSubscriptionManager,
  requireServiceRegistry,
  requireLocalUserAuthManager,
  requireTokenAuditor,
  requireReplayEngine,
  requireWebhookNotifier,
  requireSessionMemoryStore,
  requireSessionLineageTracker,
  requireSessionChangeTracker,
  requirePlanManager,
  requireAdaptivePlanner,
  requireSessionOrchestration,
  requireForensicsRegistry,
  requirePluginManager,
  requirePolicyRuntimeState,
  requireMcpRegistry,
  requireToolRegistry,
  requireHookWorkbench,
  requireIntegrationHelpers,
  requireProviderOptimizer,
  requireFavoritesStore,
  requireBenchmarkStore,
  requireRemoteRuntime,
  requireOperatorClient,
  requirePeerClient,
  requireProviderApi,
  requireHookApi,
  requireMcpApi,
  requireDirectTransport,
  requireAgentManager,
  requireModeManager,
  requireAutomationManager,
} = createCommandServiceAccessors<CommandContext>();
export const { requireEcosystemCatalogPaths } = createCommandPathAccessors('tui');
import type { CommandContext } from '../command-registry.ts';
import { compactSmallWindow, getLastCompactionEvent, SMALL_WINDOW_THRESHOLD } from '@goodvibes-jev/engine/sdk/platform/core';
import type { CompactionContext, CompactionEvent } from '@goodvibes-jev/engine/sdk/platform/core';
import { recordCompactionQualityScore, scoreCompactionRun } from '../../renderer/compaction-quality.ts';
import type { CompactionQualityScore } from '../../renderer/compaction-quality.ts';

import type { SessionSurface } from '@/runtime/index.ts';



import type { KnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';



import type { OpsApi } from '@/runtime/index.ts';


import type { ShellAcpManagerService } from '@/runtime/index.ts';

/**
 * The runtime's declare-once session-storage handle. Commands that touch
 * session state take their paths from here rather than rebuilding a scope out
 * of shellPaths, so a command and the runtime that wrote the file always agree
 * on where it lives.
 */
export function requireSurface(context: Pick<CommandContext, 'workspace'>): SessionSurface {
  return requireContextValue(context.workspace.surface, 'workspace.surface');
}

/**
 * Open the modal that holds a view, by its current or old name (views.ts):
 * 'fleet' and 'worktrees' open Agents, 'cost' opens Usage, and so on.
 */
export function openCommandView(context: Pick<CommandContext, 'openView' | 'print'>, name: string): void {
  const openView = requireContextValue(context.openView, 'openView');
  if (!openView(name)) context.print(`Nothing holds "${name}" in this build.`);
}

/**
 * Open a config-modal surface by name via the ctx.openModal seam (ui-openers
 * wires it). Stubbed in tests by setting ctx.openModal.
 */
export function openModalCommand(context: Pick<CommandContext, 'openModal'>, modalName: string): void {
  const openModal = requireContextValue(context.openModal, 'openModal');
  openModal(modalName);
}

export function openOnboardingWizard(
  context: Pick<CommandContext, 'openOnboardingWizard'>,
  modeOrOptions?:
    | import('../onboarding/onboarding-wizard.ts').OnboardingWizardMode
    | import('../handler-ui-state.ts').OpenOnboardingWizardOptions,
): void {
  const openWizard = requireContextValue(context.openOnboardingWizard, 'openOnboardingWizard');
  openWizard(modeOrOptions);
}

/** Result of a manual /compact run: the SDK's CompactionEvent, plus an
 * out-of-band quality score () when one could be computed. */
export interface CompactionRunResult {
  readonly event: CompactionEvent;
  readonly qualityScore: CompactionQualityScore | null;
}

/**
 * Compact the conversation and return the CompactionEvent recorded by the SDK
 * (plus an out-of-band quality score), or null if no event was recorded (e.g.
 * compaction was skipped or produced no change).
 */
export async function compactConversation(context: CommandContext): Promise<CompactionRunResult | null> {
  const conversationManager = context.session.conversationManager;
  const providerRegistry = context.provider.providerRegistry;
  // Resolve the live context window for the current model so manual /compact
  // matches the auto-compaction path (which scales behaviour by window size)
  // instead of passing a meaningless 0.
  // 0 when the window is unknown (a guess, or disproven by a larger accepted
  // request): an unknown window is never treated as a small one.
  const contextWindow = providerRegistry.getKnownContextWindowForModel(providerRegistry.getCurrentModel()) ?? 0;

  // Small-window models lack room for the structured (multi-LLM) extraction
  // pipeline, so mirror the SDK auto-compaction path and degrade to the
  // simplified "keep the most recent messages" compaction.
  if (contextWindow > 0 && contextWindow < SMALL_WINDOW_THRESHOLD) {
    const compacted = compactSmallWindow(conversationManager.getMessagesForLLM(), 10);
    conversationManager.replaceMessagesForLLM(compacted);
    return null;
  }

  const eventBefore = getLastCompactionEvent();
  const messagesBefore = conversationManager.getMessagesForLLM();
  const sessionMemories = context.session.sessionMemoryStore?.list() ?? [];
  const lineageTracker = context.session.sessionLineageTracker;
  const agentManager = context.ops.agentManager;
  const planManager = context.ops.planManager;
  const compactionCtx: CompactionContext = {
    messages: messagesBefore,
    sessionMemories,
    // Mirror buildAutoCompactionContext: pass ALL agent records (not just
    // running/pending) so completed/failed subagent work reaches the
    // "Completed Agent Work" / "Currently Running" compaction sections, plus
    // the active execution plan and the session-lineage log so the handoff
    // summary and lineage section are populated correctly (not "compaction #0").
    agents: agentManager?.exportState() ?? [],
    // Include this session's contracts, including terminal work, so the
    // compaction summary can preserve their actual outcomes.
    contracts: context.session.contractRunner?.list({ sessionId: context.session.runtime.sessionId, includeTerminal: true }) ?? [],
    activePlan: planManager?.getActive(context.session.runtime.sessionId) ?? null,
    lineageEntries: lineageTracker?.getEntries() ?? [],
    compactionCount: lineageTracker?.getCompactionCount() ?? 0,
    // Mirror buildAutoCompactionContext: pass the recorded original task so
    // the "Original task" lineage line reflects the session's actual first
    // task instead of falling back to the current message on every manual
    // compaction after the first.
    originalTask: lineageTracker?.getOriginalTask() ?? undefined,
    contextWindow,
    trigger: 'manual',
    extractionModelId: context.session.runtime.model,
    extractionProvider: context.session.runtime.provider,
  };
  await conversationManager.compact(
    providerRegistry,
    context.session.runtime.model,
    'manual',
    context.session.runtime.provider,
    compactionCtx,
  );
  const eventAfter = getLastCompactionEvent();
  if (eventAfter !== null && eventAfter !== eventBefore) {
    //: score this run out-of-band (see compaction-quality.ts for why
    // this can't just subscribe to the SDK's own CompactionManager pipeline)
    // and keep the score keyed by this event's timestamp for /compact-history.
    const qualityScore = await scoreCompactionRun({
      sessionId: context.session.runtime.sessionId,
      contextWindow,
      messagesBefore,
      messagesAfter: conversationManager.getMessagesForLLM(),
      tokensBefore: eventAfter.tokensBeforeEstimate,
      tokensAfter: eventAfter.tokensAfterEstimate,
    });
    recordCompactionQualityScore(eventAfter.timestamp, qualityScore);
    return { event: eventAfter, qualityScore };
  }
  return null;
}

export function requireKnowledgeApi(context: CommandContext): KnowledgeApi {
  return requireContextValue(context.clients?.knowledgeApi, 'clients.knowledgeApi');
}

export function requireOpsApi(context: CommandContext): OpsApi {
  return requireContextValue(context.clients?.opsApi, 'clients.opsApi');
}

export function requireAcpManager(context: CommandContext): ShellAcpManagerService {
  return requireContextValue(context.ops.acpManager, 'ops.acpManager') as ShellAcpManagerService;
}

export function requireSandboxSessionRegistry(context: CommandContext) {
  return requireContextValue(context.workspace.sandboxSessionRegistry, 'workspace.sandboxSessionRegistry');
}

export function requireWorktreeRegistry(context: CommandContext) {
  return requireContextValue(context.workspace.worktreeRegistry, 'workspace.worktreeRegistry');
}
