/**
 * service-posture.ts, how a program's settings place the daemon's three network
 * endpoints (the control plane, the plain HTTP listener, the web UI), what each
 * exposes, and the service log; read by the terminal programs' status and
 * service commands and by the daemon when it writes a support bundle
 * (capabilities/builtin/system-bundles.ts). Moved here from terminal-shell
 * (cli-endpoints, cli-network-posture, service-posture) and the Agent
 * (`buildCliServicePosture`), so the daemon reads the same facts the programs do.
 */
import { closeSync, existsSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { captureJudgmentPort, type JudgmentPortCapture, type JudgmentReadingOptions } from '@goodvibes/engine/errors';
import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema-types.js';
import { resolveConnectedHostDialEnabled, resolveDaemonEnabled } from '../config/index.js';
import { resolveHostBinding, resolveWebPort } from '../daemon/host-resolver.js';
import { isLoopbackHost } from '../utils/reachable-base-url.js';
import { resolveWebUiListener } from '../pairing/web-origin.js';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { redactText } from './config-redaction.js';

// ---------------------------------------------------------------------------
// The endpoints' settings and bindings
// ---------------------------------------------------------------------------

export type RuntimeEndpointId = 'controlPlane' | 'httpListener' | 'web';
export type RuntimeHostMode = 'local' | 'network' | 'custom';
export type RuntimeEndpointSettingKey<E extends RuntimeEndpointId = RuntimeEndpointId> = `${E}.${'hostMode' | 'host' | 'port'}`;

/**
 * Any reader of the endpoint settings: a config manager or a narrower view of
 * one. A reader of some endpoints only (`RuntimeEndpointConfigReader<'controlPlane'>`)
 * serves those endpoints.
 */
export interface RuntimeEndpointConfigReader<E extends RuntimeEndpointId = RuntimeEndpointId> {
  get(key: RuntimeEndpointSettingKey<E>): unknown;
}

export const RUNTIME_ENDPOINT_DEFAULT_PORTS: Record<RuntimeEndpointId, number> = {
  controlPlane: 3421,
  httpListener: 3422,
  web: 3423,
};

export const RUNTIME_ENDPOINT_CONFIG_KEYS: {
  readonly [E in RuntimeEndpointId]: {
    readonly hostMode: `${E}.hostMode` & ConfigKey;
    readonly host: `${E}.host` & ConfigKey;
    readonly port: `${E}.port` & ConfigKey;
  };
} = {
  controlPlane: { hostMode: 'controlPlane.hostMode', host: 'controlPlane.host', port: 'controlPlane.port' },
  httpListener: { hostMode: 'httpListener.hostMode', host: 'httpListener.host', port: 'httpListener.port' },
  web: { hostMode: 'web.hostMode', host: 'web.host', port: 'web.port' },
};

export interface RuntimeEndpointBinding {
  /** The applied mode when recognized; the stored text as written when not. */
  readonly hostMode: string;
  readonly configuredHost: string;
  readonly host: string;
  readonly port: number;
  /**
   * False when the stored hostMode is not one of 'local' | 'network' | 'custom'
   * (after trimming and lowercasing). The platform's bind rule then applies
   * the local posture, so host and port are 127.0.0.1 and the endpoint's port.
   */
  readonly recognized: boolean;
}

/**
 * The one text form of an endpoint binding: `<mode> <host>:<port>`, or, for an
 * unrecognized stored mode, that mode named with the local binding the
 * platform applies in its place.
 */
export function formatRuntimeEndpointBinding(binding: RuntimeEndpointBinding): string {
  if (binding.recognized) {
    return `${binding.hostMode} ${binding.host}:${binding.port}`;
  }
  return `'${binding.hostMode}', not a recognized host mode (expected local|network|custom); read as local, this computer only (${binding.host}:${binding.port})`;
}

export function hostModeForHostname(hostname: string): RuntimeHostMode {
  const normalized = hostname.toLowerCase();
  if (normalized === '0.0.0.0' || normalized === '::') return 'network';
  if (normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1') return 'local';
  return 'custom';
}

export function resolveRuntimeEndpointBinding<E extends RuntimeEndpointId>(
  config: RuntimeEndpointConfigReader<E>,
  endpoint: E,
): RuntimeEndpointBinding {
  const keys: { readonly hostMode: RuntimeEndpointSettingKey<E>; readonly host: RuntimeEndpointSettingKey<E>; readonly port: RuntimeEndpointSettingKey<E> } = RUNTIME_ENDPOINT_CONFIG_KEYS[endpoint];
  const hostMode = String(config.get(keys.hostMode) ?? 'local');
  const configuredHost = String(config.get(keys.host) ?? '127.0.0.1');
  const rawPort = config.get(keys.port);
  // The platform's bind rule decides host, port and mode; the web port goes
  // through the platform's own web port rule, which every web surface uses.
  const binding = resolveHostBinding(hostMode, configuredHost, Number(rawPort ?? RUNTIME_ENDPOINT_DEFAULT_PORTS[endpoint]), endpoint);
  return {
    hostMode: binding.recognized ? binding.effectiveMode : hostMode,
    configuredHost,
    host: binding.host,
    port: endpoint === 'web' ? resolveWebPort(rawPort) : binding.port,
    recognized: binding.recognized,
  };
}

// ---------------------------------------------------------------------------
// What a binding exposes
// ---------------------------------------------------------------------------

export type BindPostureKind = 'local' | 'local-network' | 'custom-network';

export interface BindPosture {
  readonly kind: BindPostureKind;
  readonly label: string;
  readonly networkFacing: boolean;
}

export { isLoopbackHost };

export function classifyBindPosture(binding: Pick<RuntimeEndpointBinding, 'hostMode' | 'host'>): BindPosture {
  if (binding.hostMode === 'local' || isLoopbackHost(binding.host)) {
    return { kind: 'local', label: 'Local only', networkFacing: false };
  }
  if (binding.hostMode === 'network' || binding.host === '0.0.0.0' || binding.host === '::') {
    return { kind: 'local-network', label: 'Local Network', networkFacing: true };
  }
  return { kind: 'custom-network', label: 'Custom network', networkFacing: true };
}

export function isNetworkFacing(
  enabled: unknown,
  binding: Pick<RuntimeEndpointBinding, 'hostMode' | 'host'>,
): boolean {
  return enabled === true && classifyBindPosture(binding).networkFacing;
}

/**
 * The web UI's network exposure, from the listener that actually serves it
 * (the engine's one owner of that address, `resolveWebUiListener`): while the
 * daemon serves the bundle it is the control-plane listener, network-facing
 * only when that listener is bound beyond loopback and `controlPlane.enabled`
 * lets other machines in. With no bundle served nothing serves it, whatever
 * `web.hostMode`, `web.host` or `web.port` say: those are a development
 * server's, and a setting only a development server binds is never exposure.
 */
export function resolveWebSurfaceExposure(config: Pick<ConfigManager, 'get'>): {
  readonly served: boolean;
  /** The control-plane binding while served; the development endpoint otherwise, for display only. */
  readonly binding: RuntimeEndpointBinding;
  readonly networkFacing: boolean;
} {
  if (resolveWebUiListener(config) === null) {
    return { served: false, binding: resolveRuntimeEndpointBinding(config, 'web'), networkFacing: false };
  }
  const binding = resolveRuntimeEndpointBinding(config, 'controlPlane');
  return { served: true, binding, networkFacing: isNetworkFacing(config.get('controlPlane.enabled') === true, binding) };
}

// ---------------------------------------------------------------------------
// The service posture: endpoints, the service log, the findings
// ---------------------------------------------------------------------------

export interface CliServiceRuntime {
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

export interface CliServiceEndpointPosture {
  readonly id: RuntimeEndpointId;
  readonly label: string;
  readonly enabled: boolean;
  readonly binding: RuntimeEndpointBinding;
  readonly bindPosture: ReturnType<typeof classifyBindPosture>;
  readonly networkFacing: boolean;
  /** For an endpoint that always serves this machine while it runs: whether other machines are served too. */
  readonly servesOtherMachines?: boolean;
  readonly reachable?: boolean;
}

export interface CliServiceLogPosture {
  readonly provenance?: 'classic';
  readonly path: string | null;
  readonly exists: boolean;
  readonly size: number;
  readonly modifiedAt: number | null;
  readonly tail?: string;
  readonly readError?: string;
}

export async function readServiceLogPosture(
  path: string | undefined,
  tailBytes: number,
  options: JudgmentReadingOptions,
  captureOwner?: () => void,
): Promise<CliServiceLogPosture> {
  return withConfiguredDecisionModelPolicy(() => readOwnedServiceLogPosture(path, tailBytes, options, captureOwner));
}

async function readOwnedServiceLogPosture(path: string | undefined, tailBytes: number, options: JudgmentReadingOptions, captureOwner?: () => void): Promise<CliServiceLogPosture> {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  if (!path) return { path: null, exists: false, size: 0, modifiedAt: null };
  if (!existsSync(path)) return { path, exists: false, size: 0, modifiedAt: null };
  let captured: { readonly stat: Stats; readonly text: string };
  try {
    const stat = statSync(path);
    const length = Math.min(stat.size, Math.max(0, tailBytes));
    if (length === 0) {
      return { path, exists: true, size: stat.size, modifiedAt: stat.mtimeMs, tail: '' };
    }
    const raw = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    let read: number;
    try {
      read = readSync(fd, raw, 0, length, Math.max(0, stat.size - length));
    } finally {
      closeSync(fd);
    }
    // A file truncated since the stat returns fewer bytes than asked; the rest
    // of the buffer is zero padding, not log text.
    let start = 0;
    // The tail begins mid-file, possibly inside a multi-byte character.
    if (stat.size > length) while (start < read && (raw[start]! & 0xc0) === 0x80) start++;
    captured = { stat, text: raw.subarray(start, read).toString('utf-8') };
  } catch {
    return { path, exists: true, size: 0, modifiedAt: null, readError: 'Service log could not be read.' };
  }
  const ownersCurrent = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
  };
  // The service keeps appending while a model-backed redaction runs, so growth
  // is expected. A different file (rotation) or a shorter one (truncation) means
  // the captured bytes no longer describe the log.
  const logReplaced = (): boolean => {
    let current: Stats;
    try {
      current = statSync(path);
    } catch {
      return true; // removed or unreadable: not the file that was captured
    }
    const original = captured.stat;
    return current.dev !== original.dev || current.ino !== original.ino || current.size < original.size;
  };
  const changed: CliServiceLogPosture = {
    path, exists: true, size: captured.stat.size, modifiedAt: captured.stat.mtimeMs, readError: 'Service log changed while it was read.',
  };
  class LogReplaced extends Error {}
  const assertCurrent = () => {
    ownersCurrent();
    if (logReplaced()) throw new LogReplaced('Service log changed during redaction.');
  };
  let tail: string;
  try {
    tail = await decisionOrClassic(() => {
      captureOwner?.();
      return redactText(captured.text, { ...options, assertCurrent });
    }, () => redactText(captured.text, { ...options, assertCurrent }));
  } catch (error) {
    // Cancellation and revoked ownership still prevent the entire publication.
    ownersCurrent();
    if (error instanceof LogReplaced || logReplaced()) return changed;
    // Withhold the captured bytes when redaction is unavailable.
    return { path, exists: true, size: captured.stat.size, modifiedAt: captured.stat.mtimeMs, readError: 'Service log could not be read safely.' };
  }
  ownersCurrent();
  if (logReplaced()) return changed;
  return { path, exists: true, size: captured.stat.size, modifiedAt: captured.stat.mtimeMs, tail,
    ...(isClassicOperation() ? { provenance: 'classic' as const } : {}) };
}

/** Revalidate retained configuration and synchronous ownership before publishing diagnostics. */
export function retainServicePostureInput(
  runtime: CliServiceRuntime,
  options: JudgmentReadingOptions,
  assertConfigCurrent: () => void,
  message: string,
): () => void {
  const { configManager, workingDirectory, homeDirectory } = runtime;
  const signal = options.signal,
    callerCurrent = options.assertCurrent;
  const sourceCurrent = () => {
    signal?.throwIfAborted();
    if (
      options.signal !== signal ||
      options.assertCurrent !== callerCurrent ||
      runtime.configManager !== configManager ||
      runtime.workingDirectory !== workingDirectory ||
      runtime.homeDirectory !== homeDirectory
    )
      throw new Error(message);
    assertConfigCurrent();
  };
  return () => {
    sourceCurrent();
    assertSynchronousJudgmentGuard(callerCurrent, () => new Error('Service posture ownership must be synchronous.'));
    sourceCurrent();
  };
}

export async function readServiceEndpoints(
  runtime: CliServiceRuntime,
  definitions: readonly {
    readonly id: RuntimeEndpointId;
    readonly label: string;
    readonly enabledKey: Parameters<ConfigManager['get']>[0];
    /**
     * Whether the endpoint listens, when one setting does not say it alone (the
     * control plane listens whenever the daemon runs: `resolveDaemonEnabled`).
     * Absent: `enabledKey` is true.
     */
    readonly isEnabled?: ((config: Pick<ConfigManager, 'get'>) => boolean) | undefined;
    /**
     * The setting that says whether other machines are served too, for an
     * endpoint that serves this machine whenever it listens
     * (`controlPlane.enabled`). Only that makes it network-facing.
     */
    readonly servesOtherMachinesKey?: Parameters<ConfigManager['get']>[0] | undefined;
  }[],
  options: {
    readonly probe: boolean | undefined;
    readonly mayProbe: (binding: RuntimeEndpointBinding) => boolean;
    readonly probeTcp: (host: string, port: number) => Promise<boolean>;
    readonly assertCurrent: () => void;
  },
): Promise<CliServiceEndpointPosture[]> {
  options.assertCurrent();
  const endpoints = await Promise.all(
    definitions.map(async (endpoint) => {
      const switchedOn = endpoint.isEnabled ? endpoint.isEnabled(runtime.configManager) : runtime.configManager.get(endpoint.enabledKey) === true;
      // The web UI listens only where it is served: the control-plane listener
      // while the daemon serves the bundle, nowhere otherwise (web.* is a development server's).
      const web = endpoint.id === 'web' ? resolveWebSurfaceExposure(runtime.configManager) : undefined;
      const enabled = web === undefined ? switchedOn : switchedOn && web.served;
      const servesOtherMachines = endpoint.servesOtherMachinesKey === undefined
        ? undefined
        : enabled && runtime.configManager.get(endpoint.servesOtherMachinesKey) === true;
      const binding = web?.binding ?? resolveRuntimeEndpointBinding(runtime.configManager, endpoint.id);
      const result: CliServiceEndpointPosture = {
        id: endpoint.id,
        label: endpoint.label,
        enabled,
        binding,
        bindPosture: classifyBindPosture(binding),
        networkFacing: web === undefined ? isNetworkFacing(servesOtherMachines ?? enabled, binding) : enabled && web.networkFacing,
        ...(servesOtherMachines === undefined ? {} : { servesOtherMachines }),
        ...(options.probe && enabled && binding.recognized && options.mayProbe(binding)
          ? { reachable: await options.probeTcp(binding.host, binding.port) }
          : {}),
      };
      options.assertCurrent();
      return result;
    }),
  );
  options.assertCurrent();
  return endpoints;
}

/**
 * One service finding as every report states it: what is wrong (summary), why,
 * what it costs, and the one command that fixes it. `status`, `doctor` and
 * `service status` in both terminal apps print these records as they are, so a
 * finding has one wording and one remedy wherever it shows.
 */
export interface ServiceFinding {
  readonly id: string;
  readonly summary: string;
  readonly cause: string;
  readonly impact: string;
  readonly action: string;
}

/** The endpoint findings: one that is on but does not answer, and two configured onto one address. */
export function serviceEndpointFindings(endpoints: readonly CliServiceEndpointPosture[], probe: boolean | undefined): ServiceFinding[] {
  const findings: ServiceFinding[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.enabled && probe && endpoint.reachable === false) {
      findings.push({
        id: `endpoint-unreachable-${endpoint.id}`,
        summary: `${endpoint.label} is enabled but not reachable on ${endpoint.binding.host}:${endpoint.binding.port}.`,
        cause: 'Nothing answered on that address when it was tried: the daemon is not running, or it could not bind the address.',
        impact: `Programs that connect to the ${endpoint.label} cannot reach it.`,
        action: 'Start the daemon: goodvibes-daemon start-service (its log says why a bind failed: goodvibes-daemon service-status)',
      });
    }
  }
  const enabled = endpoints.filter((endpoint) => endpoint.enabled);
  for (const [index, left] of enabled.entries()) {
    for (const right of enabled.slice(index + 1)) {
      // A served web UI is the control-plane listener itself, not a second bind.
      if ((left.id === 'web' && right.id === 'controlPlane') || (left.id === 'controlPlane' && right.id === 'web')) continue;
      const a = left.binding,
        b = right.binding;
      if (a.port === b.port && (a.host === b.host || a.host === '0.0.0.0' || b.host === '0.0.0.0' || a.host === '::' || b.host === '::')) {
        findings.push({
          id: `endpoint-conflict-${left.id}-${right.id}`,
          summary: `${left.label} and ${right.label} are configured to bind the same host/port envelope (${a.host}:${a.port}, ${b.host}:${b.port}).`,
          cause: 'Two endpoints are set to the same port on overlapping addresses.',
          impact: 'Only one of them can start; the other fails to bind.',
          action: `Give one of them another port: goodvibes-daemon config set ${right.id}.port <port>`,
        });
      }
    }
  }
  return findings;
}

/** The finding for a service log that exists but cannot be read. */
export function serviceLogUnreadableFinding(readError: string): ServiceFinding {
  return {
    id: 'service-log-unreadable',
    summary: `Service log exists but could not be read: ${readError}`,
    cause: 'The daemon service log exists but this user cannot read it.',
    impact: 'A failed start cannot be diagnosed from the log.',
    action: 'Check the file\'s owner and mode with ls -l on the path named above.',
  };
}

/** The endpoint findings' summaries, for a report that lists them as lines. */
export function serviceEndpointIssues(endpoints: readonly CliServiceEndpointPosture[], probe: boolean | undefined): string[] {
  return serviceEndpointFindings(endpoints, probe).map((finding) => finding.summary);
}

// ---------------------------------------------------------------------------
// A program's connected-host posture (the Agent's, and the daemon's support bundle for either program)
// ---------------------------------------------------------------------------

export interface ConnectedHostServicePosture {
  readonly config: {
    readonly enabled: boolean;
    readonly autostart: boolean;
    readonly restartOnFailure: boolean;
    /** `daemon.enabled`, whether this surface adopts a session daemon of its own. */
    readonly daemonEnabled: boolean;
    /**
     * `daemon.connectedHost.enabled`, whether this surface may DIAL the host
     * it is connected to. Reported separately because it is what the
     * daemon-backed features actually consult; reporting only the adopt flag
     * described a machine that was not the one running.
     */
    readonly connectedHostDialEnabled: boolean;
  };
  readonly endpoints: readonly CliServiceEndpointPosture[];
  readonly log: CliServiceLogPosture;
  readonly issues: readonly string[];
  /** The same issues as whole records (summary, cause, impact, one remedy): what doctor prints. */
  readonly findings: readonly ServiceFinding[];
  /**
   * Observations that describe the INTENDED arrangement rather than a fault.
   *
   * Kept apart from `issues` because everything in that array is rendered as a
   * problem, with a cause and an impact that say something may be unavailable.
   * That is the wrong sentence for a posture that is working as designed, and
   * the difference matters at release time: an advisory must not be able to
   * turn a strict verification red.
   */
  readonly advisories: readonly string[];
}

const CONNECTED_HOST_ENDPOINTS: readonly { readonly id: RuntimeEndpointId; readonly label: string; readonly enabledKey: ConfigKey }[] = [
  { id: 'controlPlane', label: 'runtime connection', enabledKey: 'controlPlane.enabled' },
  { id: 'httpListener', label: 'inbound events endpoint', enabledKey: 'danger.httpListener' },
  { id: 'web', label: 'browser companion route', enabledKey: 'web.enabled' },
];

export interface ConnectedHostServicePostureOptions extends JudgmentReadingOptions {
  readonly probe?: boolean;
  readonly logTailBytes?: number;
  /** How this program tries an endpoint (a TCP connect); needed only with `probe`. */
  readonly probeTcp?: (host: string, port: number) => Promise<boolean>;
  /** The decision site the service log's redaction is logged under. */
  readonly logSite?: string;
}

/** The settings as read now, and a check that they have not changed since (the config manager's incarnation). */
export function retainCliConfig(manager: Pick<ConfigManager, 'getRaw' | 'getConfigurationIncarnation'>) {
  const incarnation = manager.getConfigurationIncarnation();
  const raw = manager.getRaw();
  const assertCurrent = () => {
    if (manager.getConfigurationIncarnation() !== incarnation) {
      throw new Error('Settings changed while this was being read; nothing was done. Run it again to use the current settings.');
    }
  };
  return { raw, assertCurrent };
}

function resolveConfiguredLogPath(runtime: CliServiceRuntime): string | undefined {
  const value = runtime.configManager.get('service.logPath');
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return isAbsolute(trimmed) ? trimmed : join(runtime.homeDirectory, trimmed);
}

/** A program's posture toward the host it connects to: its endpoint settings, the service log, the findings. */
export async function buildConnectedHostServicePosture(
  runtime: CliServiceRuntime,
  options: ConnectedHostServicePostureOptions = {},
): Promise<ConnectedHostServicePosture> {
  const retainedConfig = retainCliConfig(runtime.configManager);
  const assertCurrent = retainServicePostureInput(
    runtime,
    options,
    () => {
      try {
        retainedConfig.assertCurrent();
      } catch {
        throw new Error('Service posture input changed before publication.');
      }
    },
    'Service posture input changed before publication.',
  );
  const reading = { ...options, assertCurrent };
  assertCurrent();
  const endpoints = await readServiceEndpoints(runtime, CONNECTED_HOST_ENDPOINTS, {
    probe: options.probe,
    assertCurrent,
    probeTcp: options.probeTcp ?? (async () => false),
    mayProbe: () => options.probeTcp !== undefined && resolveConnectedHostDialEnabled(runtime.configManager),
  });

  const config = {
    enabled: runtime.configManager.get('service.enabled') === true,
    autostart: runtime.configManager.get('service.autostart') === true,
    restartOnFailure: runtime.configManager.get('service.restartOnFailure') === true,
    daemonEnabled: resolveDaemonEnabled(runtime.configManager),
    connectedHostDialEnabled: resolveConnectedHostDialEnabled(runtime.configManager),
  };
  // Dialing is what the daemon-backed features consult, so a machine that does
  // not adopt a daemon but does dial a connected one is server-backed, which
  // is exactly the topology this product is designed for.
  const serverBackedEnabled = config.daemonEnabled || config.connectedHostDialEnabled || endpoints.some((endpoint) => endpoint.enabled);
  const findings: ServiceFinding[] = [];
  const advisories: string[] = [];

  if (serverBackedEnabled && !config.enabled) {
    // Not a fault. The Agent is designed not to own the host, a connected
    // GoodVibes daemon does, so this is the normal topology.
    advisories.push('Connected-host settings are present, but Agent host ownership is disabled by design.');
  }
  findings.push(...serviceEndpointFindings(endpoints, options.probe));
  const configuredLogPath = resolveConfiguredLogPath(runtime);
  let logOwner: JudgmentPortCapture | undefined;
  const logReading = {
    ...reading,
    assertCurrent: () => {
      assertCurrent();
      if (!isClassicOperation()) logOwner?.assertCurrent();
    },
  };
  const log = await readServiceLogPosture(configuredLogPath, options.logTailBytes ?? 4096, logReading, () => {
    logOwner = captureJudgmentPort(options.logSite ?? 'agent.cli.service-log', reading);
  });
  if (log.readError) {
    findings.push(serviceLogUnreadableFinding(log.readError));
  }

  assertCurrent();
  if (!isClassicOperation()) logOwner?.assertCurrent();
  return {
    config,
    endpoints,
    log,
    issues: findings.map((finding) => finding.summary),
    findings,
    advisories,
  };
}
