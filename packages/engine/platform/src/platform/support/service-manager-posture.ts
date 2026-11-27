/**
 * service-manager-posture.ts, the daemon service as the service manager on this machine reports it: the service
 * settings, the managed unit (installed, running, starts at login, its pid file, its log), the endpoints the daemon
 * binds, and one finding per difference a command can fix. One reading for every door: `goodvibes service
 * status|check`, `goodvibes status`, and every support bundle the daemon writes (`diagnostics.service`), so each
 * records the same service facts. Moved here from the terminal app's cli/service-posture.ts; the program's own way to
 * find the daemon program on its install stays there and is passed in as `daemonCommand`.
 */
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import type { ConfigManager } from '../config/manager.js';
import { resolveDaemonEnabled } from '../config/index.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { resolveServiceUnitHome } from '../daemon/daemon-service-default.js';
import { resolveServiceName, serviceStateDirectory, type ManagedServiceStatus, type PlatformServiceManager } from '../daemon/service-manager.js';
import { buildManagedDaemonServiceManager, MANAGED_SERVICE_NAME, resolveInstalledDaemonBinary } from '../daemon/managed-daemon-service.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { redactText } from './config-redaction.js';
import {
  formatRuntimeEndpointBinding,
  readServiceEndpoints,
  readServiceLogPosture,
  retainServicePostureInput,
  serviceEndpointFindings,
  serviceLogUnreadableFinding,
  type CliServiceEndpointPosture,
  type CliServiceLogPosture,
  type CliServiceRuntime,
  type RuntimeEndpointId,
  type ServiceFinding,
} from './service-posture.js';

export type { CliServiceRuntime, CliServiceEndpointPosture, CliServiceLogPosture } from './service-posture.js';

export interface CliServicePosture {
  readonly config: {
    readonly enabled: boolean;
    readonly autostart: boolean;
    readonly restartOnFailure: boolean;
    readonly daemonEnabled: boolean;
  };
  readonly managed: ManagedServiceStatus & {
    readonly pidPath: string;
    readonly lastError: string | null;
  };
  readonly endpoints: readonly CliServiceEndpointPosture[];
  readonly log: CliServiceLogPosture;
  /** The summaries of `findings`, in the same order. */
  readonly issues: readonly string[];
  /** Each issue with a fixed id, so doctor and scripts can track one fact across runs. */
  readonly findings: readonly CliServiceIssue[];
}

/** One service finding with its cause, impact and one remedy (service-posture.ts). */
export type CliServiceIssue = ServiceFinding;

/** The service settings and the observed facts the setting rules depend on. */
export interface CliServiceSettingsFacts {
  /** `service.enabled`: false is the owner's choice of a machine without a daemon service. */
  readonly enabled: boolean;
  /** Whether the installed service starts at login, as the service manager reports it. */
  readonly autostart: boolean;
  readonly restartOnFailure: boolean;
  /** The daemon or any server-backed endpoint is switched on. */
  readonly serverBackedEnabled: boolean;
  /** Whether a platform service definition exists; undefined when the caller did not look. */
  readonly installed?: boolean;
  /** Whether the installed service runs; undefined when the caller did not look. */
  readonly running?: boolean;
  /** The service name, for the command each finding names. */
  readonly serviceName?: string;
}

/**
 * The service rules, stated once. `goodvibes service status`, `doctor` and
 * `listener test` all read these, so a fact is reported once under one id.
 * They read what the service manager reports, not what a setting says it
 * should be: an installation made without a service (`--no-service`, which
 * records `service.enabled` false) and one whose service is installed and
 * running are both clean, and only a difference a command can fix is a finding.
 */
export function serviceSettingsIssues(facts: CliServiceSettingsFacts): CliServiceIssue[] {
  const issues: CliServiceIssue[] = [];
  if (!facts.enabled) return issues;
  const unit = facts.serviceName ?? 'goodvibes';
  if (facts.installed === false && facts.serverBackedEnabled) {
    issues.push({
      id: 'service-not-installed',
      summary: 'No daemon service is installed, so the daemon runs only while something starts it.',
      cause: 'This machine has no daemon service, and service.enabled does not record that it should run without one.',
      impact: 'The daemon runs only while it is started by hand or by a program that needs it, and not after a reboot.',
      action: 'Install the service: goodvibes-daemon install-service. To keep this machine without one: goodvibes-daemon config set service.enabled false',
    });
  }
  if (facts.installed === true && facts.running === false) {
    issues.push({
      id: 'service-not-running',
      summary: 'The daemon service is installed but not running.',
      cause: 'The service manager reports the daemon service installed but stopped.',
      impact: 'The terminal app, the Agent and the web UI have no daemon to connect to until it starts.',
      action: 'Start it: goodvibes-daemon start-service. If it stops again, read its log: goodvibes-daemon service-status',
    });
  }
  if (facts.installed === true && !facts.autostart) {
    issues.push({
      id: 'service-autostart-disabled',
      summary: 'The daemon service is installed but does not start at login.',
      cause: 'The service manager reports the daemon service installed but not set to start at login.',
      impact: 'The daemon does not come back after a login or reboot.',
      action: `Enable it again: goodvibes-daemon install-service (it re-enables ${unit})`,
    });
  }
  if (facts.installed === true && !facts.restartOnFailure) {
    issues.push({
      id: 'service-restart-disabled',
      summary: 'The daemon service is not restarted after a failure.',
      cause: 'service.restartOnFailure is false.',
      impact: 'A daemon that crashes stays down until it is started again.',
      action: 'goodvibes-daemon config set service.restartOnFailure true (the daemon service rewrites its definition with it; it takes effect at the next daemon start)',
    });
  }
  return issues;
}

type EndpointDefinition = {
  readonly id: RuntimeEndpointId;
  readonly label: string;
  readonly enabledKey: Parameters<ConfigManager['get']>[0];
  readonly isEnabled?: ((config: Pick<ConfigManager, 'get'>) => boolean) | undefined;
  readonly servesOtherMachinesKey?: Parameters<ConfigManager['get']>[0] | undefined;
};

/**
 * The endpoints the daemon binds a socket for. The control plane listens for
 * this machine whenever the daemon runs; controlPlane.enabled only says whether
 * other machines are served too (daemon/http/listener-admission.ts).
 */
const LISTENING_ENDPOINTS: readonly EndpointDefinition[] = [
  { id: 'controlPlane', label: 'control plane', enabledKey: 'daemon.enabled', isEnabled: resolveDaemonEnabled, servesOtherMachinesKey: 'controlPlane.enabled' },
  { id: 'httpListener', label: 'HTTP listener', enabledKey: 'danger.httpListener' },
];
/** Nothing listens on web.host:web.port: the control-plane listener serves the web bundle, so web is reachable when it is. */
const WEB_ENDPOINT: EndpointDefinition = { id: 'web', label: 'web surface', enabledKey: 'web.enabled' };

interface CliServiceStatusCommandResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface CliServiceStatusManager {
  status(): ManagedServiceStatus;
}

export interface CliServicePostureOptions extends JudgmentReadingOptions {
  readonly probe?: boolean;
  readonly logTailBytes?: number;
  readonly manager?: CliServiceStatusManager;
  readonly runCommand?: (command: string, args: readonly string[]) => CliServiceStatusCommandResult;
  /** The daemon program the unit's command names (the asking program's own way to find it); the installed daemon's otherwise. */
  readonly daemonCommand?: string;
}

function dialHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host || '127.0.0.1';
}

/** One TCP connect: whether something accepts on host:port. */
function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise<boolean>((done) => {
    const socket = connect({ host: dialHost(host), port });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function getServiceStateRoot(runtime: CliServiceRuntime): string {
  return resolveGoodVibesDaemonHome(runtime.homeDirectory);
}

/** The pid file the service manager writes: under the login home, the same for the daemon and both terminal apps. */
function pidFilePath(platform: ManagedServiceStatus['platform']): string {
  return join(serviceStateDirectory(resolveServiceUnitHome()), `${platform}.pid`);
}

/** The slice of the config manager that names the service; provenance is optional so callers holding only `get` still resolve. */
export interface CliServiceNameSource {
  get(key: string): unknown;
  describeConfigKeySource?(key: string): { readonly tier: string; readonly effectiveOrigin?: string | undefined } | undefined;
}

/** The daemon unit's name: the owner's `service.serviceName`, else the platform's one default. */
export function resolveCliServiceName(configManager: CliServiceNameSource): string {
  const describe = configManager.describeConfigKeySource?.bind(configManager);
  return resolveServiceName({
    get: (key) => configManager.get(key),
    // A source that cannot say where the name came from is read by its value alone.
    describeConfigKeySource: (key) => describe?.(key) ?? { tier: 'unknown' },
  }, MANAGED_SERVICE_NAME);
}

function runStatusCommand(command: string, args: readonly string[], options: CliServicePostureOptions): CliServiceStatusCommandResult {
  if (options.runCommand) return options.runCommand(command, args);
  return spawnSync(command, [...args], {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 1500,
  });
}

function parseSystemdShowValue(lines: readonly string[], key: string): string | null {
  const prefix = `${key}=`;
  const match = lines.find((line) => line.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : null;
}

function reconcileSystemdServiceStatus(
  runtime: CliServiceRuntime,
  status: ManagedServiceStatus,
  options: CliServicePostureOptions,
): ManagedServiceStatus {
  if (status.platform !== 'systemd') return status;

  const name = resolveCliServiceName(runtime.configManager);
  const result = runStatusCommand(
    'systemctl',
    ['--user', 'show', `${name}.service`, '--property=LoadState,ActiveState,UnitFileState,MainPID', '--no-page'],
    options,
  );
  if ((result.status ?? 1) !== 0) return status;

  const lines = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const loadState = parseSystemdShowValue(lines, 'LoadState');
  const activeState = parseSystemdShowValue(lines, 'ActiveState');
  const unitFileState = parseSystemdShowValue(lines, 'UnitFileState');
  const rawPid = Number.parseInt(parseSystemdShowValue(lines, 'MainPID') ?? '', 10);
  const pid = Number.isFinite(rawPid) && rawPid > 0 ? rawPid : undefined;

  return {
    ...status,
    installed: loadState === 'loaded' || status.installed,
    // What systemd reports, not the setting: install-service enables the unit.
    autostart: unitFileState === 'enabled' || unitFileState === 'linked',
    running: activeState === 'active',
    ...(pid === undefined ? {} : { pid }),
  };
}

/**
 * The daemon's service manager: the one definition the daemon CLI also
 * installs (daemon/managed-daemon-service.ts), under the platform's one unit
 * name, so a status reports the unit the installer or the daemon wrote, and an
 * install never adds a second unit for the same port.
 */
export function createPlatformServiceManager(
  runtime: CliServiceRuntime,
  workingDirectory: string = resolveDaemonWorkingDirectory(runtime),
  daemonCommand: string = resolveInstalledDaemonBinary(),
): PlatformServiceManager {
  return buildManagedDaemonServiceManager({
    binaryPath: daemonCommand,
    homeDir: runtime.homeDirectory,
    // The unit and its pid file go under the login home, as the daemon's own
    // service manager reads them, whatever tree home this program runs on.
    unitHomeDir: resolveServiceUnitHome(),
    daemonHomeDirectory: getServiceStateRoot(runtime),
    workingDirectory,
    configManager: runtime.configManager,
  });
}

/**
 * The folder the service starts the daemon in: the home. The daemon has no working folder of its own to name (each
 * program and schedule names its project), so nothing else is read for it.
 */
function resolveDaemonWorkingDirectory(runtime: CliServiceRuntime): string {
  return runtime.homeDirectory;
}

export async function buildCliServicePosture(
  runtime: CliServiceRuntime,
  options: CliServicePostureOptions = {},
): Promise<CliServicePosture> {
  const configManager = runtime.configManager;
  const snapshot = captureStrictJudgmentJson(configManager.getRaw());
  const assertCurrent = retainServicePostureInput(
    runtime,
    options,
    () => {
      if (!isDeepStrictEqual(captureStrictJudgmentJson(configManager.getRaw()), snapshot))
        throw new Error('Service posture input changed.');
    },
    'Service posture input changed.',
  );
  assertCurrent();
  const workingDirectory = resolveDaemonWorkingDirectory(runtime);
  const manager = options.manager ?? createPlatformServiceManager(runtime, workingDirectory, options.daemonCommand);
  const capturedStatus = captureStrictJudgmentJson(reconcileSystemdServiceStatus(runtime, manager.status(), options));
  const actionError =
    capturedStatus.actionError === undefined ? undefined : await redactText(capturedStatus.actionError, { ...options, assertCurrent });
  assertCurrent();
  const status = actionError === undefined ? capturedStatus : { ...capturedStatus, actionError };
  const listening = await readServiceEndpoints(runtime, LISTENING_ENDPOINTS, {
    probe: options.probe,
    assertCurrent,
    probeTcp,
    mayProbe: () => true,
  });
  const [web] = await readServiceEndpoints(runtime, [WEB_ENDPOINT], { probe: false, assertCurrent, probeTcp, mayProbe: () => false });
  const controlPlaneReachable = listening.find((endpoint) => endpoint.id === 'controlPlane')?.reachable;
  const endpoints: CliServiceEndpointPosture[] = [
    ...listening,
    ...(web === undefined ? [] : [options.probe && web.enabled && controlPlaneReachable !== undefined ? { ...web, reachable: controlPlaneReachable } : web]),
  ];

  const config = {
    enabled: runtime.configManager.get('service.enabled') === true,
    autostart: runtime.configManager.get('service.autostart') === true,
    restartOnFailure: runtime.configManager.get('service.restartOnFailure') === true,
    daemonEnabled: resolveDaemonEnabled(runtime.configManager),
  };
  const serverBackedEnabled = config.daemonEnabled || endpoints.some((endpoint) => endpoint.enabled);
  // A manager that could not be asked says nothing about the service, so the
  // rules that read its answer wait for one.
  const findings: CliServiceIssue[] = status.actionError ? [] : serviceSettingsIssues({
    ...config, autostart: status.autostart, serverBackedEnabled, installed: status.installed, running: status.running,
    serviceName: status.serviceName,
  });
  if (status.actionError && config.enabled) {
    findings.push({
      id: 'service-manager-error',
      summary: `The ${status.platform} service manager could not be asked about the daemon service (${status.actionError}).`,
      cause: 'The user service manager (systemd --user or launchd) did not answer from this session.',
      impact: 'Nothing can be said about the daemon service from here; the daemon itself may be running.',
      action: 'Run goodvibes doctor from a logged-in desktop or SSH session with a user manager. To keep this machine without a service: goodvibes-daemon config set service.enabled false',
    });
  }
  findings.push(...serviceEndpointFindings(endpoints, options.probe));
  const log = await readServiceLogPosture(status.logPath, options.logTailBytes ?? 4096, { ...options, assertCurrent });
  if (log.readError) {
    findings.push(serviceLogUnreadableFinding(log.readError));
  }

  assertCurrent();
  return {
    config,
    managed: {
      ...status,
      pidPath: pidFilePath(status.platform),
      lastError: status.actionError ?? null,
    },
    endpoints,
    log,
    issues: findings.map((finding) => finding.summary),
    findings,
  };
}

export interface CliServiceReadiness {
  readonly running: boolean;
  /** Enabled listening endpoints that did not accept a TCP connection. */
  readonly unreachable: readonly CliServiceEndpointPosture[];
}

/**
 * Whether the service is up: the platform's running state and one TCP connect
 * per enabled listening endpoint. It reads no log and asks no model, so a
 * caller waiting for a just-started daemon can repeat it cheaply.
 */
export async function probeServiceReadiness(runtime: CliServiceRuntime, manager: CliServiceStatusManager): Promise<CliServiceReadiness> {
  const status = reconcileSystemdServiceStatus(runtime, manager.status(), {});
  if (!status.running) return { running: false, unreachable: [] };
  const endpoints = await readServiceEndpoints(runtime, LISTENING_ENDPOINTS, { probe: true, assertCurrent: () => {}, probeTcp, mayProbe: () => true });
  return { running: true, unreachable: endpoints.filter((endpoint) => endpoint.enabled && endpoint.reachable === false) };
}

const yesNo = (value: unknown): string => (value === true ? 'yes' : 'no');

export function formatCliServicePosture(posture: CliServicePosture, json = false): string {
  if (json) return JSON.stringify(posture, null, 2);
  return [
    'GoodVibes service',
    `  enabled: ${yesNo(posture.config.enabled)}`,
    `  autostart: ${yesNo(posture.config.autostart)}`,
    `  restartOnFailure: ${yesNo(posture.config.restartOnFailure)}`,
    `  daemon flag: ${yesNo(posture.config.daemonEnabled)}`,
    '',
    'Managed service:',
    `  platform: ${posture.managed.platform}`,
    `  installed: ${yesNo(posture.managed.installed)}`,
    `  running: ${yesNo(posture.managed.running)}`,
    `  pid: ${posture.managed.pid ?? 'n/a'}`,
    `  definition: ${posture.managed.path}`,
    `  pid file: ${posture.managed.pidPath}`,
    `  log: ${posture.log.path ?? 'n/a'} (${posture.log.exists ? 'present' : 'missing'})`,
    ...(posture.log.readError ? [`  log read error: ${posture.log.readError}`] : []),
    `  command: ${posture.managed.commandPreview}`,
    '',
    'Endpoints:',
    ...posture.endpoints.map(
      (endpoint) =>
        `  ${endpoint.label}: enabled=${yesNo(endpoint.enabled)}${endpoint.servesOtherMachines === undefined ? '' : ` servesOtherMachines=${yesNo(endpoint.servesOtherMachines)}`} ${formatRuntimeEndpointBinding(endpoint.binding)} posture=${endpoint.binding.recognized ? endpoint.bindPosture.label : 'unknown'}${endpoint.reachable === undefined ? '' : ` reachable=${yesNo(endpoint.reachable)}`}`,
    ),
    '',
    posture.findings.length === 0 ? 'Readiness: ready' : 'Readiness: needs attention',
    // Each finding with its one remedy, the same words doctor prints.
    ...posture.findings.flatMap((finding) => [`  - ${finding.summary}`, `    Fix: ${finding.action}`]),
  ].join('\n');
}
