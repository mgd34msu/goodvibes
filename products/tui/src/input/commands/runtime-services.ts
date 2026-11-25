import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import {
  createCommandServiceAccessors,
  createCommandPathAccessors,
  requireContextValue,
} from '@goodvibes/engine/terminal-shell/command-service-access';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
export { requireShellPaths, requirePluginPathOptions } from '@goodvibes/engine/terminal-shell/command-service-access';
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
export const { requireEcosystemCatalogPaths } = createCommandPathAccessors(GOODVIBES_TUI_SURFACE_ROOT);
import type { CommandContext } from '../command-registry.ts';
import { compactSmallWindow, getLastCompactionEvent, NOTHING_TO_COMPACT_YET, NothingToCompactError, recordSmallWindowCompaction, SMALL_WINDOW_KEEP_RECENT, SMALL_WINDOW_THRESHOLD } from '@goodvibes/engine/platform/platform/core';
import type { CompactionContext, CompactionEvent } from '@goodvibes/engine/platform/platform/core';
import { recordCompactionQualityScore } from '../../renderer/compaction-quality.ts';
import type { CompactionQualityScore } from '../../renderer/compaction-quality.ts';

import type { SessionSurface } from '@/runtime/index.ts';



import type { KnowledgeApi } from '@goodvibes/engine/platform/platform/knowledge';



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
): Promise<import('../onboarding/onboarding-wizard.ts').OnboardingFormOutcome> | void {
  const openWizard = requireContextValue(context.openOnboardingWizard, 'openOnboardingWizard');
  return openWizard(modeOrOptions);
}

/**
 * What a manual /compact did: summarised the conversation (the platform's
 * CompactionEvent and the quality score when one was computed), dropped the
 * oldest messages without a summary (small-window models), or nothing.
 */
export type CompactionRunResult =
  | { readonly kind: 'summarised'; readonly event: CompactionEvent; readonly qualityScore: CompactionQualityScore | null }
  | { readonly kind: 'dropped'; readonly event: CompactionEvent; readonly dropped: number; readonly kept: number }
  | { readonly kind: 'unchanged'; readonly reason: string };

/** Manual /compact refused because it would rewrite the transcript under a running turn. */
export class CompactBusyError extends Error {
  constructor() {
    super('A turn is still running. Stop it with Esc or let it finish, then /compact.');
    this.name = 'CompactBusyError';
  }
}

/** Compact the conversation and say what happened (see CompactionRunResult). */
export async function compactConversation(context: CommandContext): Promise<CompactionRunResult> {
  const conversationManager = context.session.conversationManager;
  const providerRegistry = context.provider.providerRegistry;
  // Resolve the live context window for the current model so manual /compact
  // matches the auto-compaction path (which scales behaviour by window size)
  // instead of passing a meaningless 0.
  // 0 when the window is unknown (a guess, or disproven by a larger accepted
  // request): an unknown window is never treated as a small one.
  const contextWindow = providerRegistry.getKnownContextWindowForModel(providerRegistry.getCurrentModel()) ?? 0;

  // Small-window models lack room for the structured (multi-LLM) extraction
  // pipeline, so mirror the platform auto-compaction path and degrade to the
  // simplified "keep the most recent messages" compaction.
  if (contextWindow > 0 && contextWindow < SMALL_WINDOW_THRESHOLD) {
    // This branch replaces the transcript in place, so a running turn would lose what it appends.
    if (context.isGenerating?.()) throw new CompactBusyError();
    const before = conversationManager.getMessagesForLLM();
    if (before.length <= SMALL_WINDOW_KEEP_RECENT) {
      return { kind: 'unchanged', reason: `the conversation has ${before.length} message(s), and this model's small window keeps the last ${SMALL_WINDOW_KEEP_RECENT} as they are` };
    }
    const compacted = compactSmallWindow(before, SMALL_WINDOW_KEEP_RECENT);
    conversationManager.replaceMessagesForLLM(compacted);
    const event = recordSmallWindowCompaction(before, compacted, {
      modelId: context.session.runtime.model,
      trigger: 'manual',
      sessionId: context.session.runtime.sessionId,
    });
    context.session.sessionLineageTracker?.addCompactionEntry(`small window: dropped ${before.length - SMALL_WINDOW_KEEP_RECENT} earlier message(s) without a summary`);
    return { kind: 'dropped', event, dropped: before.length - SMALL_WINDOW_KEEP_RECENT, kept: SMALL_WINDOW_KEEP_RECENT };
  }

  // The event log is shared by every session in the process: read this session's own events.
  const sessionId = context.session.runtime.sessionId;
  const eventBefore = getLastCompactionEvent(sessionId);
  const messagesBefore = conversationManager.getMessagesForLLM();
  const sessionMemories = context.session.sessionMemoryStore?.list() ?? [];
  const lineageTracker = context.session.sessionLineageTracker;
  const agentManager = context.ops.agentManager;
  const planManager = context.ops.planManager;
  const compactionCtx: CompactionContext = {
    messages: messagesBefore,
    sessionId,
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
    // A dedicated helper route writes the summary when one is configured, as in an automatic compaction.
    helperModel: context.clients?.providerApi?.helperModel,
  };
  const receipt = await conversationManager.compact(
    providerRegistry,
    context.session.runtime.model,
    'manual',
    context.session.runtime.provider,
    compactionCtx,
  );
  const eventAfter = getLastCompactionEvent(sessionId);
  if (eventAfter !== null && eventAfter !== eventBefore) {
    // The compaction scored itself before it was applied; the receipt carries
    // that score, kept by this event's timestamp for /session compactions.
    const qualityScore = receipt?.quality ?? null;
    if (qualityScore) recordCompactionQualityScore(eventAfter.timestamp, qualityScore);
    return { kind: 'summarised', event: eventAfter, qualityScore };
  }
  if (receipt === undefined) throw new NothingToCompactError(NOTHING_TO_COMPACT_YET);
  return { kind: 'unchanged', reason: 'no compaction was recorded, so the conversation is as it was' };
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

export function requireVoiceSetup(context: CommandContext) {
  return requireContextValue(context.platform.voiceSetup, 'platform.voiceSetup');
}

export function requireWorktreeRegistry(context: CommandContext) {
  return requireContextValue(context.workspace.worktreeRegistry, 'workspace.worktreeRegistry');
}
