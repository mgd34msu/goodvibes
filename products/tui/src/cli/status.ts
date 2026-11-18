import { captureCliStatusFacts, describeCliSignIns, secretPolicyLabel, type CliProviderSignInFacts } from '@goodvibes-jev/engine/terminal-shell/cli-status-facts';
import { yesNo } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import { effectivePermissionMode, presetForMode } from '@goodvibes-jev/engine/platform/platform/gate/presets';
import { describeConfiguredPermissions } from '../permissions/configured-posture.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import type { OnboardingCheckMarkerState } from '../runtime/onboarding/index.ts';
import { formatRuntimeEndpointBinding, resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell/cli-endpoints';
import type { RuntimeEndpointBinding, RuntimeEndpointId } from '@goodvibes-jev/engine/terminal-shell';
import { classifyBindPosture, isNetworkFacing } from '@goodvibes-jev/engine/terminal-shell/cli-network-posture';
import type { GoodVibesCliOutputFormat } from '@goodvibes-jev/engine/terminal-shell';
import { serviceSettingsIssues, type CliServicePosture } from './service-posture.ts';
import type { InstallSelfCheckFinding } from '../runtime/install-self-check.ts';
import { getProviderIdFromModel } from '@goodvibes-jev/engine/platform/platform/providers/provider-model';
import { describeConfiguredEffort } from '../providers/reasoning-effort-surface.ts';
import { describeCrashLog, summarizeCrashLog, surfaceCrashLogPath, type CrashLogSummary } from '@goodvibes-jev/engine/platform/platform/runtime/crash-capture';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';

/** The marker that decides first-run state: the user's marker when its file exists. */
function effectiveMarker(marker: OnboardingCheckMarkerState | undefined): OnboardingCheckMarkerState | null {
  return marker?.exists ? marker : null;
}

export interface CliStatusOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** How the configured model's provider is signed in and where its model list came from (read from files by the caller). */
  readonly providerSignIn?: CliProviderSignInFacts;
  /** The first-run check marker (per user); absent or `exists: false` when first run was not marked. */
  readonly onboardingMarker?: OnboardingCheckMarkerState;
  readonly auth?: CliAuthStatus;
  readonly service?: CliServicePosture;
  /** Findings from the install self-check (missing vendor binaries, broken daemon path), computed by the caller. */
  readonly install?: readonly InstallSelfCheckFinding[];
  readonly doctor?: boolean;
  readonly outputFormat?: GoodVibesCliOutputFormat;
  /** Per-workspace trust + registration posture, computed read-only by the caller. */
  readonly workspace?: CliWorkspaceStatus;
  /** Per-command exec sandbox availability, host-probed by the caller. */
  readonly sandbox?: CliSandboxStatus;
  /** Outbound relay reachability posture (config + feature-flag gate only, a one-shot CLI process has no live connection to inspect). */
  readonly relay?: CliRelayStatus;
}

/** Config-derived relay posture. No live socket check, see doctor's other surfaces for the same honesty bar. */
export interface CliRelayStatus {
  readonly configEnabled: boolean;
  readonly featureEnabled: boolean;
  readonly url: string;
  readonly requireStepUpForMutations: boolean;
}

/** Honest per-command exec sandbox posture for the report. */
export interface CliSandboxStatus {
  /** `sandbox.enabled` config switch. */
  readonly configEnabled: boolean;
  /** The graduation-gated `exec-sandbox` feature flag. */
  readonly featureEnabled: boolean;
  /** Host can actually provide a boundary (bubblewrap present and working). */
  readonly available: boolean;
  readonly backend: 'bubblewrap' | 'none';
  /** Host-probe diagnosis (why unavailable) or one-line availability summary. */
  readonly reason: string;
  /** Whether `--unshare-net` isolation is confirmed on this host, or unknown. */
  readonly networkIsolationGuaranteed: boolean;
}

/** Read-only snapshot of this workspace's trust gate and registration coverage. */
export interface CliWorkspaceStatus {
  /** This directory's trust decision in the user's workspace register; 'undecided' when none is recorded. */
  readonly trustLevel: 'trusted' | 'restricted' | 'undecided';
  /** True when an earlier build's trust.json inside the workspace was found; it is not honored. */
  readonly trustLegacyIgnored: boolean;
  /** Why the workspace register could not be read; absent when it is fine or never existed. */
  readonly trustFault?: string | undefined;
  /** Coverage verdict from the shared workspace registry. */
  readonly registrationStatus: 'covered' | 'declined' | 'unknown';
  /** Normalized working directory resolved against the registry. */
  readonly registrationRoot: string;
  /** Nearest registered root covering this path, or null. */
  readonly registeredBy: string | null;
  /** Coverage inherited through the git worktree→main-repo link. */
  readonly viaWorktreeLink: boolean;
  /** True when the root is too broad to register ($HOME, filesystem root, ~/.goodvibes). */
  readonly registrationBroad: boolean;
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
  readonly area: 'auth' | 'network' | 'onboarding' | 'security' | 'service' | 'secrets' | 'install' | 'sandbox';
  readonly severity: 'warning' | 'risk';
  readonly summary: string;
  readonly cause: string;
  readonly impact: string;
  readonly action: string;
}

export interface CliStatusSnapshot {
  readonly title: 'GoodVibes status' | 'GoodVibes doctor';
  /** This program's crash log: faults recorded, the newest, and where the records are. */
  readonly crashLog: CrashLogSummary;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly provider: {
    readonly provider: string;
    readonly model: string;
    readonly reasoning: string;
    /** Sign-ins in the order requests use them, and the model list's source and age. */
    readonly signIn?: CliProviderSignInFacts | undefined;
    /**
     * What the configured reasoning level actually becomes on the configured
     * model. The level alone is not the whole truth: a model that does not
     * offer it gets the next level down, and a model with no configurable
     * reasoning gets nothing sent at all.
     */
    readonly reasoningResolved: string;
  };
  readonly auth: {
    readonly permissionMode: unknown;
    readonly permissionLabel: string;
    readonly autoApprove: boolean;
    readonly automaticApprovals: boolean;
    readonly bypassesPrompts: boolean;
    readonly permissionDetail: string;
    readonly secretPolicy: unknown;
    readonly secretPolicyLabel: string;
    readonly localUsers: CliAuthStatus | null;
  };
  readonly service: {
    readonly enabled: unknown;
    readonly autostart: unknown;
    readonly restartOnFailure: unknown;
    readonly lifecycle?: CliServicePosture;
  };
  readonly surfaces: {
    /** `enabled`: the daemon listens (for this machine at least); `servesOtherMachines`: controlPlane.enabled. */
    readonly controlPlane: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown; readonly servesOtherMachines: boolean };
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
  readonly workspace: CliWorkspaceStatus | null;
  readonly sandbox: CliSandboxStatus | null;
  readonly relay: CliRelayStatus | null;
  readonly exposure: readonly CliExposureSurface[];
  readonly findings: readonly CliDoctorFinding[];
}

/**
 * Per-surface exposure report row: what a network surface binds to, how it
 * authenticates callers, and what cross-origin allowlist (if any) applies.
 * A plain report, it changes no behavior and writes no config.
 */
export interface CliExposureSurface {
  readonly id: RuntimeEndpointId;
  readonly label: string;
  /** The surface listens. The control plane listens for this machine whenever the daemon runs. */
  readonly enabled: boolean;
  /** Bind envelope, e.g. "network 0.0.0.0:3421". */
  readonly bind: string;
  /** Reachability posture label, e.g. "Local only" / "Local Network" / "Custom network". */
  readonly reach: string;
  readonly networkFacing: boolean;
  /** How callers authenticate against this surface when it is network-facing. */
  readonly authMode: string;
  /** Browser-origin allowlist state. Only the control plane has one; others report n/a. */
  readonly originAllowlist: string;
}

function bindLine(label: string, enabled: unknown, binding: RuntimeEndpointBinding): string {
  return `  ${label}: ${yesNo(enabled)} (${formatRuntimeEndpointBinding(binding)})`;
}

/** Describe registration coverage for the Workspace status section. */
function registrationLine(workspace: CliWorkspaceStatus): string {
  switch (workspace.registrationStatus) {
    case 'covered':
      return workspace.viaWorktreeLink
        ? `registered (via worktree link to ${workspace.registeredBy})`
        : `registered (covered by ${workspace.registeredBy})`;
    case 'declined':
      return 'not registered (declined for this directory)';
    case 'unknown':
      return workspace.registrationBroad ? 'not registered (root too broad to register)' : 'not registered (never asked)';
  }
}

/** The `Workspace:` block showing the TUI-local trust gate and shared-registry coverage. */
function renderWorkspaceSection(workspace: CliWorkspaceStatus | null): string[] {
  if (!workspace) return [];
  return [
    'Workspace:',
    `  trust: ${workspace.trustLevel}${workspace.trustLegacyIgnored ? ' (a trust.json inside this workspace is not honored; choose a level with /trust workspace)' : ''}`,
    ...(workspace.trustFault ? [`  trust record: damaged, autonomous work stays restricted until a level is chosen (${workspace.trustFault})`] : []),
    `  registration: ${registrationLine(workspace)}`,
    `  root: ${workspace.registrationRoot}`,
    '',
  ];
}

/** The `Exec sandbox:` block, honest host-probed availability of the per-command boundary. */
function renderSandboxSection(sandbox: CliSandboxStatus | null): string[] {
  if (!sandbox) return [];
  const active = sandbox.configEnabled && sandbox.featureEnabled && sandbox.available;
  const network = !sandbox.available ? 'n/a' : sandbox.networkIsolationGuaranteed ? 'isolation confirmed' : 'isolation unknown';
  return [
    'Exec sandbox:',
    `  active: ${active ? 'yes' : 'no'}`,
    `  configEnabled: ${yesNo(sandbox.configEnabled)}`,
    `  featureEnabled: ${yesNo(sandbox.featureEnabled)}`,
    `  backend: ${sandbox.backend}`,
    `  available: ${yesNo(sandbox.available)}`,
    `  network: ${network}`,
    `  detail: ${sandbox.reason}`,
    '',
  ];
}

/**
 * The `Relay:` block, config + feature-flag gate only. The live registration
 * state lives in the running daemon's memory and no verb exposes it, so no
 * client reads it: this CLI reports the gate, and `/relay status` in the
 * terminal app reports the same gate plus an honest "not readable here" for the
 * live half. "active" means the gate that lets a running daemon register.
 */
function renderRelaySection(relay: CliRelayStatus | null): string[] {
  if (!relay) return [];
  const active = relay.configEnabled && relay.featureEnabled;
  return [
    'Relay:',
    `  active: ${active ? 'yes (a running daemon will register)' : 'no'}`,
    `  configEnabled (relay.enabled): ${yesNo(relay.configEnabled)}`,
    `  featureEnabled (relay-connect flag): ${yesNo(relay.featureEnabled)}`,
    `  url: ${relay.url || '(not set)'}`,
    '  rendezvousId: derived from the daemon\'s relay identity key; /relay status shows it while the daemon is registered',
    `  requireStepUpForMutations: ${yesNo(relay.requireStepUpForMutations)}`,
    '  Threat model: the relay operator sees only ciphertext and connection metadata; self-host your own relay for full control.',
    '',
  ];
}

/**
 * How callers authenticate against a surface, derived from the auth material
 * the CLI already inspects. A loopback surface trusts the local host; a
 * network-facing surface is authenticated by a local user store and/or an
 * operator token, and reports "none configured" when neither exists.
 */
function surfaceAuthMode(networkFacing: boolean, auth: CliAuthStatus | undefined): string {
  if (!networkFacing) return 'loopback (host-local trust)';
  if (!auth) return 'unknown';
  const parts: string[] = [];
  if (auth.userStorePresent) parts.push('local users');
  if (auth.operatorTokenPresent) parts.push('operator token');
  if (parts.length === 0) return 'none configured';
  return parts.join(' + ');
}

/** Comma-separated CORS origins, trimmed and emptied of blanks. */
function parseAllowedOrigins(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * The only browser-origin allowlist in this codebase belongs to the control
 * plane (controlPlane.cors.*). httpListener and web have no origin allowlist
 * concept, so this returns an honest n/a for them.
 */
function surfaceOriginAllowlist(id: RuntimeEndpointId, config: Pick<ConfigManager, 'get'>): string {
  if (id !== 'controlPlane') return 'n/a (no origin allowlist for this surface)';
  if (config.get('controlPlane.cors.enabled') !== true) return 'CORS off (same-origin only)';
  const origins = parseAllowedOrigins(config.get('controlPlane.cors.allowedOrigins'));
  if (origins.length === 0) return 'CORS on, empty allowlist (refuses all cross-origin)';
  if (origins.includes('*')) return `CORS on, WILDCARD any-origin (${origins.join(', ')})`;
  return `CORS on, allowlist: ${origins.join(', ')}`;
}

/**
 * `enabled`: the surface listens. `exposedKey`: the setting that lets machines
 * other than this one in; the control plane serves this machine whenever the
 * daemon runs and others only with controlPlane.enabled.
 */
const EXPOSURE_SURFACES: readonly {
  readonly id: RuntimeEndpointId;
  readonly label: string;
  readonly enabled: (config: CliStatusOptions['configManager']) => boolean;
  readonly exposedKey: string;
}[] = [
  { id: 'controlPlane', label: 'controlPlane', enabled: (config) => resolveDaemonEnabled(config), exposedKey: 'controlPlane.enabled' },
  { id: 'httpListener', label: 'httpListener', enabled: (config) => config.get('danger.httpListener') === true, exposedKey: 'danger.httpListener' },
  { id: 'web', label: 'web', enabled: (config) => config.get('web.enabled') === true, exposedKey: 'web.enabled' },
];

/**
 * Build the per-surface exposure report (bind address, auth mode, origin
 * allowlist) for every network surface. Pure over the status options, a
 * report only, no behavior change.
 */
export function buildCliExposureReport(options: CliStatusOptions): readonly CliExposureSurface[] {
  const config = options.configManager;
  return EXPOSURE_SURFACES.map((surface): CliExposureSurface => {
    const enabled = surface.enabled(config);
    const binding = resolveRuntimeEndpointBinding(config, surface.id);
    const networkFacing = isNetworkFacing(enabled && config.get(surface.exposedKey as never) === true, binding);
    return {
      id: surface.id,
      label: surface.label,
      enabled,
      bind: formatRuntimeEndpointBinding(binding),
      reach: binding.recognized ? classifyBindPosture(binding).label : 'Unknown (unrecognized host mode)',
      networkFacing,
      authMode: surfaceAuthMode(networkFacing, options.auth),
      originAllowlist: surfaceOriginAllowlist(surface.id, config),
    };
  });
}

type ServiceFindingText = Pick<CliDoctorFinding, 'cause' | 'impact' | 'action'>;

const SERVICE_FINDING_TEXT: Readonly<Record<string, ServiceFindingText>> = {
  'service-disabled-for-server-surfaces': {
    cause: 'One or more daemon, control-plane, listener, or web settings are enabled while service.enabled is false.',
    impact: 'The configured surfaces may not start automatically or survive restarts.',
    action: 'Enable service mode or disable the server-backed surfaces you do not want.',
  },
  'service-autostart-disabled': {
    cause: 'A service definition is installed and service.autostart is false.',
    impact: 'GoodVibes does not start after login or reboot.',
    action: 'Set service.autostart to true if the daemon, listener or web surfaces should stay available.',
  },
  'service-restart-disabled': {
    cause: 'service.enabled is true and service.restartOnFailure is false.',
    impact: 'A crashed daemon or listener stays down until it is started again.',
    action: 'Set service.restartOnFailure to true, then run goodvibes service install to rewrite the definition.',
  },
};

const SERVICE_FINDING_FALLBACK: ServiceFindingText = {
  cause: 'The service inspection found a mismatch between the configured service and surface state and what is running.',
  impact: 'Daemon, control-plane, listener, or web availability may not match the configuration.',
  action: 'Run goodvibes service check and apply the install, start or setting change it names.',
};

export function buildCliDoctorFindings(options: CliStatusOptions): readonly CliDoctorFinding[] {
  const config = options.configManager;
  const serviceEnabled = config.get('service.enabled') === true;
  const serviceAutostart = config.get('service.autostart') === true;
  const restartOnFailure = config.get('service.restartOnFailure') === true;
  const daemonEnabled = resolveDaemonEnabled(config);
  const listenerEnabled = config.get('danger.httpListener') === true;
  const webEnabled = config.get('web.enabled') === true;
  // controlPlane.enabled: whether other machines are served; the daemon serves this one whenever it runs.
  const controlPlaneServesOthers = daemonEnabled && config.get('controlPlane.enabled') === true;
  const controlPlaneBinding = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const httpListenerBinding = resolveRuntimeEndpointBinding(config, 'httpListener');
  const webBinding = resolveRuntimeEndpointBinding(config, 'web');
  const permissionMode = config.get('permissions.mode');
  const secretPolicy = config.get('storage.secretPolicy');
  const marker = effectiveMarker(options.onboardingMarker);
  const serverBackedEnabled = daemonEnabled || listenerEnabled || webEnabled;
  const networkFacingSurfaces = [
    ['control plane', controlPlaneServesOthers, controlPlaneBinding],
    ['HTTP listener', listenerEnabled, httpListenerBinding],
    ['web surface', webEnabled, webBinding],
  ].filter(([, enabled, binding]) => isNetworkFacing(enabled, binding as typeof controlPlaneBinding));

  const findings: CliDoctorFinding[] = [];

  // An unrecognized hostMode has NO binding the platform can produce (its bind
  // resolver has no default case, the daemon throws before binding), so it
  // is surfaced as a doctor finding on every endpoint that carries one,
  // instead of the fallback loopback binding being presented as fact.
  for (const [endpointId, endpointLabel, endpointBinding] of [
    ['controlPlane', 'control plane', controlPlaneBinding],
    ['httpListener', 'HTTP listener', httpListenerBinding],
    ['web', 'web surface', webBinding],
  ] as const) {
    if (endpointBinding.recognized) continue;
    findings.push({
      id: `unrecognized-host-mode-${endpointId}`,
      area: 'service',
      severity: 'warning',
      summary: `${endpointLabel} hostMode '${endpointBinding.hostMode}' is not a recognized mode.`,
      cause: `${endpointId}.hostMode is set to '${endpointBinding.hostMode}', but only local|network|custom are recognized.`,
      impact: 'The daemon cannot resolve a binding for this endpoint and will fail to start it; displays cannot show a real bind address.',
      action: `Set ${endpointId}.hostMode to local, network, or custom.`,
    });
  }

  // Service facts come from the posture builder under fixed ids; doctor adds
  // only the cause, impact and action for each id.
  const serviceIssues = options.service?.findings
    ?? serviceSettingsIssues({ enabled: serviceEnabled, autostart: serviceAutostart, restartOnFailure, serverBackedEnabled });
  for (const issue of serviceIssues) {
    const text = SERVICE_FINDING_TEXT[issue.id] ?? SERVICE_FINDING_FALLBACK;
    findings.push({ id: issue.id, area: 'service', severity: 'warning', summary: issue.summary, ...text });
  }

  if (!marker?.exists) {
    findings.push({
      id: 'onboarding-incomplete',
      area: 'onboarding',
      severity: 'warning',
      summary: 'Onboarding has not been shown for this user.',
      cause: 'No global user onboarding check marker was found.',
      impact: 'Important service, network, provider, auth, or permission choices may still be implicit defaults.',
      action: 'Run /onboarding in the TUI or goodvibes onboarding status to review setup state.',
    });
  }

  if (networkFacingSurfaces.length > 0 && options.auth?.userStorePresent !== true) {
    findings.push({
      id: 'network-surface-without-local-users',
      area: 'auth',
      severity: 'risk',
      summary: 'Network-facing surfaces are enabled before local users are configured.',
      cause: `${networkFacingSurfaces.map(([name]) => name).join(', ')} are LAN/custom-bound, but no local auth user store was found.`,
      impact: 'Remote access paths may be unusable or unsafe until local admin auth is configured.',
      action: 'Create/verify a local admin user before exposing GoodVibes on the network.',
    });
  }

  if (networkFacingSurfaces.length > 0 && options.auth?.bootstrapCredentialPresent === true) {
    findings.push({
      id: 'network-surface-with-bootstrap-credential',
      area: 'auth',
      severity: 'risk',
      summary: 'A bootstrap credential is still present while network-facing surfaces are enabled.',
      cause: `${networkFacingSurfaces.map(([name]) => name).join(', ')} are LAN/custom-bound and auth-bootstrap.txt exists.`,
      impact: 'Bootstrap credentials should be treated as temporary setup material, not long-lived network access credentials.',
      action: 'Replace bootstrap auth with a named admin user and retire the bootstrap credential.',
    });
  }

  if (config.get('behavior.autoApprove') === true) {
    findings.push({
      id: 'auto-approve-enabled',
      area: 'security',
      severity: 'risk',
      summary: 'Broad automatic approvals are enabled.',
      cause: 'behavior.autoApprove is true.',
      impact: describeConfiguredPermissions(config).detail,
      action: 'Disable automatic approvals unless this broad autonomy is intentional.',
    });
  }

  if (permissionMode === 'yolo' || permissionMode === 'allow-all') {
    findings.push({
      id: 'allow-all-permissions',
      area: 'security',
      severity: 'risk',
      summary: 'YOLO execution mode is active.',
      cause: 'The selected execution mode is YOLO.',
      impact: describeConfiguredPermissions(config).detail,
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
      impact: 'Provider keys and surface tokens may be stored without secure backend protection.',
      action: 'Use Require secure storage or Use secure storage when available for normal operation.',
    });
  }

  if (listenerEnabled && isNetworkFacing(listenerEnabled, httpListenerBinding)) {
    findings.push({
      id: 'network-http-listener-enabled',
      area: 'network',
      severity: 'warning',
      summary: 'The HTTP listener is reachable beyond loopback.',
      cause: `HTTP listener is enabled on ${httpListenerBinding.host}:${httpListenerBinding.port} with ${httpListenerBinding.hostMode} binding.`,
      impact: 'External tools and devices may be able to reach incoming event endpoints.',
      action: 'Keep listener secrets/signature checks configured for every enabled webhook surface.',
    });
  }

  if (
    isNetworkFacing(controlPlaneServesOthers, controlPlaneBinding) &&
    config.get('controlPlane.cors.enabled') === true &&
    parseAllowedOrigins(config.get('controlPlane.cors.allowedOrigins')).includes('*')
  ) {
    findings.push({
      id: 'control-plane-cors-wildcard-origin',
      area: 'network',
      severity: 'risk',
      summary: 'The control plane accepts cross-origin requests from any origin.',
      cause: `controlPlane is ${controlPlaneBinding.hostMode}-bound on ${controlPlaneBinding.host}:${controlPlaneBinding.port}, controlPlane.cors.enabled is true, and controlPlane.cors.allowedOrigins contains a wildcard "*".`,
      impact: 'Any website a signed-in operator visits could make credentialed cross-origin calls to the control plane.',
      action: 'Replace the wildcard with an explicit list of trusted browser origins in controlPlane.cors.allowedOrigins.',
    });
  }

  if (options.install) {
    for (const finding of options.install) {
      findings.push({
        id: `install-${finding.id}`,
        area: 'install',
        severity: 'warning',
        summary: finding.summary,
        cause: finding.detail,
        impact: 'The daemon and any background surfaces (control plane, listener, web) may fail to start until the install is repaired.',
        action: `Repair this install by running: ${finding.repairCommand}`,
      });
    }
  }

  // Exec sandbox requested but the host cannot provide a boundary: the exec tool
  // silently runs unsandboxed and the approval flow keeps prompting. Flag it so
  // the operator knows the boundary they turned on is not in force.
  if (options.sandbox && options.sandbox.configEnabled && options.sandbox.featureEnabled && !options.sandbox.available) {
    findings.push({
      id: 'exec-sandbox-unavailable',
      area: 'sandbox',
      severity: 'warning',
      summary: 'The per-command exec sandbox is enabled but unavailable on this host.',
      cause: options.sandbox.reason,
      impact: 'Exec commands run unsandboxed and boundary-safe commands still prompt instead of auto-allowing.',
      action: 'Install bubblewrap (bwrap) on Linux, or disable sandbox.enabled to stop requesting a boundary this host cannot provide.',
    });
  }

  return findings;
}

/**
 * The doctor command's exit code. Advisory findings (`severity: 'warning'`)
 * are notes on an otherwise-usable install and must never make a healthy
 * install report failure, only a must-fix (`severity: 'risk'`) finding
 * exits non-zero. `strict` (for CI) flips warnings to failures too, so a
 * pipeline can require a fully clean report instead of just "usable".
 */
export function resolveDoctorExitCode(findings: readonly CliDoctorFinding[], strict = false): number {
  if (findings.some((finding) => finding.severity === 'risk')) return 1;
  if (strict && findings.length > 0) return 1;
  return 0;
}

export function buildCliStatusSnapshot(options: CliStatusOptions): CliStatusSnapshot {
  const config = options.configManager;
  const common = captureCliStatusFacts(config, effectiveMarker(options.onboardingMarker), options.service, getProviderIdFromModel);

  const findings = buildCliDoctorFindings(options);
  const approvalPreset = presetForMode(
    effectivePermissionMode(config.get('permissions.mode'), config.get('behavior.autoApprove') === true),
  );
  return {
    title: options.doctor ? 'GoodVibes doctor' : 'GoodVibes status',
    crashLog: summarizeCrashLog(surfaceCrashLogPath(options.homeDirectory, GOODVIBES_TUI_SURFACE_ROOT)),
    workingDirectory: options.workingDirectory,
    homeDirectory: options.homeDirectory,
    provider: {
      ...common.provider,
      ...(options.providerSignIn ? { signIn: options.providerSignIn } : {}),
      reasoningResolved: describeConfiguredEffort(
        String(config.get('provider.model') ?? ''),
        String(config.get('provider.reasoningEffort') ?? ''),
      ),
    },
    auth: {
      ...common.auth,
      permissionLabel: describeConfiguredPermissions(config).label,
      autoApprove: config.get('behavior.autoApprove') === true,
      automaticApprovals: approvalPreset.name === 'yolo',
      bypassesPrompts: approvalPreset.name === 'yolo' || approvalPreset.name === 'jev-decides' || approvalPreset.name === 'just-vibes',
      permissionDetail: describeConfiguredPermissions(config).detail,
      localUsers: options.auth ?? null,
    },
    service: common.service,
    surfaces: {
      ...common.endpoints,
      controlPlane: {
        ...common.endpoints.controlPlane,
        enabled: resolveDaemonEnabled(config),
        servesOtherMachines: resolveDaemonEnabled(config) && config.get('controlPlane.enabled') === true,
      },
    },
    onboarding: common.onboarding,
    decisionModel: common.decisionModel,
    workspace: options.workspace ?? null,
    sandbox: options.sandbox ?? null,
    relay: options.relay ?? null,
    exposure: buildCliExposureReport(options),
    findings,
  };
}

export function renderCliStatus(options: CliStatusOptions): string {
  const config = options.configManager;
  const snapshot = buildCliStatusSnapshot(options);
  const serviceEnabled = snapshot.service.enabled;
  const serviceAutostart = snapshot.service.autostart;
  const restartOnFailure = snapshot.service.restartOnFailure;
  const controlPlaneEnabled = snapshot.surfaces.controlPlane.enabled;
  const listenerEnabled = snapshot.surfaces.httpListener.enabled;
  const webEnabled = snapshot.surfaces.web.enabled;
  const controlPlaneBinding = snapshot.surfaces.controlPlane;
  const httpListenerBinding = snapshot.surfaces.httpListener;
  const webBinding = snapshot.surfaces.web;
  const marker = effectiveMarker(options.onboardingMarker);
  const findings = snapshot.findings;

  if (options.outputFormat === 'json') return JSON.stringify(snapshot, null, 2);

  const lines = [
    snapshot.title,
    `  workingDir: ${options.workingDirectory}`,
    `  homeDir: ${options.homeDirectory}`,
    '',
    'Provider:',
    `  provider: ${getProviderIdFromModel(config.get('provider.model'))}`,
    `  model: ${String(config.get('provider.model'))}`,
    `  reasoning: ${String(config.get('provider.reasoningEffort'))}`,
    `  reasoning (on this model): ${describeConfiguredEffort(
      String(config.get('provider.model') ?? ''),
      String(config.get('provider.reasoningEffort') ?? ''),
    )}`,
    ...(snapshot.provider.signIn ? [
      `  sign-in: ${describeCliSignIns(snapshot.provider.signIn)}`,
      `  model list: ${snapshot.provider.signIn.modelList}`,
    ] : []),
    '',
    'Decision model:',
    `  policy: ${snapshot.decisionModel.policyLabel} (judgment.policy)`,
    `  ${snapshot.decisionModel.line}`,
    '',
    'Auth:',
    `  permissions: ${describeConfiguredPermissions(config).label} (${String(config.get('permissions.mode'))})`,
    `    ${describeConfiguredPermissions(config).detail}`,
    `  autoApprove: ${yesNo(snapshot.auth.autoApprove)} (behavior.autoApprove)`,
    `  secretPolicy: ${secretPolicyLabel(config.get('storage.secretPolicy'))} (${String(config.get('storage.secretPolicy'))})`,
    options.auth
      ? `  localUsers: ${options.auth.userStorePresent ? 'present' : 'missing'} (${options.auth.userStorePath})`
      : '  localUsers: unknown',
    options.auth
      ? `  bootstrapCredential: ${options.auth.bootstrapCredentialPresent ? 'present' : 'missing'} (${options.auth.bootstrapCredentialPath})`
      : '  bootstrapCredential: unknown',
    options.auth
      ? `  operatorTokens: ${options.auth.operatorTokenPresent ? 'present' : 'missing'} (${options.auth.operatorTokenPath})`
      : '  operatorTokens: unknown',
    '',
    'Service:',
    `  enabled: ${yesNo(serviceEnabled)}`,
    `  autostart: ${yesNo(serviceAutostart)}`,
    `  restartOnFailure: ${yesNo(restartOnFailure)}`,
    ...(options.service
      ? [
          `  platform: ${options.service.managed.platform}`,
          `  installed: ${yesNo(options.service.managed.installed)}`,
          `  running: ${yesNo(options.service.managed.running)}`,
          `  pid: ${options.service.managed.pid ?? 'n/a'}`,
          `  definition: ${options.service.managed.path}`,
          `  log: ${options.service.log.path ?? 'n/a'} (${options.service.log.exists ? 'present' : 'missing'})`,
        ]
      : []),
    '',
    'Surfaces:',
    bindLine('controlPlane', controlPlaneEnabled, controlPlaneBinding),
    `    servesOtherMachines: ${yesNo(snapshot.surfaces.controlPlane.servesOtherMachines)} (controlPlane.enabled)`,
    bindLine('httpListener', listenerEnabled, httpListenerBinding),
    bindLine('web', webEnabled, webBinding),
    '',
    'Onboarding:',
    `  checked: ${marker?.exists ? 'yes' : 'no'}`,
    `  scope: ${marker?.scope ?? 'none'}`,
    `  updatedAt: ${marker?.payload ? new Date(marker.payload.updatedAt).toISOString() : 'n/a'}`,
    '',
    'Crashes:',
    `  ${describeCrashLog(snapshot.crashLog) ?? `none recorded (${snapshot.crashLog.path})`}`,
    '',
    ...renderWorkspaceSection(snapshot.workspace),
    ...renderSandboxSection(snapshot.sandbox),
    ...renderRelaySection(snapshot.relay),
    'Exposure (report only: no changes made):',
    ...snapshot.exposure.flatMap((surface) => [
      `  ${surface.label}: ${yesNo(surface.enabled)} · ${surface.reach}${surface.networkFacing ? ' · network-facing' : ''}`,
      `    bind: ${surface.bind}`,
      `    auth: ${surface.authMode}`,
      `    originAllowlist: ${surface.originAllowlist}`,
    ]),
  ];

  if (options.doctor) {
    lines.push('', 'Warnings:');
    if (findings.length === 0) {
      lines.push('  none');
    } else {
      for (const finding of findings) {
        lines.push(
          `  - [${finding.severity}:${finding.area}:${finding.id}] ${finding.summary}`,
          `    cause: ${finding.cause}`,
          `    impact: ${finding.impact}`,
          `    action: ${finding.action}`,
        );
      }
    }
  }

  return lines.join('\n');
}

export function renderOnboardingCliStatus(options: CliStatusOptions): string {
  const marker = effectiveMarker(options.onboardingMarker);
  return [
    'GoodVibes onboarding status',
    `  checked: ${marker?.exists ? 'yes' : 'no'}`,
    `  scope: ${marker?.scope ?? 'none'}`,
    `  source: ${marker?.payload?.source ?? 'n/a'}`,
    `  mode: ${marker?.payload?.mode ?? 'n/a'}`,
    `  updatedAt: ${marker?.payload ? new Date(marker.payload.updatedAt).toISOString() : 'n/a'}`,
    `  workingDir: ${options.workingDirectory}`,
  ].join('\n');
}
