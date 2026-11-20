import type { CommandContext } from '../input/command-registry.ts';
import type { CliServicePosture } from '../cli/service-posture.ts';
import type { OnboardingStep1CapabilityItem } from '../runtime/onboarding/index.ts';
import { previewAgentWorkspaceTuiSettingsImport } from '../input/agent-workspace-settings.ts';
import { browserControlPosture } from './agent-harness-browser-control.ts';
import type { CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { localModelCookbook } from './agent-harness-model-routing.ts';
import { sudoExecutionPosture } from './agent-harness-sudo-posture.ts';
import { agentHarnessVibeHealth } from './agent-harness-vibe-health.ts';
import { latestAgentKnowledgeReadiness } from './agent-harness-connected-host-status.ts';
import { capabilityById, collectSnapshot, servicePostureFailure, setupPlanStatusForCapability, setupProviderSignalIds } from './agent-harness-setup-posture-utils.ts';
import { browserControlSignals, localModelSetupNextAction, localModelSetupReadiness, localModelSetupSignals, localModelSetupStatus, settingsImportChangeCount, settingsImportSignals } from './agent-harness-setup-model-helpers.ts';
import { connectedHostAuthModelRoute, connectedHostAuthNextAction, connectedHostAuthPosture, connectedHostAuthSignals, connectedHostAuthStatus, connectedHostBootstrapPlan, connectedHostRepairCards, connectedHostServiceProbe, hostSetupStatus, serviceProbeSignal, setupServiceLifecycleDecision } from './agent-harness-setup-connected-host.ts';
import { installSmokePlan, installSmokeSignals, setupCompletionMarkerExists, setupSmokeArtifactResult, type SetupSmokeEvidenceList } from './agent-harness-setup-smoke.ts';
import type { SetupPlanItem } from './agent-harness-setup-posture-types.ts';

/** What one setup call observed; each part is read once and shared by the plan, the smoke sections and the wizard. */
export interface SetupPlanSources {
  readonly snapshot: Awaited<ReturnType<typeof collectSnapshot>>;
  readonly capabilities: readonly OnboardingStep1CapabilityItem[];
  /** The host service probe, run at most once per call and only when a row that reports the host is built. */
  readonly probeServices: () => Promise<CliServicePosture | null>;
  readonly smoke: SetupSmokeEvidenceList;
}

function once<T>(read: () => T): () => T {
  let done = false, value: T;
  return () => { if (!done) { value = read(); done = true; } return value; };
}

/**
 * The setup plan. Each row is built only when it is wanted (`only` names
 * them; all rows otherwise), and each source a row needs is read once: a
 * lookup of one row that does not report the host never probes it.
 */
export async function buildSetupPlan(
  context: CommandContext,
  sources: SetupPlanSources,
  options: CatalogRankingOptions = {},
  only?: ReadonlySet<string>,
): Promise<readonly SetupPlanItem[]> {
  const { snapshot, capabilities, smoke } = sources;
  const browserControl = once(() => browserControlPosture(context, context.extensions?.toolRegistry, options));
  const capability = (id: OnboardingStep1CapabilityItem['id']) => capabilityById(capabilities, id);
  const settingsImport = once(() => previewAgentWorkspaceTuiSettingsImport(context));
  const localModels = once(() => localModelCookbook(context, true));
  const serviceProbe = once(async () => connectedHostServiceProbe(await sources.probeServices(), servicePostureFailure(context)));
  const authPosture = once(() => connectedHostAuthPosture(context, snapshot, options));
  const vibeHealth = once(() => agentHarnessVibeHealth(context));
  const sudoPosture = once(() => sudoExecutionPosture(context));
  const latestSmoke = smoke.status === 'available' ? smoke.artifacts[0] : undefined;
  const latestSmokeResult = latestSmoke ? setupSmokeArtifactResult(latestSmoke) : null;

  const rows: readonly { readonly id: string; readonly build: () => Promise<SetupPlanItem> | SetupPlanItem }[] = [
    { id: 'connected-host-readiness', build: async () => {
      const probe = await serviceProbe(), auth = await authPosture();
      return {
        id: 'connected-host-readiness',
        label: 'Connected host readiness',
        status: auth.nativeIntake.status === 'ready' && !snapshot.collectionIssues.some(issue => issue.area === 'host')
          ? 'ready' : hostSetupStatus(snapshot, probe),
        priority: 10,
        blocksAutonomy: true,
        reason: 'Daemon-backed automation, Agent Knowledge, channels, and companion routes need a reachable compatible GoodVibes host.',
        nextAction: 'Run connected-host status, then start, update, or repair the owning GoodVibes host if the live check reports a gap.',
        userRoute: 'Agent Workspace -> Connected Host; /health compat',
        modelRoute: 'host action:"status"',
        relatedSetupItemId: 'operator-terminal',
        signals: [
          serviceProbeSignal(probe),
          ...probe.issues.slice(0, 3),
          ...snapshot.collectionIssues.filter((issue) => issue.area === 'host').map((issue) => issue.message),
        ],
        repairCards: connectedHostRepairCards(snapshot, probe),
        serviceLifecycleDecision: setupServiceLifecycleDecision(snapshot, probe),
        bootstrapPlan: connectedHostBootstrapPlan(snapshot, probe),
        serviceProbe: probe,
      };
    } },
    { id: 'connected-host-auth', build: async () => {
      const auth = await authPosture();
      return {
        id: 'connected-host-auth',
        label: 'Connected-host auth',
        status: connectedHostAuthStatus(auth),
        priority: 12,
        blocksAutonomy: true,
        reason: 'Native intake needs a fresh selected-host check of a paired owner with read:work-ledger and write:work-ledger. Provider, workspace and Jev readiness are separate checks.',
        nextAction: connectedHostAuthNextAction(auth),
        userRoute: 'Agent Workspace -> Connected Host; /auth review',
        modelRoute: connectedHostAuthModelRoute(auth),
        relatedSetupItemId: 'operator-terminal',
        signals: connectedHostAuthSignals(auth),
        authPosture: auth,
      };
    } },
    { id: 'goodvibes-settings-import', build: () => {
      const preview = settingsImport(), changes = settingsImportChangeCount(preview);
      return {
        id: 'goodvibes-settings-import',
        label: 'GoodVibes settings import',
        status: preview?.summary.parseErrors ? 'check' : changes > 0 ? 'recommended' : 'optional',
        priority: 15,
        blocksAutonomy: false,
        reason: 'Existing shared GoodVibes settings can seed Agent provider, subscription, behavior, permission, UI, TTS, channel, helper, tool, release, and automation state.',
        nextAction: changes > 0
          ? 'Preview the import, explain the changed setting and subscription counts, then apply only after the user confirms the import.'
          : 'Use this when reusing settings from GoodVibes TUI or another published GoodVibes platform store; the preview shows whether anything importable is present.',
        userRoute: 'Agent Workspace -> Start -> Import GoodVibes settings',
        modelRoute: 'import_goodvibes_settings action:"preview"',
        signals: settingsImportSignals(preview),
      };
    } },
    { id: 'provider-access', build: () => {
      const providerAccess = capability('provider-access');
      return {
        id: 'provider-access',
        label: 'Provider and model access',
        status: setupPlanStatusForCapability(providerAccess, 'blocked'),
        priority: 20,
        blocksAutonomy: true,
        reason: providerAccess.detail,
        nextAction: providerAccess.selected ? 'Review the current model route and provider accounts.' : 'Choose a provider/model route or store a provider credential before relying on assistant turns.',
        userRoute: 'Agent Workspace -> Start -> Choose main model',
        modelRoute: 'models action:"status|providers"',
        relatedSetupItemId: providerAccess.id,
        signals: setupProviderSignalIds(snapshot),
      };
    } },
    { id: 'install-smoke', build: async () => {
      const smokePlan = installSmokePlan(capability('provider-access'), await serviceProbe(), await authPosture());
      // Done when the latest saved evidence passed: nothing blocked and every user-run check's output saved.
      const status = smokePlan.status !== 'ready-to-run' ? 'blocked' : latestSmokeResult === 'passed' ? 'ready' : 'recommended';
      return {
        id: 'install-smoke',
        label: 'Install smoke',
        status,
        priority: 22,
        blocksAutonomy: false,
        reason: status === 'ready'
          ? 'The latest saved setup evidence passed: the host, auth and model checks were ready and the user-run checks were recorded.'
          : 'A fresh install should be provable from package binary to reachable host, usable auth, selected model route, reviewed setup posture, and one successful assistant turn.',
        nextAction: status === 'ready'
          ? 'Nothing to do; save new evidence only after reinstalling or changing the host or model route.'
          : status === 'recommended'
            ? 'Have the user run the user-run checks, then save what they saw with setup action:"smoke" fields:{...}.'
            : 'Resolve connected-host, connected-host auth, and provider/model blockers; setup action:"item" setupItemId:"install-smoke" lists them.',
        userRoute: 'Agent Workspace -> Start',
        modelRoute: 'setup action:"item" setupItemId:"install-smoke"',
        signals: [...installSmokeSignals(smokePlan), `latest evidence: ${latestSmokeResult ?? 'none'}`],
        installSmokePlan: smokePlan,
      };
    } },
    { id: 'local-model-readiness', build: () => {
      const models = localModels();
      return {
        id: 'local-model-readiness',
        label: 'Local model readiness',
        status: localModelSetupStatus(models),
        priority: 25,
        blocksAutonomy: false,
        reason: 'A local route gives the assistant a private/offline fallback and can reduce cost, but it should be set up through visible server, refresh, and benchmark steps.',
        nextAction: localModelSetupNextAction(models),
        userRoute: 'Agent Workspace -> Start -> Use a local model (no sign-in)',
        modelRoute: 'models action:"local"',
        signals: localModelSetupSignals(models),
        localModelReadiness: localModelSetupReadiness(models),
      };
    } },
    { id: 'agent-knowledge', build: () => {
      const agentKnowledge = capability('agent-knowledge');
      // The route is checked by host action:"status"; this row reports what that check last found.
      const readiness = latestAgentKnowledgeReadiness();
      return {
        id: 'agent-knowledge',
        label: 'Agent Knowledge readiness',
        status: readiness === null ? 'recommended' : readiness.ready ? 'ready' : 'check',
        priority: 30,
        blocksAutonomy: false,
        reason: readiness === null
          ? `${agentKnowledge.detail} The knowledge route has not been checked in this session.`
          : readiness.ready
            ? `${agentKnowledge.detail} ${readiness.route} answered ready at ${new Date(readiness.checkedAt).toISOString()}.`
            : readiness.reachable
              ? `${agentKnowledge.detail} ${readiness.route} answered ${readiness.kind} at ${new Date(readiness.checkedAt).toISOString()}.`
              : `${agentKnowledge.detail} The connected host was not reachable at ${new Date(readiness.checkedAt).toISOString()}.`,
        nextAction: readiness?.ready
          ? 'Nothing to do; use agent_knowledge for source-backed memory or research ingest.'
          : readiness === null
            ? 'Run host action:"status" to check the Agent Knowledge route.'
            : 'Update or repair the connected host, then run host action:"status" again.',
        userRoute: 'Agent Workspace -> Knowledge',
        modelRoute: 'host action:"status"',
        relatedSetupItemId: agentKnowledge.id,
      };
    } },
    { id: 'vibe-personality', build: () => {
      const vibe = vibeHealth();
      return {
        id: 'vibe-personality',
        label: 'VIBE.md personality',
        status: vibe.status,
        priority: 35,
        blocksAutonomy: false,
        reason: 'VIBE.md is the user-friendly personality file for how GoodVibes Agent should feel, but blocked or truncated files should be visible before they shape a session.',
        nextAction: vibe.nextAction,
        userRoute: vibe.userRoute,
        modelRoute: vibe.modelRoute,
        signals: vibe.signals,
        vibeHealth: vibe,
      };
    } },
    { id: 'local-behavior', build: () => {
      const localBehavior = capability('local-behavior');
      return {
        id: 'local-behavior',
        label: 'Local memory, skills, and routines',
        status: setupPlanStatusForCapability(localBehavior, 'recommended'),
        priority: 40,
        blocksAutonomy: false,
        reason: localBehavior.detail,
        nextAction: localBehavior.selected ? 'Review imported or customized local behavior.' : 'Import discovered behavior files or create the first persona, skill, or routine.',
        userRoute: 'Agent Workspace -> Local Context',
        modelRoute: 'memory action:"curator" or agent_harness mode:"workspace_actions" categoryId:"onboarding-context"',
        relatedSetupItemId: localBehavior.id,
      };
    } },
    { id: 'communication-channels', build: () => {
      const communicationChannels = capability('communication-channels');
      return {
        id: 'communication-channels',
        label: 'Communication channels',
        status: setupPlanStatusForCapability(communicationChannels, 'optional'),
        priority: 50,
        blocksAutonomy: false,
        reason: communicationChannels.detail,
        nextAction: communicationChannels.selected ? 'Review channel readiness and delivery safety.' : 'Enable only the channels where the assistant should be reachable.',
        userRoute: 'Agent Workspace -> Messaging',
        modelRoute: 'channels action:"status"',
        relatedSetupItemId: communicationChannels.id,
        signals: snapshot.surfaces.configuredEnabledKinds,
      };
    } },
    { id: 'automation-review', build: () => {
      const automationReview = capability('automation-review');
      return {
        id: 'automation-review',
        label: 'Automation review',
        status: setupPlanStatusForCapability(automationReview, 'recommended'),
        priority: 60,
        blocksAutonomy: false,
        reason: automationReview.detail,
        nextAction: 'Review schedules, approvals, routine promotion, and visible autonomy queue controls before ongoing background work.',
        userRoute: 'Agent Workspace -> Personal Ops -> Autonomy queue',
        modelRoute: 'autonomy action:"queue"',
        relatedSetupItemId: automationReview.id,
      };
    } },
    { id: 'browser-desktop-control', build: async () => {
      const control = await browserControl();
      return {
        id: 'browser-desktop-control',
        label: 'Browser and desktop control',
        status: control.status === 'ready' ? 'ready' : control.status === 'attention' ? 'check' : 'recommended',
        priority: 65,
        blocksAutonomy: false,
        reason: control.configured
          ? 'A trusted browser, desktop, computer-use, screenshot, or screen-recording route is configured.'
          : control.status === 'attention'
            ? 'A browser or desktop connector is present but needs trust, connection, or schema review before use.'
          : 'Live browser navigation, UI testing, screenshots, screen recording, and desktop or device actions need a trusted MCP server or first-class tool before the Agent can perform them.',
        nextAction: control.configured
          ? 'Inspect the browser/desktop execution route before using live UI automation.'
          : control.status === 'attention'
            ? 'Review the matching MCP server trust, connection, and schema freshness before using live UI automation.'
          : 'Configure and review a trusted browser or desktop MCP server, then inspect the execution route before offering live UI automation.',
        userRoute: 'Agent Workspace -> Tools & MCP',
        modelRoute: control.recommendedRoute,
        signals: browserControlSignals(control),
      };
    } },
    { id: 'sudo-execution-posture', build: () => {
      const sudo = sudoPosture();
      return {
        id: 'sudo-execution-posture',
        label: 'Sudo execution posture',
        status: sudo.setupStatus,
        priority: 66,
        blocksAutonomy: false,
        reason: 'Privilege escalation must stay explicit, visible, and user-supervised; background sudo prompts, stdin password writes, and raw password display are blocked until the platform/daemon publishes safe mediation.',
        nextAction: sudo.nextAction,
        userRoute: 'Agent Workspace -> Work & Approvals -> Process capabilities',
        modelRoute: sudo.setupRoute,
        signals: sudo.signals,
        sudoPosture: sudo,
      };
    } },
    { id: 'build-delegation', build: () => {
      const tuiDelegation = capability('tui-delegation');
      return {
        id: 'build-delegation',
        label: 'Build delegation boundary',
        status: setupPlanStatusForCapability(tuiDelegation, 'optional'),
        priority: 70,
        blocksAutonomy: false,
        reason: tuiDelegation.detail,
        nextAction: 'Use delegation for explicit build, fix, review, isolation, or parallelism work rather than as a setup prerequisite.',
        userRoute: 'Agent Workspace -> Work & Approvals -> Delegate a build task',
        modelRoute: 'delegation action:"status"',
        relatedSetupItemId: tuiDelegation.id,
      };
    } },
    { id: 'finish-onboarding', build: () => {
      const setupMarkerDone = setupCompletionMarkerExists(context);
      return {
        id: 'finish-onboarding',
        label: 'Finish onboarding state',
        status: setupMarkerDone ? 'ready' : 'recommended',
        priority: 80,
        blocksAutonomy: false,
        reason: setupMarkerDone ? 'A setup marker already exists for this Agent scope.' : 'No setup marker exists yet, so the user may see first-run guidance again.',
        nextAction: setupMarkerDone ? 'Reopen setup only when changing provider, channel, automation, or local behavior decisions.' : 'Open onboarding, review the selected choices, then apply and close when the assistant is usable.',
        userRoute: 'Agent Workspace -> Finish',
        modelRoute: 'agent_harness mode:"open_ui_surface" surfaceId:"onboarding"',
      };
    } },
  ];

  const plan: SetupPlanItem[] = [];
  for (const row of rows) {
    if (only && !only.has(row.id)) continue;
    options.signal?.throwIfAborted();
    plan.push(await row.build());
  }
  options.assertCurrent?.();
  return plan.sort((left, right) => left.priority - right.priority);
}

/** The ids of every plan row, for exact lookups that need no observation. */
export const SETUP_PLAN_ROW_IDS: readonly string[] = ['connected-host-readiness', 'connected-host-auth', 'goodvibes-settings-import', 'provider-access',
  'install-smoke', 'local-model-readiness', 'agent-knowledge', 'vibe-personality', 'local-behavior', 'communication-channels', 'automation-review',
  'browser-desktop-control', 'sudo-execution-posture', 'build-delegation', 'finish-onboarding'];
