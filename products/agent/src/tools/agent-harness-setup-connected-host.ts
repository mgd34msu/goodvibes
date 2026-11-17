import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { serviceExpectedOutcome, type ServiceMethodId } from './agent-service-lifecycle.ts';
import { captureAsyncHarnessInput } from './agent-harness-async-input.ts';
import { resolveConnectedHostBaseUrl } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { getOperatorContract } from '@goodvibes-jev/engine/platform/contracts';
import { requirePlatform, requireShellPaths } from '../input/commands/runtime-services.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { CliServicePosture } from '../cli/service-posture.ts';
import { readConnectedHostOperatorToken } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { readConnectedHostReadiness } from '../runtime/connected-host-readiness.ts';
import { operatorMethodRoute, provisionConnectedHostTokenRoute } from './agent-harness-setup-posture-utils.ts';
import { homeRelativePath } from './agent-harness-tool-utils.ts';
import type { OperatorContractMethod, SetupBootstrapPlan, SetupConnectedHostAuthPosture, SetupPlanStatus, SetupRepairCard, SetupRepairCardEffect, SetupRepairLiveEvidence, SetupRepairOutcome, SetupRepairRecommendation, SetupRepairCardState, SetupServiceLifecycleDecision, SetupServiceProbe, SetupServiceProbeStatus } from './agent-harness-setup-posture-types.ts';
import type { collectSnapshot } from './agent-harness-setup-posture-utils.ts';

export function connectedHostServiceProbe(posture: CliServicePosture | null, probeFailure?: string): SetupServiceProbe {
  const endpoint = posture?.endpoints.find((candidate) => candidate.id === 'controlPlane');
  if (!posture || !endpoint) {
    return {
      status: 'not-probed',
      endpointId: 'controlPlane',
      label: 'runtime connection',
      enabled: false,
      binding: '(unavailable)',
      diagnosticRoute: 'host action:"services" includeParameters:true',
      issues: [probeFailure ? `Service posture probe failed: ${probeFailure}. Fix the cause and rerun host action:"services".` : 'Service posture probe is unavailable in this runtime.'],
    };
  }
  const binding = `${endpoint.binding.host}:${endpoint.binding.port}`;
  const status: SetupServiceProbeStatus = !endpoint.enabled
    ? 'not-enabled'
    : endpoint.reachable === true
      ? 'reachable'
      : endpoint.reachable === false
        ? 'unreachable'
        : 'not-probed';
  return {
    status,
    endpointId: endpoint.id,
    label: endpoint.label,
    enabled: endpoint.enabled,
    binding,
    diagnosticRoute: 'host action:"service" endpointId:"controlPlane"',
    issues: posture.issues,
  };
}

export function serviceProbeSignal(probe: SetupServiceProbe): string {
  return `runtime connection probe: ${probe.status} ${probe.binding}`;
}

export function repairLiveEvidence(probe: SetupServiceProbe, summary: string): SetupRepairLiveEvidence {
  return {
    probeStatus: probe.status,
    summary,
  };
}

export function lifecycleRepairRecommendation(probe: SetupServiceProbe): SetupRepairRecommendation {
  if (probe.status === 'reachable') return 'not-needed';
  return 'inspect-first';
}

export function hostSetupStatus(snapshot: Awaited<ReturnType<typeof collectSnapshot>>, probe: SetupServiceProbe): SetupPlanStatus {
  if (snapshot.collectionIssues.some((issue) => issue.area === 'host')) return 'blocked';
  if (probe.status === 'unreachable') return 'blocked';
  return 'check';
}

export async function connectedHostAuthPosture(
  context: CommandContext,
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
  options: CatalogRankingOptions = {},
): Promise<SetupConnectedHostAuthPosture> {
  const caller = captureAsyncHarnessInput(snapshot, options);
  const shellPaths = requireShellPaths(context);
  const token = readConnectedHostOperatorToken(shellPaths.homeDirectory, resolveConnectedHostBaseUrl(requirePlatform(context).configManager));
  const nativeIntake = await readConnectedHostReadiness({ configManager: requirePlatform(context).configManager, homeDirectory: () => requireShellPaths(context).homeDirectory }, caller.options);
  caller.assertCurrent();
  const usable = Boolean(token.token);
  return {
    owner: 'connected-host',
    nativeIntake,
    operatorToken: {
      present: token.present,
      usable,
      path: homeRelativePath(token.path, shellPaths.homeDirectory),
      ...(token.error ? { error: token.error } : {}),
    },
    compatibilityAuth: {
      userStorePath: homeRelativePath(snapshot.auth.snapshot.userStorePath, shellPaths.homeDirectory),
      userStorePresent: snapshot.auth.snapshot.persisted,
      bootstrapCredentialPath: homeRelativePath(snapshot.auth.snapshot.bootstrapCredentialPath, shellPaths.homeDirectory),
      bootstrapCredentialPresent: snapshot.auth.snapshot.bootstrapCredentialPresent,
      users: snapshot.auth.snapshot.userCount,
      sessions: snapshot.auth.snapshot.sessionCount,
    },
    routes: {
      reviewCommand: '/auth review',
      connectedHostStatus: 'host action:"status" includeParameters:true',
      pairingPosture: 'agent_harness mode:"pairing_posture" includeParameters:true',
      qrPairingRoute: 'agent_harness mode:"pairing_route" pairingRouteId:"qr-pairing"',
      manualTokenRoute: 'agent_harness mode:"pairing_route" pairingRouteId:"manual-token-display"',
      provisionTokenRoute: provisionConnectedHostTokenRoute(),
      tokenProvisioningOwner: 'connected GoodVibes host canonical token store',
      tokenProvisioningSource: 'platform getOrCreateCompanionToken writes ~/.goodvibes/daemon/operator-tokens.json with mode 0600; Agent exposes it only through confirmed setup and never returns the raw token',
    },
  };
}

/**
 * The one reading of connected-host auth. The row's status, next action,
 * model route, primary handoff and repair reason are all read from it.
 */
export type ConnectedHostAuthState =
  | 'ready'
  | 'review-bootstrap-credential'
  | 'needs-owner-pairing'
  | 'needs-token'
  | 'review-pairing-store'
  | 'needs-host';

export function connectedHostAuthState(posture: SetupConnectedHostAuthPosture): ConnectedHostAuthState {
  if (posture.operatorToken.path === 'Agent host-bound pairing store' && !posture.operatorToken.usable) return 'review-pairing-store';
  switch (posture.nativeIntake.status) {
    case 'ready': return posture.compatibilityAuth.bootstrapCredentialPresent ? 'review-bootstrap-credential' : 'ready';
    case 'unsupported-principal': return 'needs-owner-pairing';
    case 'missing-credential': return 'needs-token';
    default: return posture.operatorToken.usable ? 'needs-host' : 'needs-token';
  }
}

export function connectedHostAuthStatus(posture: SetupConnectedHostAuthPosture): SetupPlanStatus {
  const state = connectedHostAuthState(posture);
  return state === 'ready' ? 'ready' : state === 'review-bootstrap-credential' ? 'check' : 'blocked';
}

export const OWNER_PAIRING_COMMAND = '/setup pair --apply';
const PAIRING_PREVIEW_ROUTE = 'agent_harness mode:"run_command" command:"/setup pair"';
const HOST_STATUS_ROUTE = 'host action:"status" includeParameters:true';

export function connectedHostAuthNextAction(posture: SetupConnectedHostAuthPosture): string {
  switch (connectedHostAuthState(posture)) {
    case 'review-pairing-store':
      return 'The Agent pairing store needs review. Run goodvibes-agent setup pair to inspect the prior host-bound attempt. Do not provision another shared token or retry migration while its outcome is unknown or the store is unsafe.';
    case 'ready':
      return 'Verify the connection against connected-host status and Agent Knowledge readiness before relying on protected daemon routes.';
    case 'review-bootstrap-credential':
      return 'Review auth status and clear or rotate the compatibility bootstrap credential through the owning GoodVibes host if it is no longer needed.';
    case 'needs-owner-pairing':
      return `${posture.nativeIntake.detail} Only the owner can grant it: ask the owner to type ${OWNER_PAIRING_COMMAND} in the live Agent terminal (or run goodvibes-agent setup pair --apply) and confirm the exact phrase it shows; /setup pair previews it first. The model and nested commands cannot grant it, and checking host status again does not change it.`;
    case 'needs-token':
      return posture.operatorToken.present
        ? 'Run the confirmed connected-host token provisioning route to repair the local token file, then rerun auth review and connected-host status.'
        : 'Run the confirmed connected-host token provisioning route, inspect pairing posture for visible handoff routes, then rerun auth review and connected-host status.';
    case 'needs-host':
      return posture.nativeIntake.detail;
  }
}

export function connectedHostAuthModelRoute(posture: SetupConnectedHostAuthPosture): string {
  switch (connectedHostAuthState(posture)) {
    case 'review-pairing-store':
    case 'needs-owner-pairing':
      return PAIRING_PREVIEW_ROUTE;
    case 'needs-token':
      return posture.routes.provisionTokenRoute;
    default:
      return HOST_STATUS_ROUTE;
  }
}

export function connectedHostAuthRepairReason(posture: SetupConnectedHostAuthPosture): string {
  switch (connectedHostAuthState(posture)) {
    case 'review-pairing-store':
      return 'Host-bound pairing needs read-only review; shared-token provisioning cannot resolve an unknown or unsafe pairing store.';
    case 'needs-owner-pairing':
      return 'The host does not verify this credential as the owner; the only repair is the owner running the pairing command, which no model route can do.';
    case 'needs-token':
      return 'Connected-host token is missing or unusable; token provisioning is the narrow confirmed repair.';
    case 'needs-host':
      return 'The auth check could not reach a verdict from the host; inspect connected-host status for the cause before any credential action.';
    default:
      return 'Connected-host auth needs verification, not repair; verify protected daemon route readiness before relying on automation.';
  }
}

export function connectedHostAuthSignals(posture: SetupConnectedHostAuthPosture): readonly string[] {
  return [
    `native intake auth: ${posture.nativeIntake.status}; ${posture.nativeIntake.detail}`,
    `operator token: ${posture.operatorToken.usable ? 'readable (not authority evidence)' : posture.operatorToken.present ? 'present but unusable' : 'missing'} (${posture.operatorToken.path})`,
    ...(posture.operatorToken.error ? [`operator token parse error: ${posture.operatorToken.error}`] : []),
    `token provisioning route: ${posture.routes.provisionTokenRoute}`,
    `compatibility auth users: ${posture.compatibilityAuth.users}`,
    `compatibility auth sessions: ${posture.compatibilityAuth.sessions}`,
    `bootstrap credential: ${posture.compatibilityAuth.bootstrapCredentialPresent ? 'present' : 'missing'} (${posture.compatibilityAuth.bootstrapCredentialPath})`,
    `token provisioning owner: ${posture.routes.tokenProvisioningOwner}`,
    `token provisioning source: ${posture.routes.tokenProvisioningSource}`,
  ];
}

export function operatorMethodIds(): ReadonlySet<string> {
  const contract = getOperatorContract();
  const methods = Array.isArray(contract.operator?.methods)
    ? contract.operator.methods as OperatorContractMethod[]
    : [];
  return new Set(methods.map((method) => method.id).filter(Boolean));
}

export function setupRepairCard(
  methodIds: ReadonlySet<string>,
  options: {
    readonly id: string;
    readonly label: string;
    readonly methodId?: string;
    readonly effect: SetupRepairCardEffect;
    readonly userRoute: string;
    readonly prerequisite?: string;
    readonly recommendation?: SetupRepairRecommendation;
    readonly liveEvidence?: SetupRepairLiveEvidence;
    readonly outcome?: SetupRepairOutcome;
    readonly recommendedWhen: string;
    readonly safety: string;
    readonly liveHostRequired?: boolean;
  },
): SetupRepairCard {
  const methodPresent = options.methodId ? methodIds.has(options.methodId) : true;
  const state: SetupRepairCardState = !methodPresent
    ? 'missing'
    : options.liveHostRequired
      ? 'requires-live-host'
      : 'available';
  return {
    id: options.id,
    label: options.label,
    state,
    effect: options.effect,
    ...(options.methodId ? { methodId: options.methodId } : {}),
    ...(options.methodId && methodPresent ? { modelRoute: operatorMethodRoute(options.methodId) } : {}),
    userRoute: options.userRoute,
    ...(options.prerequisite ? { prerequisite: options.prerequisite } : {}),
    recommendation: !methodPresent || state === 'requires-live-host' ? 'unavailable' : options.recommendation ?? 'inspect-first',
    ...(options.liveEvidence ? { liveEvidence: options.liveEvidence } : {}),
    ...(options.outcome ? { outcome: options.outcome } : {}),
    recommendedWhen: options.recommendedWhen,
    safety: options.safety,
  };
}

/** The method's success criteria, from the one service lifecycle module the operator-method tool also applies. */
export function serviceRepairOutcome(methodId: ServiceMethodId): SetupRepairOutcome {
  return serviceExpectedOutcome(methodId);
}

export function connectedHostRepairCards(
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
  probe: SetupServiceProbe,
): readonly SetupRepairCard[] {
  const methodIds = operatorMethodIds();
  const hostIssue = snapshot.collectionIssues.some((issue) => issue.area === 'host');
  const liveHostPrerequisite = hostIssue
    ? 'Run connected-host status first; confirmed service methods require a reachable compatible operator endpoint and usable token.'
    : 'Requires a reachable compatible operator endpoint and usable token.';
  const statusRecommendation: SetupRepairRecommendation = probe.status === 'unreachable'
    ? 'recommended'
    : probe.status === 'reachable'
      ? 'not-needed'
      : 'inspect-first';
  const postureRecommendation: SetupRepairRecommendation = probe.status === 'unreachable' || probe.issues.length > 0
    ? 'recommended'
    : probe.status === 'reachable'
      ? 'not-needed'
      : 'inspect-first';
  const lifecycleRecommendation = lifecycleRepairRecommendation(probe);
  return [
    {
      id: 'connected-host-status',
      label: 'Inspect connected-host status',
      state: 'available',
      effect: 'read-only',
      modelRoute: 'host action:"status" includeParameters:true',
      userRoute: '/compat',
      recommendation: statusRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is reachable; use connected-host status when token, compatibility, or Knowledge readiness still needs review.'
        : probe.status === 'unreachable'
          ? 'Runtime endpoint is enabled but not reachable; inspect connected-host status and service posture before any lifecycle mutation.'
          : 'Runtime endpoint reachability is not proven; inspect connected-host status before lifecycle mutation.'),
      recommendedWhen: 'Use first for every host setup or repair question.',
      safety: 'Read-only diagnostic; returns redacted token posture and route readiness.',
    },
    {
      id: 'service-posture',
      label: 'Inspect service posture',
      state: 'available',
      effect: 'read-only',
      modelRoute: 'host action:"services" includeParameters:true',
      userRoute: '/health',
      recommendation: postureRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.issues.length > 0
        ? `Service posture reports ${probe.issues.length} issue(s); inspect endpoint binding, reachability, and logs before mutation.`
        : probe.status === 'reachable'
          ? 'Runtime endpoint is reachable and service posture has no current probe issue.'
          : 'Inspect endpoint binding, reachability, and logs before choosing a lifecycle action.'),
      recommendedWhen: 'Use when endpoints, bind addresses, ports, logs, or listener exposure may be the blocker.',
      safety: 'Read-only diagnostic; probes endpoints only when requested with includeParameters.',
    },
    setupRepairCard(methodIds, {
      id: 'service-status',
      label: 'Read service install/runtime status',
      methodId: 'services.status',
      effect: 'read-only',
      userRoute: '/compat',
      prerequisite: liveHostPrerequisite,
      recommendation: statusRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is reachable; service status is optional unless the user is auditing install/autostart posture.'
        : 'Read service status before deciding whether install, start, or restart is actually needed.'),
      outcome: serviceRepairOutcome('services.status'),
      recommendedWhen: 'Use when the daemon is reachable and the user needs install/autostart/running posture.',
      safety: 'Read-only daemon method.',
      liveHostRequired: hostIssue,
    }),
    setupRepairCard(methodIds, {
      id: 'service-install',
      label: 'Install service',
      methodId: 'services.install',
      effect: 'confirmed-effect',
      userRoute: 'Connected-host service control',
      prerequisite: liveHostPrerequisite,
      recommendation: lifecycleRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is already reachable; install is not recommended without service status evidence.'
        : 'Install is not recommended from endpoint reachability alone; require service status to prove the service is not installed.'),
      outcome: serviceRepairOutcome('services.install'),
      recommendedWhen: 'Use only when service status says the platform service is not installed and the user explicitly asks to install it.',
      safety: 'Confirmed service mutation; no uninstall or stop action is included in first-run setup.',
      liveHostRequired: hostIssue,
    }),
    setupRepairCard(methodIds, {
      id: 'service-start',
      label: 'Start service',
      methodId: 'services.start',
      effect: 'confirmed-effect',
      userRoute: 'Connected-host service control',
      prerequisite: liveHostPrerequisite,
      recommendation: lifecycleRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is already reachable; start is not recommended without service status evidence.'
        : 'Start is not recommended from endpoint reachability alone; require service status to prove the service is installed but stopped.'),
      outcome: serviceRepairOutcome('services.start'),
      recommendedWhen: 'Use only when service status says the service is installed but not running and the user explicitly asks to start it.',
      safety: 'Confirmed service mutation.',
      liveHostRequired: hostIssue,
    }),
    setupRepairCard(methodIds, {
      id: 'service-restart',
      label: 'Restart service',
      methodId: 'services.restart',
      effect: 'confirmed-effect',
      userRoute: 'Connected-host service control',
      prerequisite: liveHostPrerequisite,
      recommendation: lifecycleRecommendation,
      liveEvidence: repairLiveEvidence(probe, probe.status === 'reachable'
        ? 'Runtime endpoint is reachable; restart is not recommended unless diagnostics prove the host is unhealthy or incompatible.'
        : 'Restart is not recommended from endpoint reachability alone; require diagnostics or service status to prove a running unhealthy service.'),
      outcome: serviceRepairOutcome('services.restart'),
      recommendedWhen: 'Use only when the service is running but unhealthy or incompatible and the user explicitly asks to restart it.',
      safety: 'Confirmed service mutation; use diagnostics first to avoid disrupting a healthy host.',
      liveHostRequired: hostIssue,
    }),
  ];
}

export function setupServiceLifecycleDecision(
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
  probe: SetupServiceProbe,
): SetupServiceLifecycleDecision {
  const methodIds = operatorMethodIds();
  const statusPublished = methodIds.has('services.status');
  const hostIssue = snapshot.collectionIssues.some((issue) => issue.area === 'host');
  const evidence = {
    probeStatus: probe.status,
    binding: probe.binding,
    hostIssue,
    serviceStatusMethodPublished: statusPublished,
  };
  if (hostIssue) {
    return {
      status: 'bootstrap-first',
      recommendedAction: 'inspect-service-posture',
      modelRoute: 'host action:"services" includeParameters:true',
      reason: 'Agent cannot trust connected-host lifecycle methods until the owning host is reachable enough to return compatible status evidence.',
      evidence,
    };
  }
  if (!statusPublished) {
    return {
      status: 'status-route-unavailable',
      recommendedAction: 'inspect-service-posture',
      modelRoute: 'host action:"services" includeParameters:true',
      reason: 'The connected-host operator contract does not publish services.status, so setup cannot select install/start/restart from a service receipt.',
      evidence,
    };
  }
  if (probe.status === 'reachable') {
    return {
      status: 'no-lifecycle-action',
      recommendedAction: 'none',
      modelRoute: operatorMethodRoute('services.status'),
      reason: 'The runtime endpoint is reachable; no install/start/restart mutation is justified by probe evidence alone. Read services.status only for install/autostart audit or setup closeout.',
      evidence,
    };
  }
  return {
    status: 'needs-status-receipt',
    recommendedAction: 'read-services-status',
    modelRoute: operatorMethodRoute('services.status'),
    reason: 'No services.status receipt yet: probe evidence alone does not choose install, start or restart. Read services.status; its result carries the lifecycle decision.',
    evidence,
  };
}

export function connectedHostBootstrapPlan(
  snapshot: Awaited<ReturnType<typeof collectSnapshot>>,
  probe: SetupServiceProbe,
): SetupBootstrapPlan {
  const hostIssue = snapshot.collectionIssues.some((issue) => issue.area === 'host');
  const probeIssue = probe.status === 'unreachable';
  return {
    status: hostIssue || probeIssue ? 'recommended' : 'optional',
    source: 'docs/installation.md (the release installer) and the installed goodvibes, goodvibes-daemon and goodvibes-agent commands',
    recommendedWhen: hostIssue
      ? 'Use when Agent cannot reach a compatible connected host, so operator service methods cannot be trusted yet.'
      : probeIssue
        ? 'Use when the configured runtime connection is enabled but unreachable, before confirmed service methods have proven an install/start fix.'
      : 'Use only when the user is setting up a new GoodVibes host or wants to verify the owning host install.',
    steps: [
      {
        id: 'install-goodvibes-host',
        label: 'Install the owning GoodVibes host',
        purpose: 'Install the released goodvibes launcher and goodvibes-daemon with the release installer; it ships binaries and needs no Bun, Node or Git.',
        commands: [
          'curl -fsSL https://goodvibes.sh/install.sh | sh',
        ],
        expected: 'The installer finishes, verifies the release checksums and prints the installed program paths.',
        fallback: 'See docs/installation.md for installer options (version pin, install directory, service registration) and what to do when a download or checksum fails.',
      },
      {
        id: 'verify-goodvibes-binaries',
        label: 'Verify host binaries',
        purpose: 'Confirm the installer put both user-facing and daemon entrypoints on PATH.',
        commands: [
          'goodvibes --version',
          'goodvibes-daemon --version',
        ],
        expected: 'Both binaries print versions.',
        fallback: 'Open a new terminal so PATH is refreshed, or rerun the installer and read its PATH note (docs/installation.md).',
      },
      {
        id: 'start-goodvibes-host',
        label: 'Start or install the host service',
        purpose: 'Bring up the daemon/API host that owns schedules, channels, Knowledge, media, and operator routes.',
        commands: [
          'goodvibes service status',
          'goodvibes service install',
          'goodvibes service start',
        ],
        expected: 'Service status reports an installed running service.',
        fallback: 'See docs/installation.md for service registration on this platform.',
      },
      {
        id: 'reconnect-agent',
        label: 'Reconnect Agent to the host',
        purpose: 'Verify Agent can reach the default host or an explicitly configured runtime URL.',
        commands: [
          'goodvibes-agent status --json',
        ],
        expected: 'Agent status reports a reachable connected host.',
        fallback: 'Use goodvibes-agent --runtime-url http://host:port or GOODVIBES_AGENT_RUNTIME_URL=http://host:port when the host is not on http://127.0.0.1:3421.',
      },
    ],
    reconnectRoutes: {
      agentStatus: 'host action:"status" includeParameters:true',
      serviceDiagnostics: 'host action:"services" includeParameters:true',
      setupItem: 'setup action:"item" setupItemId:"connected-host-readiness"',
    },
    policy: 'Bootstrap commands are user-run setup guidance. At boot the Agent runtime starts an already-installed host whose service is stopped, through the platform service manager, and reports it; beyond that one bounded boot behavior the Agent does not run host install/start commands implicitly, and once the host is reachable exact service mutations stay on confirmed operator methods.',
  };
}
