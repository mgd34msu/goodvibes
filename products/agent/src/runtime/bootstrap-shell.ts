import { configuredSystemMessageTarget } from '@goodvibes-jev/engine/terminal-shell/system-message-router';
import { projectBootstrapShellCommandOptions } from '@goodvibes-jev/engine/terminal-shell/bootstrap-command-context';
import { join } from 'node:path';
import type { ConversationManager } from '../core/conversation';
import type { Orchestrator } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { RuntimeStore } from './store/index.ts';
import type { RuntimeServices } from './services.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { AgentPromptContextReceiptStore } from '../agent/prompt-context-receipts.ts';
import { CommandRegistry } from '../input/command-registry.ts';
import { registerBuiltinCommands } from '../input/commands.ts';
import { InputHistory } from '../input/input-history.ts';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { ActivityFeed } from '../core/activity-feed.ts';
import { hydrateConversationUsage } from '../core/conversation-usage.ts';
import { createSystemMessageRouter, type SystemMessageRouter } from '../core/system-message-router.ts';
import { getConfigSnapshot } from '../config/index.ts';
import { createBootstrapCommandContext } from './bootstrap-command-context.ts';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { loadBootstrapSystemPrompt } from '@/runtime/index.ts';
import { createShellPlanRuntime, createShellRemoteCommandService } from '@/runtime/index.ts';
import { createRuntimeFoundationClients } from '@/runtime/index.ts';
import type { ControlPlaneRecentEvent } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { TaskManager } from '@/runtime/index.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { createKnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';

export interface BootstrapShellState {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly inputHistory: InputHistory;
  readonly systemMessageRouter: SystemMessageRouter;
}

export interface BootstrapShellOptions {
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly services: RuntimeServices;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly orchestrator: Orchestrator;
  readonly requestRender: () => void;
  readonly permissionPromptRef: { requestPermission: PermissionRequestHandler };
  readonly onSessionIdChanged: (sessionId: string) => void;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly restoreTurnAnchors: (sessionId: string) => number;
  readonly getControlPlaneRecentEvents: (limit: number) => readonly ControlPlaneRecentEvent[];
  readonly toolRegistry: ToolRegistry;
  readonly promptContextReceipts?: AgentPromptContextReceiptStore;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly uiServices: UiRuntimeServices;
  readonly taskManager: TaskManager;
  readonly completeModelSelectionSideEffect?: () => void;
}

type PlanningAnswerSubmit = (answer: string) => void;

export interface PlanningAnswerSubmitBridgeOptions {
  readonly getSubmitInput: () => PlanningAnswerSubmit | undefined;
  readonly addSystemMessage: (message: string) => void;
  readonly requestRender: () => void;
  readonly defer?: (callback: () => void) => void;
}

export function submitPlanningAnswerWithShellFallback(answer: string, options: PlanningAnswerSubmitBridgeOptions): void {
  const submit = options.getSubmitInput();
  if (submit) {
    submit(answer);
    return;
  }

  const defer =
    options.defer ??
    ((callback) => {
      setTimeout(callback, 0);
    });
  defer(() => {
    const deferredSubmit = options.getSubmitInput();
    if (deferredSubmit) {
      deferredSubmit(answer);
      return;
    }

    options.addSystemMessage(
      [
        '[Planning] Could not submit the selected answer because the prompt route is not ready.',
        `Paste this answer into the prompt to continue planning: ${answer}`,
      ].join('\n'),
    );
    options.requestRender();
  });
}

export function createBootstrapShell(options: BootstrapShellOptions): BootstrapShellState {
  const {
    configManager,
    runtimeBus,
    runtimeStore,
    services,
    conversation,
    runtime,
    orchestrator,
    requestRender,
    permissionPromptRef,
    writeLastSessionPointer,
    restoreTurnAnchors,
    getControlPlaneRecentEvents,
    toolRegistry,
    promptContextReceipts,
    forensicsRegistry,
    policyRuntimeState,
    uiServices,
    taskManager,
    completeModelSelectionSideEffect,
  } = options;

  const hydrateSessionUsage = (): void => hydrateConversationUsage(conversation, orchestrator);
  // All Agent restore paths (resume, picker, recovery and rewind) replace
  // history through fromJSON. Bind once so no path can leave stale counters.
  conversation.setUsageHydrator(hydrateSessionUsage);

  const activityFeed = new ActivityFeed();

  let commandContextRef: CommandContext | null = null;

  const systemMessageRouter = createSystemMessageRouter(
    conversation,
    activityFeed,
    configuredSystemMessageTarget(() => getConfigSnapshot(configManager).ui),
  );
  orchestrator.setSystemMessageRouter(systemMessageRouter);

  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry);
  // No opsControlPlane: the Agent's product boundary keeps connected-host
  // tasks read-only (see /tasks: every mutation subcommand is blocked and
  // routed to /workplan or /delegate), so the opsApi intervention verbs
  // honestly report the control plane as unavailable.
  const foundationClients = createRuntimeFoundationClients({
    // The foundation clients read the session REGISTER (listSessions and the
    // rest), not the dispatch seam, so they get the daemon-grade view, the one
    // that names the register automation runs on.
    runtimeServices: services.asDaemonGradeView(),
    tasksReadModel: uiServices.readModels.tasks,
    taskManager,
  });
  const { directTransport, hookApi, mcpApi, opsApi, providerApi } = foundationClients;
  const agentKnowledgeApi = createKnowledgeApi(services.agentKnowledgeService, { memoryRegistry: services.memoryRegistry });
  const remoteRuntime = createShellRemoteCommandService({
    readModels: uiServices.readModels,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    runtimeStore,
  });
  const planRuntime = createShellPlanRuntime({
    adaptivePlanner: services.adaptivePlanner,
    runtimeBus,
  });

  const commandContext: CommandContext = createBootstrapCommandContext({
    ...projectBootstrapShellCommandOptions({
      configManager,
      services,
      conversation,
      runtime,
      requestRender,
      toolRegistry,
      forensicsRegistry,
      policyRuntimeState,
      uiServices,
      remoteRuntime,
      planRuntime,
      providerApi,
      directTransport,
      hookApi,
      mcpApi,
      opsApi,
      completeModelSelectionSideEffect,
      hydrateSessionUsage,
    }),
    requestPermission: (request) => permissionPromptRef.requestPermission(request),
    voiceSetup: services.voiceSetup,
    memoryGovernor: services.memoryGovernor,
    mediaProviderRegistry: services.mediaProviders,
    channelDeliveryRouter: services.channelDeliveryRouter,
    processManager: services.processManager,
    executionLedger: services.executionLedger,
    approvalsView: services.approvalsView,
    knowledgeService: services.agentKnowledgeService,
    agentKnowledgeApi,
    promptContextReceipts,
    memoryConsolidationScheduler: services.memoryConsolidationScheduler,
    loadSystemPrompt: () => loadBootstrapSystemPrompt(configManager),
    activatePlan: (_planId, task) => {
      setTimeout(() => {
        orchestrator.handleUserInput(task).catch((err) => {
          logger.debug('activatePlan handler failed', { error: summarizeError(err) });
        });
      }, 50);
    },
    writeLastSessionPointer,
    restoreTurnAnchors,
  });
  commandContextRef = commandContext;

  const saveHistory = configManager.get('behavior.saveHistory') as boolean;
  const inputHistory = new InputHistory({
    historyPath: services.shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'input-history.json'),
    persist: saveHistory,
  });

  return {
    commandRegistry,
    commandContext,
    inputHistory,
    systemMessageRouter,
  };
}
