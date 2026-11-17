import { createCliSecretsCommand } from '@goodvibes-jev/engine/terminal-shell/cli-secrets-command';
import { createCliWorkspaceCommands } from '@goodvibes-jev/engine/terminal-shell/cli-workspace-commands';
import { createCliSubscriptionView } from '@goodvibes-jev/engine/terminal-shell/cli-subscription-view';
import { cliCommandRefusal } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import '@goodvibes-jev/engine/platform/platform/sessions';
import 'node:fs';
import { join } from 'node:path';
import { createRuntimeSecretsManager, resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';
import '@/runtime/index.ts';
import {
  generateQrMatrix,
  renderQrToString,
  PAIRING_HANDOFF_OFFER_KINDS,
  type PairingHandoffOfferKind,
} from '@goodvibes-jev/engine/platform/platform/pairing';
import { ensurePublicBaseUrl } from '@goodvibes-jev/engine/platform/platform/pairing';
import { formatPairingOffers, formatPostureCapabilities, pairingPostureNotice } from '@goodvibes-jev/engine/platform/platform/pairing';
import { defaultPairingTokenName } from '@goodvibes-jev/engine/platform/platform/pairing';
import { formatHttpOrigin, pairingOriginUsesStableHost, refreshStableHostInputs, stableUrlHostForBindHost } from '@goodvibes-jev/engine/platform/platform/pairing';
import { formatRuntimeEndpointBinding, resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';
import { classifyBindPosture, isNetworkFacing } from '@goodvibes-jev/engine/terminal-shell';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import type { RuntimeServices } from '../runtime/services.ts';
import {
  formatJsonOrText,
  openBrowser,
  probeTcp,
  readAuthPaths,
  readOptionValue,
  runNonInteractiveAgent,
  withRuntimeServices,
  yesNo,
} from './management-utils.ts';

export interface ControlPlaneStatusResult {
  readonly enabled: unknown;
  readonly hostMode: string;
  readonly configuredHost: string;
  readonly host: string;
  readonly port: number;
  readonly recognized: boolean;
  readonly posture: ReturnType<typeof classifyBindPosture>;
  /** undefined = NOT PROBED (unrecognized host mode), a tri-state, never coerced to false. */
  readonly reachable: boolean | undefined;
  readonly auth: ReturnType<typeof readAuthPaths>;
  readonly service: {
    readonly enabled: unknown;
    readonly autostart: unknown;
    readonly restartOnFailure: unknown;
  };
  readonly issues: readonly string[];
}

export async function buildControlPlaneStatusResult(runtime: CliCommandRuntime): Promise<ControlPlaneStatusResult> {
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'controlPlane');
  const enabled = runtime.configManager.get('controlPlane.enabled');
  // Never TCP-probe the fallback endpoint of an unrecognized hostMode, a
  // probe asserts a binding that does not exist. Not-probed is its own state
  // (undefined), NEVER coerced to a definite false: a daemon launched with
  // flag overrides can be serving healthily regardless of the stored mode.
  // Probed whether or not other machines are served: the daemon listens for this machine either way.
  const reachable = binding.recognized ? await probeTcp(binding.host, binding.port) : undefined;
  const auth = readAuthPaths(runtime);
  const service = {
    enabled: runtime.configManager.get('service.enabled'),
    autostart: runtime.configManager.get('service.autostart'),
    restartOnFailure: runtime.configManager.get('service.restartOnFailure'),
  };
  const issues: string[] = [];
  if (!binding.recognized)
    issues.push(
      `controlPlane.hostMode '${binding.hostMode}' is not a recognized mode (local|network|custom); the daemon cannot bind until it is corrected.`,
    );
  if (enabled === true && binding.recognized && !reachable)
    issues.push(`Control plane is enabled but not reachable on ${binding.host}:${binding.port}.`);
  if (enabled === true && service.enabled !== true) issues.push('Control plane is enabled but service mode is off.');
  if (enabled === true && service.autostart !== true) issues.push('Control plane is enabled but service autostart is off.');
  if (enabled === true && service.restartOnFailure !== true) issues.push('Control plane is enabled but service restart-on-failure is off.');
  if (isNetworkFacing(enabled, binding) && !auth.userStorePresent)
    issues.push('Network-facing control plane has no local auth user store.');
  if (isNetworkFacing(enabled, binding) && auth.bootstrapCredentialPresent)
    issues.push('Network-facing control plane still has a bootstrap credential file.');
  return {
    enabled,
    ...binding,
    posture: classifyBindPosture(binding),
    reachable,
    auth,
    service,
    issues,
  };
}

export function formatControlPlaneStatus(runtime: CliCommandRuntime, value: ControlPlaneStatusResult): string {
  return formatJsonOrText(runtime.cli)(
    value,
    [
      'GoodVibes control-plane status',
      `  serves other machines: ${yesNo(value.enabled)} (controlPlane.enabled)`,
      `  bind: ${formatRuntimeEndpointBinding(value)}`,
      `  bind posture: ${value.recognized ? value.posture.label : 'unknown (unrecognized host mode)'}`,
      `  reachable: ${value.reachable === undefined ? 'not probed (unrecognized host mode)' : yesNo(value.reachable)}`,
      `  service: enabled=${yesNo(value.service.enabled)} autostart=${yesNo(value.service.autostart)} restartOnFailure=${yesNo(value.service.restartOnFailure)}`,
      `  local auth users: ${value.auth.userStorePresent ? 'present' : 'missing'}`,
      `  bootstrap credential: ${value.auth.bootstrapCredentialPresent ? 'present' : 'missing'}`,
      `  operator tokens: ${value.auth.operatorTokenPresent ? 'present' : 'missing'}`,
      value.issues.length === 0 ? '  readiness: ready' : '  readiness: needs attention',
      ...value.issues.map((issue) => `    - ${issue}`),
    ].join('\n'),
  );
}

export async function renderControlPlaneStatus(runtime: CliCommandRuntime): Promise<string> {
  return formatControlPlaneStatus(runtime, await buildControlPlaneStatusResult(runtime));
}

interface PairingHandoffCreateResult {
  readonly token: { readonly id: string; readonly name: string; readonly token: string };
  readonly offers: readonly { readonly kind: PairingHandoffOfferKind }[];
  readonly fragment: string;
  readonly deepLink?: string | undefined;
  /** The honest TLS/capability posture of the origin the QR points at (platform-computed). */
  readonly posture?: import('@goodvibes-jev/engine/platform/platform/pairing').OriginPosture | undefined;
}

export async function renderPairing(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, async (services) => {
    // Freeze a stable web origin once (never clobbering a user-set value) so the
    // printed link and the daemon's own handoff origin agree and survive a DHCP
    // lease change where a stable name exists. The verb re-derives the same origin
    // and returns its honest posture. A wildcard bind waits once for the host
    // probes (Tailscale name, a `.local` name that resolves here).
    const hostInputs = pairingOriginUsesStableHost(runtime.configManager) ? await refreshStableHostInputs() : undefined;
    const webOrigin = ensurePublicBaseUrl(runtime.configManager, hostInputs ? () => hostInputs : undefined);
    const name = readOptionValue(runtime.cli.commandArgs, '--name') ?? defaultPairingTokenName();
    // Mint through the canonical hand-off verb ON THE DAEMON: the deep link
    // pairs a device to the daemon-hosted web app, and the offer set (push,
    // relay, passkey) is the daemon's to filter to what it can satisfy. The
    // local `services.gatewayMethods` catalog only forwards invokable
    // built-ins (runtime/gateway-daemon-forward.ts); the daemon verb caller is
    // the direct route for this one and refuses honestly when no daemon is reachable.
    const result = await services.daemonVerbs.invoke<PairingHandoffCreateResult>('pairing.handoff.create', {
      name,
      offers: [...PAIRING_HANDOFF_OFFER_KINDS],
    });
    const link = result.deepLink ?? result.fragment;
    const qr = renderQrToString(generateQrMatrix(link));
    const lines: string[] = [
      'Scan to pair a device; the QR opens the web app already signed in:',
      '',
      `  ${link}`,
      `  Token name: ${result.token.name}  (rename or revoke later in /settings → security → devices)`,
    ];
    if (result.offers.length > 0) {
      lines.push(
        '',
        'Offers carried in this pairing (each declinable in the web app):',
        ...formatPairingOffers(result.offers.map((o) => o.kind)),
      );
    }
    // The labeled browser-capability list and the one honest LAN line both render
    // from the platform posture the verb returned, never a locally-authored string.
    const capabilities = formatPostureCapabilities(result.posture);
    if (capabilities.length > 0) lines.push('', 'This device will get:', ...capabilities);
    const notice = pairingPostureNotice(result.posture);
    if (notice) lines.push('', notice);
    // Tailscale detection is read-only here (the interactive serve lives in the
    // pairing modal); when detected with an https MagicDNS URL, name the encrypted
    // path. Absence stays quiet.
    lines.push(...(await renderPairingTailscaleLines(services)));
    lines.push('', qr);
    // A device that cannot resolve the name in the link (no mDNS, not on the
    // tailnet) can still use the routable address with the same one-time token.
    if (webOrigin.alternateOrigin && link.startsWith(`${webOrigin.origin}/`)) {
      lines.push('', 'If the link does not open on the device, use the address instead:', `  ${webOrigin.alternateOrigin}${link.slice(webOrigin.origin.length)}`);
    }
    return lines.join('\n');
  }, { modelData: 'skip' });
}

interface TailscaleGetResult {
  readonly available: boolean;
  readonly httpsUrl?: string | undefined;
  readonly detail: string;
}

/**
 * Read-only tailscale detection for the `gv pair` block: when tailscale is
 * available with a served https MagicDNS URL, name the encrypted path (the
 * interactive one-action serve lives in the pairing modal). Quiet, an empty
 * array, when tailscale is absent or the probe fails.
 */
async function renderPairingTailscaleLines(services: RuntimeServices): Promise<string[]> {
  try {
    const ts = await services.daemonVerbs.invoke<TailscaleGetResult>('tailscale.get', {});
    if (!ts.available) return [];
    if (ts.httpsUrl) return ['', `Encrypted access (Tailscale): ${ts.httpsUrl}`];
    return ['', 'Tailscale detected: run it as a serve target for encrypted https access (see the pairing modal).'];
  } catch {
    return [];
  }
}

export async function renderRemote(runtime: CliCommandRuntime, label: 'remote' | 'bridge'): Promise<string> {
  return await withRuntimeServices(runtime, (services) => {
    const pools = services.remoteRunnerRegistry.listPools?.() ?? [];
    const contracts = services.remoteRunnerRegistry.listContracts();
    const artifacts = services.remoteRunnerRegistry.listArtifacts();
    const value = {
      pools: pools.length,
      contracts: contracts.length,
      artifacts: artifacts.length,
      remoteFetchPrivateHosts: runtime.configManager.get('network.remoteFetch.allowPrivateHosts'),
    };
    return formatJsonOrText(runtime.cli)(
      value,
      [
        `GoodVibes ${label} status`,
        `  runner pools: ${value.pools}`,
        `  contracts: ${value.contracts}`,
        `  review artifacts: ${value.artifacts}`,
        `  private-host remote fetch: ${yesNo(value.remoteFetchPrivateHosts)}`,
      ].join('\n'),
    );
  }, { modelData: 'skip' });
}

export function renderWeb(runtime: CliCommandRuntime): string {
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'web');
  const publicBaseUrl = String(runtime.configManager.get('web.publicBaseUrl') ?? '');
  const hasEndpointOverride = runtime.cli.flags.hostname !== undefined || runtime.cli.flags.port !== undefined;
  // The engine's stable-host rule, the same one the daemon and pairing print.
  const url =
    !hasEndpointOverride && publicBaseUrl ? publicBaseUrl : formatHttpOrigin(stableUrlHostForBindHost(binding.host).host, binding.port);
  const value = {
    enabled: runtime.configManager.get('web.enabled'),
    ...binding,
    url,
  };
  return formatJsonOrText(runtime.cli)(
    value,
    [
      'GoodVibes web',
      `  enabled: ${yesNo(value.enabled)}`,
      `  bind: ${formatRuntimeEndpointBinding(value)}`,
      `  url: ${value.url}`,
      ...(runtime.cli.flags.open ? [`  open: ${openBrowser(value.url)}`] : []),
    ].join('\n'),
  );
}

export const { renderSubscriptions } = createCliSubscriptionView<CliCommandRuntime, RuntimeServices>(withRuntimeServices, {
  inline: true,
  manualOnly: false,
  binary: () => 'goodvibes',
  source: (source) => source,
  time: (timestamp) => new Date(timestamp).toISOString(),
});

export const { runSecrets } = createCliSecretsCommand<CliCommandRuntime>({
  createSecrets: (runtime) => createRuntimeSecretsManager({
    projectRoot: runtime.workingDirectory, globalHome: runtime.homeDirectory, surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    configManager: runtime.configManager, daemonHome: resolveGoodVibesDaemonHome(runtime.homeDirectory),
  }),
  binary: () => 'goodvibes',
  inline: true,
  writeScope: (_key, requested) => requested,
  deleteScope: (_key, requested) => requested,
  relocation: () => [],
});
export const { handleSessions, handleTasks } = createCliWorkspaceCommands<CliCommandRuntime, RuntimeServices>(withRuntimeServices, {
  binary: () => 'goodvibes',
  inline: true,
  time: (timestamp) => new Date(timestamp).toISOString(),
  allowSubmit: true,
  verbs: (_runtime, services) => services.daemonVerbs,
  async submit(runtime, rest) {
    const prompt = rest.join(' ').trim();
    if (!prompt) return cliCommandRefusal(runtime.cli, 'usage', 'Usage: goodvibes tasks submit <prompt>');
    const runCli = {
      ...runtime.cli,
      command: 'run' as const,
      flags: { ...runtime.cli.flags, prompt },
      positionals: [prompt],
    };
    const code = await runNonInteractiveAgent({ ...runtime, cli: runCli });
    // The run printed its own outcome; its exit code is the command's.
    return { output: code === 0 ? '' : `Task submit failed with exit code ${code}`, exitCode: code };
  },
});
