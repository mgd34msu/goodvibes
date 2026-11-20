import { captureCliStatusFacts, describeCliPermissionMode, describeCliSignIns, secretPolicyLabel, type CliModelInUse, type CliProviderSignInFacts } from '@goodvibes/engine/terminal-shell/cli-status-facts';
import type { PermissionModeInForce } from '@goodvibes/engine/platform/platform/permissions';
import { yesNo } from '@goodvibes/engine/terminal-shell/cli-output';
import type { ConnectedHostReadiness } from '../runtime/connected-host-readiness.ts';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { OnboardingCheckMarkerState } from '../runtime/onboarding/index.ts';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import type { GoodVibesCliOutputFormat } from './types.ts';
import type { CliServicePosture } from './service-posture.ts';
import type { CliExternalRuntimeSnapshot } from './external-runtime.ts';
import type { CliConnectedHostMetricsSnapshot } from './connected-host-metrics.ts';
import type { CredentialAvailability } from '../config/credential-status.ts';
import { getProviderIdFromModel } from '@goodvibes/engine/terminal-shell/agent-turn/provider-model';
import { formatAgentRecordSource } from '@goodvibes/engine/terminal-shell/agent-turn/record-labels';
import { formatAgentKnowledgeFailureKind } from '@goodvibes/engine/terminal-shell/agent-turn/knowledge-format';
import { readApprovalPostureFromConfig, type ApprovalPosture } from '../permissions/approval-posture.ts';
import { appendTemporalLabel } from './temporal-label.ts';
import { describeCrashLog, summarizeCrashLog, surfaceCrashLogPath, type CrashLogSummary } from '@goodvibes/engine/platform/platform/runtime/crash-capture';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

/**
 * The marker that decides first-run state, when it holds a payload this build
 * reads; a damaged or set-aside marker is "not done" here as at start-up
 * (runtime/onboarding/completion.ts).
 */
function effectiveMarker(marker: OnboardingCheckMarkerState | undefined): OnboardingCheckMarkerState | null {
  return marker?.payload ? marker : null;
}

export interface CliStatusOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** How the configured model's provider is signed in and where its model list came from (read from files by the caller). */
  readonly providerSignIn?: CliProviderSignInFacts;
  /** The model a run would use, resolved by the provider registry (the caller builds it). */
  readonly modelInUse?: CliModelInUse;
  /** The marker that decides whether setup is done (`readOnboardingDoneMarker`); absent when not read. */
  readonly onboardingMarker?: OnboardingCheckMarkerState;
  readonly nativeReadiness?: ConnectedHostReadiness;
  readonly pairingStatus?: string;
  readonly selectedHost?: string;
  readonly auth?: CliAuthStatus;
  readonly service?: CliServicePosture;
  readonly externalRuntime?: CliExternalRuntimeSnapshot;
  readonly connectedHostMetrics?: CliConnectedHostMetricsSnapshot;
  /** Secret-free credential status from the connected host (credentials.get); absent when the host was not reachable. */
  readonly connectedHostCredentials?: CredentialAvailability;
  readonly checkpoints?: CliCheckpointsStatus;
  readonly doctor?: boolean;
  readonly outputFormat?: GoodVibesCliOutputFormat;
}

/**
 * Registered-workspaces-only checkpoint posture (owner ruling, 2026-07-10; see
 * ../config/workspace-registration.ts and ../runtime/services.ts). Computed by the
 * caller (entrypoint.ts already builds a ShellPathService for status/doctor)
 * and passed in here so this module stays a pure renderer.
 */
export interface CliCheckpointsStatus {
  readonly workspaceRegistered: boolean;
  readonly unregisteredWorkspaceMode: 'off' | 'guarded';
}

export interface CliAuthStatus {
  readonly userStorePath: string;
  readonly userStorePresent: boolean;
  readonly bootstrapCredentialPath: string;
  readonly bootstrapCredentialPresent: boolean;
  readonly operatorTokenPath: string;
  readonly operatorTokenPresent: boolean;
}

export interface CliDoctorFinding {
  readonly id: string;
  readonly area: 'auth' | 'onboarding' | 'runtime' | 'security' | 'secrets';
  /**
   * `risk` must be fixed and fails `doctor`; `warning` is a note on a usable
   * install; `note` states how the installation is arranged and asks for nothing.
   */
  readonly severity: 'note' | 'warning' | 'risk';
  readonly summary: string;
  readonly cause: string;
  readonly impact: string;
  readonly action: string;
}

export interface CliStatusSnapshot {
  readonly title: 'GoodVibes Agent status' | 'GoodVibes Agent doctor';
  /** This program's crash log: faults recorded, the newest, and where the records are. */
  readonly crashLog: CrashLogSummary;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly provider: {
    readonly provider: string;
    readonly model: string;
    readonly reasoning: string;
    /** Why the model cannot be used (no registered provider has its name) and how to choose another. */
    readonly problem?: string | undefined;
    /** Sign-ins in the order requests use them, and the model list's source and age. */
    readonly signIn?: CliProviderSignInFacts | undefined;
  };
  readonly auth: {
    readonly permissionMode: unknown;
    /** The mode in force for a session started now, and why it is not the saved mode. */
    readonly permissionModeInForce: PermissionModeInForce;
    readonly permissionLabel: string;
    readonly autoApprove: boolean;
    readonly automaticApprovals: boolean;
    readonly bypassesPrompts: boolean;
    readonly permissionDetail: string;
    readonly secretPolicy: unknown;
    readonly secretPolicyLabel: string;
    readonly runtimeAuthSignal: CliAuthStatus | null;
  };
  readonly runtimeConnection: {
    readonly enabled: unknown;
    readonly autostart: unknown;
    readonly restartOnFailure: unknown;
    readonly lifecycle?: CliServicePosture;
  };
  readonly externalRuntime: CliExternalRuntimeSnapshot | null;
  readonly connectedHostMetrics: CliConnectedHostMetricsSnapshot | null;
  readonly connectedHostCredentials: CredentialAvailability | null;
  readonly relay: {
    readonly enabled: boolean;
    readonly url: string;
    readonly requireStepUpForMutations: boolean;
    readonly liveVerified: false;
  };
  readonly runtimeEndpoints: {
    readonly controlPlane: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown };
    readonly httpListener: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown };
    readonly web: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown };
  };
  readonly onboarding: {
    readonly checked: boolean;
    readonly scope: string;
    readonly updatedAt: number | null;
  };
  /** Whether a decision model is in use, from the settings: the policy as shown and the standing line. */
  readonly decisionModel: {
    readonly policy: string;
    readonly policyLabel: string;
    readonly set: boolean;
    readonly inUse: boolean;
    readonly line: string;
  };
  readonly checkpoints: {
    readonly automaticCheckpointsActive: boolean;
    readonly workspaceRegistered: boolean;
    readonly unregisteredWorkspaceMode: 'off' | 'guarded';
    readonly statusLine: string;
  } | null;
  readonly findings: readonly CliDoctorFinding[];
}

/**
 * The one honest line this surface must never omit or soften (owner ruling,
 * 2026-07-10): whether automatic checkpoints are active for THIS working
 * directory, and why. `"checkpoints off: workspace not registered"` is the
 * literal wording the ruling calls for the default (unregistered, `"off"`) case.
 */
function checkpointsStatusLine(checkpoints: CliCheckpointsStatus): { active: boolean; line: string } {
  if (checkpoints.workspaceRegistered) {
    return { active: true, line: 'checkpoints on: workspace registered' };
  }
  if (checkpoints.unregisteredWorkspaceMode === 'guarded') {
    return { active: true, line: 'checkpoints on: unregistered workspace allowed via checkpoints.unregisteredWorkspaces="guarded"' };
  }
  return { active: false, line: 'checkpoints off: workspace not registered' };
}

/** The connected host's credential status: how many are stored and usable, or why it is not known. */
function connectedHostCredentialLines(credentials: CredentialAvailability | null): string[] {
  if (credentials === null) return ['  not shown: the connected host was not reachable.'];
  if (!credentials.available) return [`  not shown: ${credentials.reason}`];
  const configured = credentials.credentials.filter((entry) => entry.configured);
  const unusable = configured.filter((entry) => !entry.usable && !entry.notChecked).map((entry) => entry.key);
  const notChecked = configured.filter((entry) => entry.notChecked).map((entry) => entry.key);
  return [
    `  stored: ${configured.length} of ${credentials.credentials.length}`,
    ...(unusable.length > 0 ? [`  stored but not usable: ${unusable.join(', ')}`] : []),
    ...(notChecked.length > 0 ? [`  held by a password manager, not checked here: ${notChecked.join(', ')}`] : []),
  ];
}

/**
 * The connected-host runtime-metrics lines. Each non-ok state is rendered as a
 * plain sentence naming exactly why there are no numbers to show, most
 * importantly, a token without the read:telemetry scope reads as "not
 * permitted", never as a wall of zeros that would misrepresent an unauthorized
 * token as a healthy idle host.
 */
function connectedHostMetricsLines(snapshot: CliConnectedHostMetricsSnapshot | null): string[] {
  if (!snapshot) return ['  live check unavailable'];
  switch (snapshot.status) {
    case 'ok': {
      const m = snapshot.metrics!;
      return [
        `  http requests total: ${m.httpRequestsTotal}`,
        `  llm requests total: ${m.llmRequestsTotal}`,
        `  auth success/failure: ${m.authSuccessTotal}/${m.authFailureTotal}`,
        `  transport retries total: ${m.transportRetriesTotal}`,
        `  sessions active: ${m.sessionsActive}`,
        `  sse subscribers: ${m.sseSubscribers}`,
        `  telemetry buffer fill: ${m.telemetryBufferFill}`,
      ];
    }
    case 'scope_missing':
      return [
        `  not shown: the connected-host token does not include the ${snapshot.requiredScope} scope required by ${snapshot.methodId}.`,
      ];
    case 'auth_required':
      return ['  not shown: connected-host operator token is missing or unauthenticated.'];
    case 'route_unavailable':
      return [`  not shown: this connected host does not expose ${snapshot.route} (incompatible or older daemon).`];
    case 'unavailable':
      return [`  not shown: connected host is not reachable${snapshot.error ? ` (${snapshot.error})` : '.'}`];
    default:
      return [`  not shown: ${snapshot.error ?? 'runtime metrics could not be read.'}`];
  }
}

/** permissions.tools.* keys, mirrors PermissionsToolConfig in the platform config schema. */
/** Display the same effective execution preset used by the permission owner. */
function readApprovalPosture(config: Pick<ConfigManager, 'get'>): ApprovalPosture {
  return readApprovalPostureFromConfig(config);
}

/** A finding id from its own text, so the same finding keeps its id whatever else is reported before it. */
function findingSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
}

export function buildCliDoctorFindings(options: CliStatusOptions): readonly CliDoctorFinding[] {
  const config = options.configManager;
  const permissionMode = config.get('permissions.mode');
  const secretPolicy = config.get('storage.secretPolicy');
  const posture = readApprovalPosture(config);
  const marker = effectiveMarker(options.onboardingMarker);

  const findings: CliDoctorFinding[] = [];

  if (options.externalRuntime) {
    if (!options.externalRuntime.reachable) {
      findings.push({
        id: 'external-runtime-unreachable',
        area: 'runtime',
        severity: 'warning',
        summary: 'Connected GoodVibes host is not reachable.',
        cause: `Agent could not reach ${options.externalRuntime.baseUrl}${options.externalRuntime.error ? `: ${options.externalRuntime.error}` : '.'}`,
        impact:
          'Companion chat, isolated Agent Knowledge, approvals, automation status, and build delegation cannot work until the connected GoodVibes host is available.',
        action: 'Start the daemon it names. On this machine: goodvibes-daemon start-service (without a daemon service: goodvibes-daemon serve).',
      });
    } else if (!options.externalRuntime.compatible
      // With no token nothing was asked; the token finding below names the fix.
      && !(options.externalRuntime.agentKnowledge.probed === false && !options.externalRuntime.operatorToken.present)) {
      const refused = options.externalRuntime.agentKnowledge.probed === false;
      findings.push({
        id: 'external-runtime-incompatible',
        area: 'runtime',
        severity: 'warning',
        summary: 'Connected GoodVibes host compatibility does not satisfy Agent readiness.',
        cause:
          options.externalRuntime.agentKnowledge.probed === false
            ? `Connected host is reachable, but the Agent routes were not checked${options.externalRuntime.operatorToken.present ? ` because the host refused its status request${options.externalRuntime.statusCode === null ? '' : ` (HTTP ${options.externalRuntime.statusCode})`}` : ' because no operator token is present'}.`
            : 'Connected host is reachable, but at least one public Agent route is unavailable or incompatible.',
        impact: 'Agent-only routes, especially isolated Agent Knowledge, may be unavailable.',
        action: refused
          ? 'The daemon refused this Agent\'s token. Pair again: goodvibes-agent setup pair --apply'
          : 'The daemon and the Agent are different releases. Install one release of both: curl -fsSL https://goodvibes.sh/install.sh | sh',
      });
    }

    if (!options.externalRuntime.operatorToken.present) {
      findings.push({
        id: 'external-runtime-token-missing',
        area: 'auth',
        severity: 'warning',
        summary: 'Connected-host operator token is missing.',
        cause: `No operator token was found at ${options.externalRuntime.operatorToken.path}.`,
        impact: 'Agent can inspect only unauthenticated routes and cannot use protected connected-host APIs.',
        action: 'Pair this Agent with the daemon: goodvibes-agent setup pair --apply',
      });
    }

    if (
      options.externalRuntime.reachable &&
      options.externalRuntime.operatorToken.present &&
      options.externalRuntime.agentKnowledge.probed !== false &&
      !options.externalRuntime.agentKnowledge.ready
    ) {
      findings.push({
        id: 'agent-knowledge-route-not-ready',
        area: 'runtime',
        severity: 'warning',
        summary: 'Isolated Agent Knowledge route is not ready.',
        cause: `${options.externalRuntime.agentKnowledge.route} returned ${options.externalRuntime.agentKnowledge.kind}${options.externalRuntime.agentKnowledge.statusCode === null ? '' : ` (${options.externalRuntime.agentKnowledge.statusCode})`}.`,
        impact:
          'Agent Knowledge ask/search will not use default or non-Agent knowledge fallback; it will fail closed until the Agent route is available.',
        action: 'Update the connected GoodVibes host so public Agent routes are compatible, then verify goodvibes-agent compat.',
      });
    }
  }

  if (options.service) {
    // Advisories describe the arrangement the operator chose: printed under
    // Notes, never silent, and never a reason for doctor to fail.
    for (const advisory of options.service.advisories) {
      if (findings.some((finding) => finding.summary === advisory)) continue;
      findings.push({
        id: `runtime-posture-${findingSlug(advisory)}`,
        area: 'runtime',
        severity: 'note',
        summary: advisory,
        cause: 'The connected-host inspection found a deliberate arrangement worth stating.',
        impact: 'None on its own; it describes how this installation is set up.',
        action: 'No action needed unless this is not the arrangement you intended.',
      });
    }
    // Whole records from the posture builder, the same words the terminal app's doctor prints.
    for (const issue of options.service.findings) {
      if (findings.some((finding) => finding.summary === issue.summary)) continue;
      findings.push({ ...issue, area: 'runtime', severity: 'warning' });
    }
  }

  if (!marker?.exists) {
    findings.push({
      id: 'onboarding-incomplete',
      area: 'onboarding',
      severity: 'warning',
      summary: 'Agent setup has not been applied for this user.',
      cause: 'No global user setup completion marker was found.',
      impact: 'Provider/model, Agent Knowledge, local behavior, channel, and permission choices may still be implicit defaults.',
      action: 'Run /agent in GoodVibes Agent or goodvibes-agent setup status to review setup state.',
    });
  }

  if (posture.autoApprove) {
    findings.push({
      id: 'auto-approve-enabled',
      area: 'security',
      severity: 'risk',
      summary: 'YOLO execution is enabled by auto-approve.',
      cause: 'behavior.autoApprove is true.',
      impact: posture.detail,
      action: 'Disable behavior.autoApprove unless this is an intentionally trusted environment.',
    });
  }

  if (posture.mode === 'yolo') {
    findings.push({
      id: 'allow-all-permissions',
      area: 'security',
      severity: 'risk',
      summary: 'YOLO execution mode is active.',
      cause: 'The selected execution mode is YOLO.',
      impact: 'Powerful write, edit, network, and execution tools can run without a Human-in-the-Loop (HITL) approval prompt.',
      action: 'Select ask-me, jev-decides or just-vibes when dangerous actions need a safety decision.',
    });
  }

  if (secretPolicy === 'plaintext_allowed') {
    findings.push({
      id: 'plaintext-secrets-allowed',
      area: 'secrets',
      severity: 'risk',
      summary: 'Plaintext secret storage is allowed.',
      cause: 'storage.secretPolicy is plaintext_allowed.',
      impact: 'Provider keys and channel tokens may be stored without secure backend protection.',
      action: 'Use Require secure storage or Use secure storage when available for normal operation.',
    });
  }

  return findings;
}

export function buildCliStatusSnapshot(options: CliStatusOptions): CliStatusSnapshot {
  const config = options.configManager;
  const common = captureCliStatusFacts(config, effectiveMarker(options.onboardingMarker), options.service, getProviderIdFromModel, options.modelInUse);

  const findings = buildCliDoctorFindings(options);
  const posture = readApprovalPosture(config);
  return {
    title: options.doctor ? 'GoodVibes Agent doctor' : 'GoodVibes Agent status',
    crashLog: summarizeCrashLog(surfaceCrashLogPath(options.homeDirectory, GOODVIBES_AGENT_SURFACE_ROOT)),
    workingDirectory: options.workingDirectory,
    homeDirectory: options.homeDirectory,
    provider: { ...common.provider, ...(options.providerSignIn ? { signIn: options.providerSignIn } : {}) },
    auth: {
      ...common.auth,
      permissionLabel: posture.label,
      autoApprove: posture.autoApprove,
      automaticApprovals: posture.automaticApprovals,
      bypassesPrompts: posture.bypassesPrompts,
      permissionDetail: posture.detail,
      runtimeAuthSignal: options.auth ?? null,
    },
    runtimeConnection: common.service,
    externalRuntime: options.externalRuntime ?? null,
    connectedHostMetrics: options.connectedHostMetrics ?? null,
    connectedHostCredentials: options.connectedHostCredentials ?? null,
    relay: {
      enabled: config.get('relay.enabled') === true,
      url: String(config.get('relay.url') ?? ''),
      requireStepUpForMutations: config.get('relay.requireStepUpForMutations') === true,
      liveVerified: false,
    },
    runtimeEndpoints: common.endpoints,
    onboarding: common.onboarding,
    decisionModel: common.decisionModel,
    checkpoints: options.checkpoints
      ? {
          automaticCheckpointsActive: checkpointsStatusLine(options.checkpoints).active,
          workspaceRegistered: options.checkpoints.workspaceRegistered,
          unregisteredWorkspaceMode: options.checkpoints.unregisteredWorkspaceMode,
          statusLine: checkpointsStatusLine(options.checkpoints).line,
        }
      : null,
    findings,
  };
}

export function renderCliStatus(options: CliStatusOptions, snapshot: CliStatusSnapshot = buildCliStatusSnapshot(options)): string {
  const config = options.configManager;
  const marker = effectiveMarker(options.onboardingMarker);
  const findings = snapshot.findings;
  const externalRuntime = snapshot.externalRuntime;

  if (options.outputFormat === 'json') return JSON.stringify(snapshot, null, 2);

  const lines = [
    snapshot.title,
    `  working directory ${options.workingDirectory}`,
    `  home directory ${options.homeDirectory}`,
    '',
    'Provider',
    `  provider ${snapshot.provider.provider}`,
    `  model ${snapshot.provider.model}`,
    ...(snapshot.provider.problem ? [`  problem ${snapshot.provider.problem}`] : []),
    `  reasoning ${String(config.get('provider.reasoningEffort'))}`,
    ...(snapshot.provider.signIn ? [
      `  sign-in ${describeCliSignIns(snapshot.provider.signIn)}`,
      `  model list ${snapshot.provider.signIn.modelList}`,
    ] : []),
    '',
    'Decision model',
    `  when it is missing or fails: ${snapshot.decisionModel.policyLabel}`,
    `  ${snapshot.decisionModel.line}`,
    '',
    'Auth',
    ...describeCliPermissionMode(snapshot.auth.permissionModeInForce),
    `  autoApprove: ${yesNo(snapshot.auth.autoApprove)} (behavior.autoApprove)`,
    `  approval checks: ${snapshot.auth.permissionDetail}`,
    `  secretPolicy: ${secretPolicyLabel(config.get('storage.secretPolicy'))} (${String(config.get('storage.secretPolicy'))})`,
    // Local users and the setup credential belong to the daemon; the Agent
    // shows its own copies only when they exist, since nothing is wrong without them.
    ...(options.auth?.userStorePresent ? [`  local auth store present (${options.auth.userStorePath})`] : []),
    ...(options.auth?.bootstrapCredentialPresent ? [`  setup credential present (${options.auth.bootstrapCredentialPath})`] : []),
    options.auth
      ? options.auth.operatorTokenPresent
        ? `  connected host token present (${options.auth.operatorTokenPath})`
        : '  connected host token none: pair this Agent with the daemon: goodvibes-agent setup pair --apply'
      : '  connected host token unknown',
    '',
    'Connected GoodVibes host:',
    ...(externalRuntime
      ? [
          `  baseUrl: ${externalRuntime.baseUrl}`,
          `  reachable: ${yesNo(externalRuntime.reachable)}${externalRuntime.statusCode === null ? '' : ` (HTTP ${externalRuntime.statusCode})`}`,
          `  compatible: ${yesNo(externalRuntime.compatible)}`,
          `  access token: ${externalRuntime.operatorToken.present ? 'present' : 'missing'} (${externalRuntime.operatorToken.path})`,
          `  Agent Knowledge: ${externalRuntime.agentKnowledge.probed === false ? 'not checked' : externalRuntime.agentKnowledge.ready ? 'ready' : `not ready (${formatAgentKnowledgeFailureKind(externalRuntime.agentKnowledge.kind)})`}`,
          ...(externalRuntime.error ? [`  error: ${externalRuntime.error}`] : []),
        ]
      : ['  live check unavailable']),
    '',
    'Connected host metrics (runtime.metrics.get; read:telemetry):',
    ...connectedHostMetricsLines(snapshot.connectedHostMetrics),
    '',
    'Connected host credentials (credentials.get; status only, never values):',
    ...connectedHostCredentialLines(snapshot.connectedHostCredentials),
    '',
    "Relay (connected host's imported config; not live-verified, see goodvibes-agent relay status):",
    `  relay.enabled: ${yesNo(snapshot.relay.enabled)}`,
    `  relay.url: ${snapshot.relay.url || '(empty)'}`,
    `  relay.requireStepUpForMutations: ${yesNo(snapshot.relay.requireStepUpForMutations)}`,
    '',
    'Agent role:',
    '  product: interactive operator TUI',
    '  host lifecycle: external',
    '  starts or exposes host: no',
    ...(options.service?.log.path
      ? [`  daemon service log ${options.service.log.path}${options.service.log.exists ? '' : ' (not written yet)'}`]
      : []),
    'Onboarding',
    `  checked ${marker?.exists ? 'yes' : 'no'}`,
    `  scope ${marker?.scope ?? 'none'}`,
    `  updated ${marker?.payload ? appendTemporalLabel(new Date(marker.payload.updatedAt).toISOString(), marker.payload.updatedAt) : 'n/a'}`,
    '',
    'Crashes',
    `  ${describeCrashLog(snapshot.crashLog) ?? `none recorded (${snapshot.crashLog.path})`}`,
    '',
    'Checkpoints',
    ...(snapshot.checkpoints
      ? [
          `  ${snapshot.checkpoints.statusLine}`,
          `  unregisteredWorkspaces mode: ${snapshot.checkpoints.unregisteredWorkspaceMode}`,
          '  next goodvibes-agent workspaces list',
          ...(snapshot.checkpoints.workspaceRegistered ? [] : [
            '  next goodvibes-agent workspaces register --yes',
            ...(snapshot.checkpoints.unregisteredWorkspaceMode === 'off'
              ? ['  or set checkpoints.unregisteredWorkspaces to "guarded" in Settings (or settings action:"set") to checkpoint unregistered workspaces']
              : []),
          ]),
        ]
      : ['  checkpoint posture unknown']),
  ];

  if (options.doctor) {
    lines.push(
      '',
      'Readiness Checks:',
      `  isolated Agent Knowledge route: ${!externalRuntime ? 'not checked (no connected host)'
        : !externalRuntime.reachable ? 'not checked (the daemon is not reachable; see the warning below)'
        : externalRuntime.agentKnowledge.probed === false
          ? externalRuntime.operatorToken.present ? 'not checked (the daemon refused this Agent\'s token; pair again: goodvibes-agent setup pair --apply)' : 'not checked (no connected host token; pair: goodvibes-agent setup pair --apply)'
          : externalRuntime.agentKnowledge.ready ? 'ready' : 'not ready (see the warning below)'}`,
    );
    const problems = findings.filter((finding) => finding.severity !== 'note');
    const notes = findings.filter((finding) => finding.severity === 'note');
    lines.push('', 'Warnings');
    if (problems.length === 0) {
      lines.push('  none');
    } else {
      for (const finding of problems) {
        lines.push(
          `  - [${finding.severity}:${finding.area}:${finding.id}] ${finding.summary}`,
          `    cause: ${finding.cause}`,
          `    impact: ${finding.impact}`,
          `    action: ${finding.action}`,
        );
      }
    }
    if (notes.length > 0) {
      lines.push('', 'Notes');
      for (const finding of notes) lines.push(`  - [note:${finding.area}:${finding.id}] ${finding.summary}`, `    ${finding.impact}`);
    }
  }

  return lines.join('\n');
}

export function renderOnboardingCliStatus(options: CliStatusOptions): string {
  const marker = effectiveMarker(options.onboardingMarker);
  if (options.outputFormat === 'json')
    return JSON.stringify(
      {
        title: 'GoodVibes Agent setup status',
        selectedHost: options.selectedHost ?? null,
        nativeReadiness: options.nativeReadiness ?? { status: 'unverified', detail: 'No live auth check was performed.' },
        pairingStatus: options.pairingStatus ?? 'unverified',
        checked: marker?.exists ?? false,
        scope: marker?.scope ?? 'none',
        workingDirectory: options.workingDirectory,
      },
      null,
      2,
    );
  return [
    'GoodVibes Agent setup status',
    `  selected host ${options.selectedHost ?? '(unavailable)'}`,
    `  native intake auth ${options.nativeReadiness?.status ?? 'unverified'}`,
    `  ${options.nativeReadiness?.detail ?? 'No live auth check was performed.'}`,
    `  Agent pairing store ${options.pairingStatus ?? 'unverified'}`,
    '  Provider, workspace, Jev and execution readiness are separate checks.',
    `  checked ${marker?.exists ? 'yes' : 'no'}`,
    `  scope ${marker?.scope ?? 'none'}`,
    `  origin ${marker?.payload?.source ? formatAgentRecordSource(marker.payload.source) : 'n/a'}`,
    `  mode ${marker?.payload?.mode ?? 'n/a'}`,
    `  updated ${marker?.payload ? appendTemporalLabel(new Date(marker.payload.updatedAt).toISOString(), marker.payload.updatedAt) : 'n/a'}`,
    `  working directory ${options.workingDirectory}`,
  ].join('\n');
}
