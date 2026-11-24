import {
  readServiceLogPosture,
  retainServicePostureInput,
  readServiceEndpoints,
  serviceEndpointFindings,
  serviceLogUnreadableFinding,
  type ServiceFinding,
  type CliServiceRuntime,
  type CliServiceEndpointPosture,
  type CliServiceLogPosture,
} from '@goodvibes/engine/terminal-shell/service-posture';
export type {
  CliServiceRuntime,
  CliServiceEndpointPosture,
  CliServiceLogPosture,
} from '@goodvibes/engine/terminal-shell/service-posture';
import { yesNo } from '@goodvibes/engine/terminal-shell/cli-output';
import { isExecutable } from '@goodvibes/engine/terminal-shell/cli-environment';
import { probeTcp as probe } from '@goodvibes/engine/terminal-shell/service-io';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { resolveServiceUnitHome } from '@goodvibes/engine/platform/platform/daemon/daemon-service-default';
import { readDaemonSetting } from '@goodvibes/engine/platform/platform/workspace/daemon-home';
import { resolveServiceName, serviceStateDirectory } from '@goodvibes/engine/platform/platform/daemon/service-manager';
import type { PlatformServiceManager } from '@goodvibes/engine/platform/platform/daemon';
import { buildManagedDaemonServiceManager, MANAGED_SERVICE_NAME } from '@goodvibes/engine/terminal-shell/managed-daemon-service';
import type { ManagedServiceStatus } from '@goodvibes/engine/platform/platform/daemon';
import { resolveDaemonEnabled } from '@goodvibes/engine/platform/platform/config';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { formatRuntimeEndpointBinding } from '@goodvibes/engine/terminal-shell/cli-endpoints';
import type { RuntimeEndpointId } from '@goodvibes/engine/terminal-shell';
import { redactText } from '@goodvibes/engine/terminal-shell/cli-redaction';
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import { captureStrictJudgmentJson } from '@goodvibes/engine/platform/platform/gate';

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

/** One service finding with its cause, impact and one remedy (terminal-shell/service-posture.ts). */
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

const SOURCE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The packaged root of this install (the directory that owns `vendor/`,
 * `dist/`, and `bin/`), resolved the same way the daemon executable search
 * resolves its package paths. Exposed so the install self-check can look for
 * the vendored release binaries without re-deriving this path.
 */
export function getGoodVibesPackageRoot(): string {
  return SOURCE_PACKAGE_ROOT;
}

export interface DaemonExecutableResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly execPath?: string;
  readonly packageRoot?: string;
}

export interface DaemonExecutableResolution {
  readonly command: string;
  readonly source: 'env' | 'sibling' | 'package' | 'path' | 'fallback';
  readonly absolute: boolean;
}

interface CliServiceStatusCommandResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface CliServiceStatusManager {
  status(): ManagedServiceStatus;
}

interface CliServicePostureOptions extends JudgmentReadingOptions {
  readonly probe?: boolean;
  readonly logTailBytes?: number;
  readonly manager?: CliServiceStatusManager;
  readonly runCommand?: (command: string, args: readonly string[]) => CliServiceStatusCommandResult;
}

function connectHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host || '127.0.0.1';
}

function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return probe(host, port, timeoutMs, connectHostForBindHost);
}

function platformDaemonArtifactName(platform = process.platform, arch = process.arch): string {
  if (platform === 'linux' && arch === 'x64') return 'goodvibes-daemon-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'goodvibes-daemon-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'goodvibes-daemon-macos-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'goodvibes-daemon-macos-arm64';
  if (platform === 'win32') return 'goodvibes-daemon-windows.exe';
  return 'goodvibes-daemon';
}

function executablePathCandidates(path: string): string[] {
  if (!path.trim() || !isAbsolute(path)) return [];
  const dir = dirname(path);
  const name = basename(path);
  const artifact = platformDaemonArtifactName();
  const candidates = [join(dir, 'goodvibes-daemon'), join(dir, artifact)];
  if (name.startsWith('goodvibes-') && !name.startsWith('goodvibes-daemon-')) {
    candidates.push(join(dir, name.replace(/^goodvibes-/, 'goodvibes-daemon-')));
  }
  if (name === 'goodvibes') candidates.push(join(dir, 'goodvibes-daemon'));
  return [...new Set(candidates)];
}

function resolveCommandFromPath(command: string, pathValue: string | undefined): string | null {
  const pathEntries = (pathValue ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(entry, `${command}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function firstExecutable(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (isExecutable(path)) return path;
  }
  return null;
}

function packageArtifactForBinWrapper(path: string): string | null {
  let realPath = path;
  try {
    realPath = realpathSync(path);
  } catch {
    // Keep the original path if resolving a symlink fails.
  }
  if (basename(realPath) !== 'goodvibes-daemon') return null;
  const binDir = dirname(realPath);
  if (basename(binDir) !== 'bin') return null;
  const packageRoot = dirname(binDir);
  return firstExecutable([
    join(packageRoot, 'vendor', platformDaemonArtifactName()),
    join(packageRoot, 'dist', platformDaemonArtifactName()),
    join(packageRoot, 'dist', 'goodvibes-daemon'),
  ]);
}

export function resolveGoodVibesDaemonExecutable(options: DaemonExecutableResolutionOptions = {}): DaemonExecutableResolution {
  const env = options.env ?? process.env;
  const override = env.GOODVIBES_DAEMON_COMMAND?.trim();
  if (override) {
    return { command: override, source: 'env', absolute: isAbsolute(override) };
  }

  const packageRoot = options.packageRoot ?? SOURCE_PACKAGE_ROOT;
  const packaged = firstExecutable([
    join(packageRoot, 'dist', platformDaemonArtifactName()),
    join(packageRoot, 'dist', 'goodvibes-daemon'),
    join(packageRoot, 'vendor', platformDaemonArtifactName()),
    join(packageRoot, 'bin', 'goodvibes-daemon'),
  ]);
  if (packaged) return { command: packaged, source: 'package', absolute: true };

  const argv = options.argv ?? process.argv;
  const execPath = options.execPath ?? process.execPath;
  const sibling = firstExecutable([...executablePathCandidates(execPath), ...executablePathCandidates(argv[1] ?? '')]);
  if (sibling) {
    return {
      command: packageArtifactForBinWrapper(sibling) ?? sibling,
      source: 'sibling',
      absolute: true,
    };
  }

  const pathResolved = resolveCommandFromPath('goodvibes-daemon', env.PATH);
  if (pathResolved) {
    return {
      command: packageArtifactForBinWrapper(pathResolved) ?? pathResolved,
      source: 'path',
      absolute: true,
    };
  }

  return { command: 'goodvibes-daemon', source: 'fallback', absolute: false };
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
 * The daemon's service manager for the terminal app's `service` commands: the
 * one definition the daemon CLI also installs
 * (terminal-shell/managed-daemon-service.ts), under the platform's one unit name,
 * so `service status` reports the unit the installer or the daemon wrote, and
 * `service install` never adds a second unit for the same port.
 */
export function createPlatformServiceManager(
  runtime: CliServiceRuntime,
  workingDirectory: string = resolveDaemonWorkingDirectory(runtime),
): PlatformServiceManager {
  return buildManagedDaemonServiceManager({
    binaryPath: resolveGoodVibesDaemonExecutable().command,
    homeDir: runtime.homeDirectory,
    // The unit and its pid file go under the login home, as the daemon's own
    // service manager reads them, whatever tree home this app runs on.
    unitHomeDir: resolveServiceUnitHome(),
    daemonHomeDirectory: getServiceStateRoot(runtime),
    workingDirectory,
    configManager: runtime.configManager,
  });
}

/**
 * The daemon's own working directory, resolved as `goodvibes-daemon` resolves
 * it (the variable, then its saved setting), so a definition written from
 * here is the one the daemon's install-service writes. The home stands in
 * for the daemon's start directory, which is the home when an installer runs it.
 * Throws, naming the file, when the daemon's saved settings exist and cannot be
 * read: the daemon refuses to start on that file, and a definition written
 * with another directory would hide why.
 */
function resolveDaemonWorkingDirectory(runtime: CliServiceRuntime): string {
  return (process.env.GOODVIBES_WORKING_DIR?.trim() ? resolve(process.env.GOODVIBES_WORKING_DIR.trim()) : undefined)
    || readDaemonSetting(getServiceStateRoot(runtime), 'runtime.workingDir')
    || runtime.homeDirectory;
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
  // An unreadable daemon settings file is shown as such; the service's status
  // is still read, since asking the service manager does not use the directory.
  let unreadableWorkingDirectory: string | undefined;
  let workingDirectory: string;
  try {
    workingDirectory = resolveDaemonWorkingDirectory(runtime);
  } catch (error) {
    unreadableWorkingDirectory = error instanceof Error ? error.message : String(error);
    workingDirectory = runtime.homeDirectory;
  }
  const manager = options.manager ?? createPlatformServiceManager(runtime, workingDirectory);
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
  if (unreadableWorkingDirectory !== undefined) {
    findings.push({
      id: 'daemon-working-directory-unreadable',
      summary: `The daemon's working directory is unreadable: ${unreadableWorkingDirectory}.`,
      cause: 'The daemon\'s saved settings file exists but could not be read or parsed.',
      impact: 'The daemon refuses to start until the file is fixed or removed, or it is started with --working-dir.',
      action: 'Fix or remove the file named above, or start the daemon with --working-dir.',
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
