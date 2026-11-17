/**
 * hosted-turn.ts, the Agent's turn in a session the daemon hosts for it
 * (`originSurface: 'agent'`): the Agent's own prompt and the Agent tools that
 * need no terminal, given to the hosted-session engine as its surface turn.
 *
 * The prompt is composed per model request by the same function the Agent
 * process uses (prompt-context-receipts.ts): the host's base prompt with one
 * section saying what this turn cannot do, then the capability rules, VIBE,
 * project context, the Agent operator policy and capture contract, reviewed
 * memory ranked for the turn, routines, skills, the persona and the model-tier
 * supplement, read from the same `~/.goodvibes/agent` stores. Its receipt goes
 * to the same journal the Agent's receipt views read, under the journal's
 * cross-process lock.
 *
 * The tools are `registerAgentTurnTools`, the one list both places register.
 * Every other Agent tool runs only in the Agent's own process (most are views
 * over its command registry and terminal); this turn names them in its prompt
 * and a call to one is refused with the state, the reason and the next step.
 */
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { HostedSurfaceTurn } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import type { MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { readTierPromptSupplement } from '@goodvibes-jev/engine/platform/platform/providers';
import { factsFor } from '@goodvibes-jev/engine/platform/platform/routing';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { joinPromptParts } from '../prompt-parts.js';
import { GOODVIBES_AGENT_OPERATOR_POLICY } from './operator-policy.js';
import { AgentPromptContextReceiptStore, composeRuntimePromptWithReceipt } from './prompt-context-receipts.js';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { createProfileGatewayInvoke } from './profile-gateway.js';
import { createOccasionsGatewayInvoke } from './occasions-gateway.js';
import { registerAgentProfileTool } from './profile-tool.js';
import { registerAgentOccasionsTool } from './occasions-tool.js';
import type { FamilyGatewayRemote } from './family-gateway.js';
import { registerAgentArtifactsTool } from './artifacts-tool.js';
import { registerAgentDocumentsTool } from './documents-tool.js';
import { registerAgentResearchRunsTool } from './research-runs-tool.js';
import { registerAgentResearchSourcesTool } from './research-sources-tool.js';
import { registerAgentReviewPacketPresetsTool } from './review-packet-presets-tool.js';
import { registerAgentNotifyTool } from './notify-tool.js';
import { registerAgentMediaGenerateTool } from './media-generate-tool.js';
import { registerAgentReviewPacketShareTool } from './review-packet-share-tool.js';
import { registerAgentWorkPlanTool, type AgentWorkPlanStore } from './work-plan-tool.js';
import { registerAgentKnowledgeTool } from './knowledge-tool.js';
import { registerAgentKnowledgeIngestTool } from './knowledge-ingest-tool.js';
import { registerAgentResearchReportTool } from './research-report-tool.js';
import { registerAgentModelCompareTool } from './model-compare-tool.js';
import type { AgentModelCompareToolDeps } from './model-compare-types.js';
import { createAgentCredentialReader, createAgentResearchSourceOwner, createAgentSettingsReader } from './research-source-screening.js';
import { createClassicProtectedSourceOwner, type ProtectedSourceOwner } from '@goodvibes-jev/engine/platform/platform/security';
import { randomUUID } from 'node:crypto';
import { registerAgentOperatorActionTool } from './operator-action-tool.js';
import { registerAgentOperatorBriefingTool } from './operator-briefing-tool.js';
import { registerAgentOperatorMethodTool } from './operator-method-tool.js';
import { registerAgentAutonomyScheduleTool } from './autonomy-schedule-tool.js';
import { registerAgentReminderScheduleTool } from './reminder-schedule-tool.js';
import { registerAgentScheduleEditTool } from './schedule-edit-tool.js';
import { registerAgentScheduleTool } from './schedule-tool.js';
import { createAgentInProcessHost, type AgentInProcessHost } from './in-process-host.js';
import { agentAccountsToolOptions, registerAgentAccountsTool } from './accounts-tool.js';
import { createDaemonExpectationClient, type DaemonExpectationClient } from './session-expectations.js';
import { inProcessVerbCaller } from './in-process-host.js';
import { connectedHostBaseUrl } from './connected-host-dial.js';
import type { ConnectedHostConfigReader } from './connected-host-client.js';
import type { HostedDaemonRequestPath } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import { registerAgentChannelSendTool } from './channel-send-tool.js';
import { registerAgentBrowserTool, type AgentBrowserToolOptions, type BrowserToolBackend } from './browser-tool.js';
import { wireAgentGoogleTool, type GoogleToolWiringDeps } from './google-wiring.js';
import { inProcessGoogleCalendarHost } from './google-tool.js';
import { declareAgentReadModes } from './read-modes.js';
import { registerAgentLocalRegistryTool } from './local-registry-tool.js';
import { registerAgentLearningConsolidationTool } from './learning-consolidation-tool.js';
import type { MemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { resolve } from 'node:path';
import type { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';

/** What the Agent turn tools are built from, in either process. */
export interface AgentTurnToolDeps {
  /** This process's gateway catalog; the daemon's carries the `profile.*` and `occasions.*` handlers. */
  readonly gatewayMethods?: GatewayMethodCatalog | undefined;
  /** The Agent process's connected-host route for those verbs; the daemon passes none. */
  readonly remote?: FamilyGatewayRemote | undefined;
  /** The credential in-process verb calls are judged under: `agent` in a turn the daemon hosts. */
  readonly inProcessCredentialKind?: 'agent' | undefined;
  /** The owner's message for the current turn; a person lookup is refused unless it names the person. */
  readonly currentOwnerMessage?: (() => string | null | undefined) | undefined;
  /** The turn's workspace and home: the Agent's project and user stores are resolved against it. */
  readonly shellPaths: ShellPathService;
  /** The home's artifact store, which artifacts, documents and review packets are kept in. */
  readonly artifactStore: ArtifactStore;
  /** Where the notification settings are read (`agent_notify`). */
  readonly notificationConfig: Parameters<typeof registerAgentNotifyTool>[1];
  /** The process's one webhook notifier; the daemon's in a hosted turn. */
  readonly webhookNotifier: Parameters<typeof registerAgentNotifyTool>[2];
  /** The process's one media provider registry; the daemon's in a hosted turn. */
  readonly mediaProviders: Parameters<typeof registerAgentMediaGenerateTool>[1];
  /** The process's one channel delivery router; the daemon's in a hosted turn. */
  readonly channelDeliveryRouter: Parameters<typeof registerAgentReviewPacketShareTool>[2];
  /**
   * The research screening owners `agent_research_report` and the comparison
   * readings use: the report-only owner (hosted screening under the Agent's
   * consent setting, or Classic) and the shared owner for first-party local reads.
   */
  readonly researchReportSourceOwner?: ProtectedSourceOwner | undefined;
  readonly researchSourceOwner?: ProtectedSourceOwner | undefined;
  /** `agent_model_compare`: the models this turn runs on, and how a judged winner becomes the Agent's model setting. */
  readonly modelCompare: Pick<AgentModelCompareToolDeps, 'modelCatalog' | 'providerRegistry' | 'applyModelRoute'>;
  /** The project work plan of this turn's workspace; absent where none is kept for it. */
  readonly workPlan?: AgentWorkPlanStore | undefined;
  /** This process's settings: the connected host the operator tools call, and the owner's mail address. */
  readonly settings: ConnectedHostConfigReader;
  /**
   * The daemon hosting this turn, which is then the operator tools' connected
   * host, reached in process with the Agent's own credential for it
   * (in-process-host.ts). Absent in the Agent's own process.
   */
  readonly inProcessHost?: AgentInProcessHost | undefined;
  /**
   * The daemon's verification-mail book, which a signup alias (`accounts`)
   * opens its watch in: this daemon's own in a turn it hosts. Absent: the
   * session book, as in the Agent's own process.
   */
  readonly accountExpectations?: DaemonExpectationClient | undefined;
  /** The home's one memory store, and this process's access to it: local, or the daemon's once adopted. */
  readonly memoryRegistry: MemoryRegistry;
  readonly memoryAccess: MemoryAccess;
  /**
   * The browser `browser` drives: the Agent's own engine in its process, the
   * daemon's `browser.*` service in a hosted turn. Absent where the process
   * has no browser; the caller then refuses the tool with that said.
   */
  readonly browser?: AgentBrowserToolOptions | undefined;
  /** The Google account `google` uses: the process's own config and credential stores and, when reachable, the daemon's calendar. */
  readonly google: GoogleToolWiringDeps;
}

/**
 * The Agent tools a turn has wherever it runs: the owner profile and occasions
 * (the two halves of the capture contract the operator policy carries),
 * artifacts, documents, research runs and sources, and review-packet presets.
 */
export function registerAgentTurnTools(registry: ToolRegistry, deps: AgentTurnToolDeps): void {
  const family = {
    ...(deps.gatewayMethods ? { gatewayMethods: deps.gatewayMethods } : {}),
    ...(deps.remote ? { remote: deps.remote } : {}),
    ...(deps.inProcessCredentialKind ? { credentialKind: deps.inProcessCredentialKind } : {}),
  };
  registerAgentProfileTool(registry, {
    invoke: createProfileGatewayInvoke(family),
    ...(deps.currentOwnerMessage ? { currentOwnerMessage: deps.currentOwnerMessage } : {}),
  });
  registerAgentOccasionsTool(registry, { invoke: createOccasionsGatewayInvoke(family) });
  registerAgentArtifactsTool(registry, deps.artifactStore, { projectRoot: deps.shellPaths.workingDirectory });
  registerAgentDocumentsTool(registry, deps.shellPaths, deps.artifactStore);
  registerAgentResearchRunsTool(registry, deps.shellPaths);
  registerAgentResearchSourcesTool(registry, deps.shellPaths);
  registerAgentReviewPacketPresetsTool(registry, deps.artifactStore);
  registerAgentReviewPacketShareTool(registry, deps.artifactStore, deps.channelDeliveryRouter);
  registerAgentMediaGenerateTool(registry, deps.mediaProviders, deps.artifactStore);
  registerAgentNotifyTool(registry, deps.notificationConfig, deps.webhookNotifier);
  // Agent Knowledge on the connected host: the daemon itself, in process, when it hosts this turn.
  registerAgentKnowledgeTool(registry, deps.shellPaths, deps.settings, deps.inProcessHost);
  registerAgentKnowledgeIngestTool(registry, deps.shellPaths, deps.settings, deps.inProcessHost);
  registerAgentResearchReportTool(registry, deps.artifactStore, deps.researchReportSourceOwner ?? deps.researchSourceOwner,
    deps.researchReportSourceOwner ? 'report-only' : 'shared', deps.researchSourceOwner);
  registerAgentModelCompareTool(registry, { ...deps.modelCompare, artifactStore: deps.artifactStore });
  if (deps.workPlan) registerAgentWorkPlanTool(registry, deps.workPlan);
  registerAgentOperatorActionTool(registry, deps.shellPaths, deps.settings, deps.inProcessHost);
  registerAgentOperatorBriefingTool(registry, deps.shellPaths, deps.settings, deps.inProcessHost);
  registerAgentOperatorMethodTool(registry, deps.shellPaths, deps.settings, deps.inProcessHost);
  registerAgentAccountsTool(registry, agentAccountsToolOptions(deps.shellPaths, deps.settings, deps.accountExpectations));
  // Schedules are created and changed through agent_operator_method and agent_operator_action, as nested calls.
  registerAgentAutonomyScheduleTool(registry, deps.shellPaths, deps.settings, deps.inProcessHost);
  registerAgentReminderScheduleTool(registry, deps.shellPaths, deps.settings, deps.artifactStore, deps.inProcessHost);
  registerAgentScheduleEditTool(registry, deps.shellPaths, deps.settings, deps.inProcessHost);
  registerAgentScheduleTool(registry, deps.shellPaths, deps.settings);
  registerAgentLocalRegistryTool(registry, deps.shellPaths, deps.memoryRegistry, deps.memoryAccess);
  registerAgentLearningConsolidationTool(registry, deps.shellPaths, deps.memoryRegistry, deps.memoryAccess);
  registerAgentChannelSendTool(registry, deps.channelDeliveryRouter, { shellPaths: deps.shellPaths });
  if (deps.browser) registerAgentBrowserTool(registry, deps.browser);
  wireAgentGoogleTool(registry, deps.google);
}

/**
 * Agent tools that work through the Agent process's own slash-command registry
 * and `CommandContext` (its live session, conversation, workspace views,
 * panels, keybindings and command handlers, built only by that process), and
 * the two that drive its own terminal and process table. A daemon-hosted turn
 * has none of that state, so these are refused there, with the platform tool
 * that covers the same facts named as the next step.
 */
export const AGENT_SHELL_TOOL_NAMES: readonly string[] = Object.freeze([
  'agent_harness', 'audit', 'autonomy', 'capability_status', 'channels', 'computer', 'context', 'delegation', 'device',
  'execution', 'host', 'import_goodvibes_settings', 'memory', 'models', 'personal_ops', 'process', 'research', 'route',
  'security', 'sessions', 'settings', 'setup', 'support', 'terminal', 'vibe', 'workspace',
]);

/**
 * Agent tools that need no terminal but are not composed in a hosted turn yet:
 * they reach the daemon through the Agent's own connected-host client, or need
 * a daemon-side owner passed in. Each leaves this list when it joins
 * `registerAgentTurnTools`.
 */
export const AGENT_NOT_YET_HOSTED_TOOL_NAMES: readonly string[] = Object.freeze([
]);

/** Every Agent tool a hosted turn refuses. */
export const AGENT_PROCESS_TOOL_NAMES: readonly string[] = Object.freeze([...AGENT_SHELL_TOOL_NAMES, ...AGENT_NOT_YET_HOSTED_TOOL_NAMES]);

const SHELL_REFUSAL = {
  reason: 'This tool works through the GoodVibes Agent\'s own slash-command registry and session (its CommandContext), which exist only in the Agent\'s own process; this turn is hosted by the daemon.',
  next: 'Use the platform tool here that covers the same facts (goodvibes_settings for settings, state mode=memory for memory, exec for commands and processes, web_search and fetch for research, query to ask the owner), or tell the owner the tool runs when he continues in the GoodVibes Agent itself.',
};

const NOT_YET_HOSTED_REFUSAL = {
  reason: 'This Agent tool reaches the daemon through the GoodVibes Agent\'s own connected-host client and is not composed in a daemon-hosted turn.',
  next: 'Tell the owner which tool the request needs and that it runs when he continues in the GoodVibes Agent itself (with hostedSessions.routeConversationTurns off the Agent answers in its own process).',
};

/** The one section a hosted Agent turn's prompt adds: what it is and what it cannot do here. */
function hostedAgentSection(): string {
  const names = (list: readonly string[]): string => list.map((name) => `\`${name}\``).join(', ');
  return [
    '## This Agent turn is hosted by the daemon',
    'You are the GoodVibes Agent, answering in a session the daemon hosts rather than in the Agent\'s own process. Your policy, persona, skills, routines and memory below are the Agent\'s, and the Agent tools `profile`, `occasions`, `agent_artifacts`, `agent_documents`, `agent_research_runs`, `agent_research_sources`, `agent_review_packet_presets`, `agent_review_packet_share`, `agent_media_generate`, `agent_notify`, `agent_local_registry`, `agent_learning_consolidation`, `agent_channel_send`, `browser` (the daemon\'s browser), `google` (the daemon\'s Google account and calendar) and, in the daemon\'s own project, `agent_work_plan` are here, so recording what you learn works as the policy says.',
    'The Agent Knowledge, research report and model comparison tools `agent_knowledge`, `agent_knowledge_ingest`, `agent_research_report` and `agent_model_compare` are here too: Agent Knowledge is this daemon\'s own, reached in process with the Agent\'s own credential, reports and comparisons are saved to the same artifact store, and a comparison\'s apply mode sets the Agent\'s own model setting.',
    'The connected-host operator tools `agent_operator_action`, `agent_operator_briefing` and `agent_operator_method` are here too: their host is this daemon, reached in process with the Agent\'s own credential, so each call is judged as the Agent\'s.',
    'The schedule tools `schedule`, `agent_autonomy_schedule`, `agent_reminder_schedule` and `agent_schedule_edit` are here too: they list, create, edit, run, pause, resume and delete this daemon\'s own schedules through `agent_operator_method` and `agent_operator_action`, so each change is judged as the Agent\'s.',
    '`accounts` is here too: the Agent\'s register of the accounts it created, and a signup alias opens this daemon\'s own watch for the verification mail.',
    `These work through the Agent's own command registry and session and are not here: ${names(AGENT_SHELL_TOOL_NAMES)}. Use the platform tool that covers the same facts, or say the request runs when the owner continues in the GoodVibes Agent itself.`,
    ...(AGENT_NOT_YET_HOSTED_TOOL_NAMES.length > 0
      ? [`These are not in this hosted turn yet: ${names(AGENT_NOT_YET_HOSTED_TOOL_NAMES)}. Where the request needs one, say which and that it runs in the GoodVibes Agent itself. A call to any listed tool is refused.`]
      : []),
  ].join('\n');
}

/** What the daemon builds the Agent's hosted turn from. */
export interface AgentHostedTurnDeps {
  /** The home whose `~/.goodvibes/agent` stores the turn reads (the daemon's own). */
  readonly homeDirectory: string;
  /** The home's one memory store, and the daemon's access to it (its memory spine). */
  readonly memoryRegistry: MemoryRegistry;
  readonly memoryAccess: MemoryAccess;
  /** The daemon's gateway catalog, which serves the `profile.*` and `occasions.*` verbs in-process. */
  readonly gatewayMethods: GatewayMethodCatalog;
  /** The home's artifact store. */
  readonly artifactStore: ArtifactStore;
  /** The daemon's settings, read for notification targets. */
  readonly notificationConfig: AgentTurnToolDeps['notificationConfig'];
  /** The daemon's own notification, media and channel-delivery services. */
  readonly webhookNotifier: AgentTurnToolDeps['webhookNotifier'];
  readonly mediaProviders: AgentTurnToolDeps['mediaProviders'];
  readonly channelDeliveryRouter: AgentTurnToolDeps['channelDeliveryRouter'];
  /** The daemon's project work plan, kept for its own project only. */
  readonly workPlan: AgentWorkPlanStore;
  /** The daemon's settings: its control-plane address keys the Agent's credential for it; the owner's mail address. */
  readonly settings: ConnectedHostConfigReader;
  /** The daemon's `browser.*` service, which `browser` drives; absent when the daemon composed no browser. */
  readonly browser?: BrowserToolBackend | undefined;
  /** The daemon's settings and credential stores, which hold the Google account `google` uses. */
  readonly configManager: GoogleToolWiringDeps['configManager'];
  readonly secretsManager: GoogleToolWiringDeps['secretsManager'];
}

export function createAgentHostedTurn(deps: AgentHostedTurnDeps): HostedSurfaceTurn {
  const receipts = new AgentPromptContextReceiptStore(
    createShellPathService({ workingDirectory: deps.homeDirectory, homeDirectory: deps.homeDirectory })
      .resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'prompt-context-receipts.jsonl'),
  );
  const section = hostedAgentSection();
  // The research screening owners, as the Agent process has them: hosted screening
  // under the Agent's own consent setting (read from its settings file) with the
  // screening keys from the Agent's own credential stores, or Classic, and
  // code-only screening for first-party local reads. Made on first use, kept for the daemon's life.
  const screeningLifetime = new AbortController();
  let researchOwners: { readonly report: ProtectedSourceOwner; readonly shared: ProtectedSourceOwner } | null = null;
  const researchOwnersFor = (): { readonly report: ProtectedSourceOwner; readonly shared: ProtectedSourceOwner } => {
    if (researchOwners) return researchOwners;
    const agentSettings = createAgentSettingsReader(deps.homeDirectory);
    researchOwners = {
      report: createAgentResearchSourceOwner(agentSettings, createAgentCredentialReader(deps.homeDirectory, agentSettings), screeningLifetime.signal),
      shared: createClassicProtectedSourceOwner(Object.freeze({
        ownerId: `agent-local-reads-${randomUUID()}`,
        revision: randomUUID(),
        signal: screeningLifetime.signal,
        assertCurrent: () => screeningLifetime.signal.throwIfAborted(),
      })),
    };
    return researchOwners;
  };
  // One in-process host per daemon request path: the daemon is the operator tools' connected host.
  let inProcess: { readonly requests: HostedDaemonRequestPath; readonly host: AgentInProcessHost } | null = null;
  const inProcessHostFor = (requests: HostedDaemonRequestPath | undefined): AgentInProcessHost | undefined => {
    if (!requests) return undefined;
    const current = inProcess;
    if (current?.requests === requests) return current.host;
    const host = createAgentInProcessHost({
      requests,
      baseUrl: connectedHostBaseUrl(deps.settings.get('controlPlane.host'), deps.settings.get('controlPlane.port')),
      homeDirectory: deps.homeDirectory,
    });
    // Resolving once starts making the Agent's credential for this daemon, so it is there for the first call.
    host.connection();
    inProcess = { requests, host };
    return host;
  };
  // Calendar calls go to the daemon's own `calendar.events.*` handlers, admitted as the paired Agent's.
  const calendarHost = inProcessGoogleCalendarHost(deps.gatewayMethods);
  const browser = deps.browser;
  return {
    registerTools({ registry, workspaceRoot, sessionId, floor, daemonRequests, providerRegistry }) {
      // The daemon keeps one project work plan, for its own project; a session in
      // another workspace has no plan of its own here and is told so on a call.
      const ownProject = resolve(deps.workPlan.projectRoot) === resolve(workspaceRoot);
      if (!ownProject) {
        registry.declareElsewhere(['agent_work_plan'], {
          reason: `The work plan the daemon keeps is for its own project (${deps.workPlan.projectRoot}), not this session's workspace (${workspaceRoot}).`,
          next: 'Use agent_work_plan from the GoodVibes Agent opened in that workspace, or start the hosted session in the daemon\'s project.',
        });
      }
      const operatorHost = inProcessHostFor(daemonRequests);
      registerAgentTurnTools(registry, {
        ...(ownProject ? { workPlan: deps.workPlan } : {}),
        inProcessCredentialKind: 'agent',
        memoryRegistry: deps.memoryRegistry,
        memoryAccess: deps.memoryAccess,
        gatewayMethods: deps.gatewayMethods,
        shellPaths: createShellPathService({ workingDirectory: workspaceRoot, homeDirectory: deps.homeDirectory }),
        artifactStore: deps.artifactStore,
        notificationConfig: deps.notificationConfig,
        webhookNotifier: deps.webhookNotifier,
        mediaProviders: deps.mediaProviders,
        channelDeliveryRouter: deps.channelDeliveryRouter,
        settings: deps.settings,
        researchReportSourceOwner: researchOwnersFor().report,
        researchSourceOwner: researchOwnersFor().shared,
        modelCompare: {
          modelCatalog: providerRegistry,
          providerRegistry,
          // The winner becomes the Agent's own model setting: this session's settings
          // tool writes the Agent's client-owned keys to the Agent's settings file and
          // re-reads them there, which `verifiedInOwningStore` reports.
          applyModelRoute: async (registryKey, parentOptions, ownership) => {
            const applied = await registry.executeNested(`model-route-${randomUUID()}`, 'goodvibes_settings',
              { mode: 'set', key: 'provider.model', value: registryKey }, parentOptions, ownership);
            let verified = false;
            let previousModel = '';
            try {
              const output = JSON.parse(applied.output ?? '{}') as { readonly verifiedInOwningStore?: unknown; readonly previous?: unknown };
              verified = applied.success && output.verifiedInOwningStore === true;
              previousModel = typeof output.previous === 'string' ? output.previous.trim() : '';
            } catch { /* Value-free refusal below. */ }
            if (!verified) throw new Error('Model route transition did not verify in its owning store.');
            return { ...(previousModel ? { previousModel } : {}), selectedModel: registryKey };
          },
        },
        ...(operatorHost ? { inProcessHost: operatorHost } : {}),
        ...(operatorHost ? { accountExpectations: createDaemonExpectationClient(inProcessVerbCaller(operatorHost)) } : {}),
        ...(browser ? { browser: {
          browser: () => browser,
          // A file: page is a local read, held to the same decision this session's read tool gets.
          readAccess: async (absolutePath: string) => (await floor.services.permissionManager.readAccess(absolutePath, sessionId)) === 'allow',
        } } : {}),
        google: {
          configManager: deps.configManager,
          secretsManager: deps.secretsManager,
          homeDirectory: deps.homeDirectory,
          artifactStore: deps.artifactStore,
          calendarHost,
        },
      });
      if (!browser) {
        registry.declareElsewhere(['browser'], {
          reason: 'This daemon was composed without a browser (it has no home directory to keep browser profiles in), so there is no browser for this turn to drive.',
          next: 'Use fetch or web_search to read a page, or tell the owner the browser runs when he continues in the GoodVibes Agent itself.',
        });
      }
      registry.declareElsewhere(AGENT_SHELL_TOOL_NAMES, SHELL_REFUSAL);
      registry.declareElsewhere(AGENT_NOT_YET_HOSTED_TOOL_NAMES, NOT_YET_HOSTED_REFUSAL);
      // The Agent's read-mode table, on the platform tools here as on the Agent's own registry.
      declareAgentReadModes(registry);
      return undefined;
    },
    async systemPrompt(input) {
      const signal = input.signal;
      signal?.throwIfAborted();
      const providerRegistry = input.providerRegistry;
      const model = providerRegistry.getCurrentModel();
      const tierPrompt = await readTierPromptSupplement(
        factsFor({ catalog: providerRegistry }, model),
        providerRegistry.modelTiers,
        'agent.conversation-system-prompt',
        { audience: 'conversation', signal },
      );
      signal?.throwIfAborted();
      const composed = await composeRuntimePromptWithReceipt({
        sessionId: input.sessionId,
        turnId: null,
        source: 'turn',
        provider: model.provider,
        model,
        contextWindow: providerRegistry.getKnownContextWindowForModel(model),
        tierPrompt,
        runtimePrompt: joinPromptParts(input.basePrompt, section),
        operatorPolicy: GOODVIBES_AGENT_OPERATOR_POLICY,
        shellPaths: createShellPathService({ workingDirectory: input.workspaceRoot, homeDirectory: deps.homeDirectory }),
        memoryRegistry: deps.memoryRegistry,
        capabilityIndex: null,
        turnText: input.turnText,
      });
      signal?.throwIfAborted();
      try {
        receipts.record(composed.receipt);
      } catch (error) {
        // The receipt describes the prompt; failing to keep it must not fail the turn.
        logger.warn('Hosted Agent prompt receipt was not recorded', { sessionId: input.sessionId, error: summarizeError(error) });
      }
      return composed.prompt;
    },
  };
}
