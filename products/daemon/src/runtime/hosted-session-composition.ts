import { createDaemonWorkspaceTrustResolver } from './workspace-trust-composition.js';
import { nativeHostedConversationOwner } from './native-hosted-conversation-composition.js';
/**
 * hosted-session-composition.ts, what this daemon states so it may host
 * conversation loops.
 *
 * The engine is the platform's (`@goodvibes/engine/platform/platform/hosted-sessions`):
 * lifecycle, the detach policy, the bounded disk state, the verbs, the
 * lifecycle channel. It is off until a product says how a workspace FLOOR is
 * built, and that is deliberate, the floor's `requestApproval` seam is where a
 * product's trust posture lives, and no default can stand in for a decision
 * about who may write files and run commands in a directory a client named over
 * the wire.
 *
 * This daemon's answer is the gate it already had: the workspace trust
 * question is put in front of every ask a hosted run makes (trust/trust-gated-
 * approvals.ts): an undecided workspace raises the question as an ordinary
 * approval record for whichever surface is attached to answer, a trusted one is
 * exactly as permissive as before, and a restricted one refuses non-read
 * categories without asking. What this file adds is PER-WORKSPACE scope: the
 * daemon's own gate reads its own directory's decision in the user's workspace
 * register, and a session hosted in another directory has to be gated by that
 * directory's decision, not by the daemon's.
 *
 * Everything else in a floor comes from `createClientRuntimeServices`, the
 * same composition a terminal runs, so a hosted turn's tools, hooks, plugins
 * and model stack are the ones the platform already has, not a second set. A
 * session created for the Agent adds the Agent's own turn on top (its prompt
 * and its terminal-free tools, `createAgentHostedTurn`).
 *
 * ── The exec posture a hosted turn runs under ──────────────────────────────
 *
 * "The same composition a terminal runs" is what BUILDS the exec tool, and it
 * builds it the same way here: the `sandbox.*` config and the `exec-sandbox`
 * gate this daemon already reads produce the same bubblewrap boundary a local
 * exec gets, network, PID, UTS and IPC namespaced, the system read-only, /tmp
 * and $HOME masked, the workspace writable, and `sandbox.egressAllowlist` the
 * one way network comes back, with the self-labelling note on every result.
 *
 * What was NOT the same was the fallback. When no boundary could be applied,
 * the exec tool ran the command on the host and said so, which is right for a
 * terminal (a person asked, a person is reading) and wrong for a turn nobody is
 * watching. A hosted conversational turn reached the whole host that way: the
 * full process table, the owner's /proc, and his tmux session, where it typed.
 *
 * So this daemon states the posture rather than inheriting a default:
 *
 *  - CONVERSATIONAL is what every session created over `sessions.hosted.*`
 *    gets, and it is the posture the engine defaults to. The boundary is
 *    REQUIRED: a command that cannot be contained is refused, naming why, and
 *    running on the host is not a fallback available to it. The owner's
 *    terminal is denied outright, at the exec guard, regardless of boundary.
 *  - WORKSTREAM, a real work chain the owner authorized, which may genuinely
 *    need the machine itself (the boundary where available, the host where
 *    not), is a grant a daemon composition makes explicitly. Hosted sessions
 *    never hold it: they are always conversational, and the function below
 *    never returns anything else. The one holder today is native work
 *    execution's delegated agents: native-work-execution-activation.ts sets
 *    `execContainment: WORKSTREAM_CONTAINMENT` on their tool dependencies, and
 *    the operator method `workLedger.execution.start` (owner-authorized) is
 *    what admits that work. Nothing on the wire and nothing in a tool argument
 *    can reach the grant otherwise.
 */
import { createClientRuntimeServices } from '@goodvibes/engine/platform/platform/runtime/client-services';
import { createRuntimeStore } from '@goodvibes/engine/platform/platform/runtime/store';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { DaemonHostedSessionsOptions } from '@goodvibes/engine/platform/platform/daemon';
import type {
  HostedSessionExecPosture,
  HostedWorkspaceFloor,
} from '@goodvibes/engine/platform/platform/hosted-sessions';
import {
  containmentFor,
  hostedAgentAsker,
  hostedWorkerSurface,
} from '@goodvibes/engine/platform/platform/hosted-sessions';
import { CONVERSATIONAL_DIAGNOSIS_SECTION, askingQuestions } from '@goodvibes/engine/platform/platform/agents';
import { createWorkspaceTrustDecisionAsk, trustGatedApprovalRaiser, WORKSPACE_TRUST_ASK_TIMEOUT_MS, type ApprovalRaise } from '@goodvibes/engine/platform/platform/runtime/operations';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { RuntimeServices } from './runtime-services-types.js';
import { daemonWorkspaceCheckpoints } from './workspace-checkpointing.js';
import { hostedRewindStorage, hostedSessionConversations } from './conversation-rewind-port.js';
import { createAgentHostedTurn } from '@goodvibes/engine/terminal-shell/agent-turn/hosted-turn';
import {
  createDaemonCapabilityServices, daemonCapabilityCatalog, loadedDaemonCapabilityCatalog, preloadDaemonCapabilityCatalog,
} from '@goodvibes/engine/platform/platform/capabilities';

/** The operator policy a session hosted by THIS daemon runs under. */
function hostedSystemPrompt(input: { readonly workspaceRoot: string }): string {
  return [
    [
      'You are a GoodVibes session hosted by the daemon rather than by a terminal.',
      `Your working directory is ${input.workspaceRoot}.`,
      'Someone may be attached and watching this turn, or may have detached and read it later;',
      'write for both. Say what you did and why; never report work you did not do.',
      'When decision models are active, they decide tool actions from the original goal and criteria within current deterministic constraints.',
      'Without a decision model, use native permission rules and owner approvals; never claim independent semantic verification.',
      'Autonomous decision mode does not wait for an attached human. A required owner approval without a decision model must be resolved before proceeding.',
      'Never invent authority or route around a refusal.',
    ].join(' '),
    // The same contract every other conversational turn is held to, from the
    // platform rather than restated here, a second copy is a copy that drifts.
    CONVERSATIONAL_DIAGNOSIS_SECTION,
  ].join('\n\n');
}

/**
 * What a hosted session's exec tool may do.
 *
 * Every session this daemon hosts is a conversation, so every one of them is
 * contained (see the module header). Stated on the floor rather than left to
 * the engine's default, beside the trust gate, which is the other statement
 * this daemon makes about how much authority a hosted run carries. The
 * workstream grant is not made here: its one holder is native work
 * execution's delegated agents (native-work-execution-activation.ts, the
 * `execContainment` line), admitted by `workLedger.execution.start`.
 */
function hostedExecPosture(): HostedSessionExecPosture {
  return 'conversational';
}

/**
 * Build the hosted-session options this daemon passes to `DaemonServer`.
 *
 * `services` is the daemon's own graph: its config manager, event bus, secrets
 * home and approval broker are shared with every floor, so a hosted session
 * reads the same settings, publishes on the same bus and raises asks into the
 * same broker every other surface is watching.
 */
export function createHostedSessionOptions(services: RuntimeServices): DaemonHostedSessionsOptions {
  /**
   * One trust manager per workspace, cached: the manager owns the workspace's
   * in-memory answer and its one open trust question, so two sessions in one
   * directory share one question instead of each asking.
   */
  const trustFor = createDaemonWorkspaceTrustResolver(services);

  const gateFor = (workspaceRoot: string): ApprovalRaise => {
    const trust = trustFor(workspaceRoot);
    const raise: ApprovalRaise = (input) => services.approvalBroker.requestApproval(input);
    return trustGatedApprovalRaiser(
      trust,
      raise,
      // The question names the workspace it is about, which is the whole point
      // of scoping it here: a daemon hosting three sessions in three
      // directories asks three separate questions, each answerable on its own.
      createWorkspaceTrustDecisionAsk({ broker: services.approvalBroker, workingDirectory: workspaceRoot }),
      { waitMs: WORKSPACE_TRUST_ASK_TIMEOUT_MS },
    );
  };

  // One checkpoint manager per hosted workspace, open until the daemon stops; the daemon's own workspace keeps the daemon's.
  const workspaceCheckpoints = daemonWorkspaceCheckpoints(services.runtimeBus);
  // The daemon's own stores, which a hosted session's capabilities act on (a project's hooks file and secrets by its folder).
  const capabilityServices = createDaemonCapabilityServices(services);

  return {
    nativeConversation: nativeHostedConversationOwner(services.gatewayMethods),
    // A hosted session in the daemon's own project keeps this plan with `work_plan`.
    workPlan: services.workPlan,
    floorFactory: async ({ workspaceRoot, liveConversationMessages }): Promise<HostedWorkspaceFloor> => {
      const taskGraphPath = createShellPathService({ workingDirectory: workspaceRoot, homeDirectory: services.homeDirectory })
        .resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'sessions', 'task-graph.json');
      const sessionOrchestration = services.sessionOrchestration.borrowForGraphPath(taskGraphPath);
      const floor = createClientRuntimeServices({
        sessionOrchestration,
        judgment: services.judgment,
        configManager: services.configManager,
        // The daemon's own bus: a hosted turn's stream events reach the
        // control-plane SSE subscribers through the same path every other
        // runtime event takes, stamped with the hosted session's id.
        runtimeBus: services.runtimeBus,
        // A store of its own. The daemon's runtime store describes the daemon's
        // single local runtime, and a hosted session is not that runtime.
        runtimeStore: createRuntimeStore(),
        featureFlags: services.featureFlags,
        surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
        // The daemon's own leaderboard, local context-window readings and live
        // model listings: the same surface root and providers directory, so a
        // floor built when a workspace's next session starts reads, fetches and
        // probes none of them again.
        providerHostFacts: {
          benchmarkStore: services.benchmarkStore,
          localContextIngestion: services.providerRegistry.localContextReadings,
          liveModelListings: services.providerRegistry.liveModelListings,
        },
        workingDir: workspaceRoot,
        homeDirectory: services.homeDirectory,
        // A contract a hosted turn starts sees the owner's reads from that turn at once.
        ownerConversationMessages: liveConversationMessages,
        requestApproval: gateFor(workspaceRoot),
        workspaceTrust: trustFor(workspaceRoot),
        // One store owns the rule file: a remembered approval in a hosted session
        // is the one the gateway lists and deletes.
        userPermissionRuleStore: services.userPermissionRuleStore,
        // Workers a hosted turn delegates to run under the turn's own posture.
        execContainment: containmentFor(hostedExecPosture()),
        // Workers a hosted turn starts can leave the owner a question in the one inbox, like every spawned agent;
        // the agent takes the answer while it runs, otherwise the hosted session that started it does.
        ...(services.ownerInbox ? { ownerQuestions: askingQuestions(services.ownerInbox, hostedAgentAsker) } : {}),
        // A worker a hosted session spawns is built for that session's surface: a
        // session created for the Agent spawns workers with the Agent's tool
        // policy, admission and settings routing, as the Agent's own process does.
        workerSurface: hostedWorkerSurface,
      });
      let stopLending = (): void => {};
      try {
        // The floor's own tolerant custom load must settle before cached names
        // can be copied or a hosted model can be selected. The shared floor
        // owner drains this async acquisition and refuses late shutdown leases.
        await floor.providerRegistry.ready();
        // The daemon registry lends this floor its discovered servers: what it
        // holds now, and each later scan's result while the floor lives, so a
        // model the daemon lists after this floor was built runs in it too.
        stopLending = services.providerRegistry.lendDiscoveredServers(floor.providerRegistry);
        // Snapshots this workspace's tree after each of its sessions' turns, so
        // checkpoints.restore and sessions.changes.get work for a hosted session.
        // It outlives the floor: a finished session's changes stay reviewable.
        workspaceCheckpoints.acquire(workspaceRoot);
        // The daemon's whole capability catalog, read before the first session's tools are built from it.
        await preloadDaemonCapabilityCatalog();
        return {
          services: floor,
          capabilityTools: {
            catalog: daemonCapabilityCatalog,
            loaded: loadedDaemonCapabilityCatalog,
            services: capabilityServices,
            methods: services.gatewayMethods,
            workingDirectory: () => workspaceRoot,
          },
          devicePosture: services.devicePosture,
          // Each workspace floor owns its own contract store and runner.
          contractRunner: floor.contractRunner,
          execPosture: hostedExecPosture,
          // Resolves once every owner the floor started has drained (its background processes included).
          dispose: (): Promise<void> => { stopLending(); return floor.close(); },
        };
      } catch (error) {
        // Until publication, this factory owns its returned client graph. The
        // cause rides on the failure; the session engine logs it and refuses
        // the create with the workspace named.
        stopLending();
        try { floor.dispose(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Daemon hosted workspace provider preload and cleanup failed'); }
        throw new Error('Daemon hosted workspace provider preload failed', { cause: error });
      }
    },
    // A session created for the Agent (its routed turns, its channel hand-offs,
    // or `originSurface: 'agent'` from any client) answers as the Agent: its
    // prompt, from the same stores the Agent process reads, and the Agent tools
    // that need no terminal, with the rest refused here and named.
    surfaceTurns: {
      agent: createAgentHostedTurn({
        homeDirectory: services.homeDirectory,
        memoryRegistry: services.memoryRegistry,
        memoryAccess: services.memorySpine,
        artifactStore: services.artifactStore,
        notificationConfig: services.configManager,
        webhookNotifier: services.webhookNotifier,
        mediaProviders: services.mediaProviders,
        channelDeliveryRouter: services.channelDeliveryRouter,
        workPlan: services.workPlan,
        // Its control-plane address keys the Agent's pairing and delegated credential for this
        // daemon, which the operator tools present when they call this daemon in process.
        settings: services.configManager,
        // The daemon's own browser and Google account: `browser` drives the
        // engine the `browser.*` verbs serve; `google` reads the daemon's
        // settings and credential stores, and calls its own `calendar.events.*`
        // through the request path with the Agent's ordinary credential.
        ...(services.browserGateway ? { browser: services.browserGateway } : {}),
        configManager: services.configManager,
        secretsManager: services.secretsManager,
        // The memories the Agent's own prompt injected count toward decay as the Agent process's do.
        memoryUsage: services.memoryUsageTracker,
      }),
    },
    // Each hosted loop's conversation, so rewind.plan/apply/undo serve it in this
    // process; the storage is the one the daemon's rewind port reads.
    conversations: hostedSessionConversations(hostedRewindStorage(services)),
    // Called for every session the engine binds to a workspace (create and
    // rebuild), so the session's turns reach that workspace's checkpoints.
    systemPrompt: (input) => {
      workspaceCheckpoints.bindSession(input.sessionId, input.workspaceRoot);
      return hostedSystemPrompt(input);
    },
  };
}
