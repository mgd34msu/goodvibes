import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { processStartTime } from '../config/process-start-time.js';
import { ConfigManager } from '../config/manager.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';
import { SERVICE_MANAGEMENT_FEATURE_FLAG } from '../runtime/feature-flags/flags.js';
import { currentProcessSignals, resolveDaemonExecInvocation } from './daemon-exec-invocation.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';

export type ManagedServicePlatform = 'systemd' | 'launchd' | 'windows' | 'manual';

export interface ManagedServiceDefinition {
  readonly name: string;
  readonly description: string;
  readonly workingDirectory: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly restartOnFailure: boolean;
}

export interface ManagedServiceStatus {
  readonly platform: ManagedServicePlatform;
  /** The resolved service name (`service.serviceName` config, else the built-in default), so a CLI/consumer never has to hardcode it. */
  readonly serviceName: string;
  readonly path: string;
  readonly installed: boolean;
  readonly autostart: boolean;
  readonly running: boolean;
  readonly pid?: number | undefined;
  readonly logPath?: string | undefined;
  readonly commandPreview: string;
  readonly contents?: string | undefined;
  readonly suggestedCommands: readonly string[];
  readonly lastAction?: 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status' | undefined;
  readonly actionError?: string | undefined;
  /**
   * The manager accepted an action that ends the daemon giving this answer
   * (a stop, restart or uninstall of its own service) and carries it out after
   * the answer: what happens next, in one sentence. The rest of the record is
   * the state the action was asked from.
   */
  readonly accepted?: string | undefined;
  /**
   * One honest line about login lingering after an install on systemd:
   * verified-on means the daemon starts at boot; anything else names the
   * exact command the user can run once themselves.
   */
  readonly lingerNote?: string | undefined;
}

export interface ManagedServiceActionResult {
  readonly status: number | null;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

interface ManagedServicePaths {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

/** Process-level seams of the manual platform, injectable so pid reuse and slow exits are testable. */
export interface ManagedServiceProcessControl {
  readonly isRunning?: ((pid: number) => boolean) | undefined;
  readonly startTime?: ((pid: number) => string | null) | undefined;
  readonly signal?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly pause?: ((milliseconds: number) => void) | undefined;
  readonly spawn?: ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess) | undefined;
}

/** How long a manual restart waits for the previous process to exit before refusing to start a second one. */
const MANUAL_STOP_WAIT_MS = 10_000;
const MANUAL_STOP_POLL_MS = 100;
/** How long a service-manager command may take before it is reported as not answering (a broken user bus). */
const SERVICE_QUERY_TIMEOUT_MS = 10_000;

/** One step a service flow hands its driver: a command to run and read, a command to issue and leave, or a wait. */
type ServiceStep =
  | { readonly run: readonly string[] }
  | { readonly detach: readonly string[] }
  | { readonly pause: number };
type ServiceFlow<T> = Generator<ServiceStep, T, ManagedServiceActionResult>;
const DONE: ManagedServiceActionResult = Object.freeze({ status: 0 });

/** What a failed command said, for the person reading the action's result. */
function commandFailureText(result: ManagedServiceActionResult): string {
  return ((result.stderr ?? '') || (result.stdout ?? '') || `command exited with ${result.status}`).trim();
}

/** The launchd domain of this user's agents (`gui/<uid>`). */
function launchdUid(): string {
  return String(process.getuid?.() ?? '');
}

export interface ManagedServiceManagerOptions extends ManagedServicePaths {
  readonly processControl?: ManagedServiceProcessControl | undefined;
  readonly definitionOverride?: ManagedServiceDefinition | undefined;
  readonly actionRunner?: ((command: string, args: readonly string[]) => ManagedServiceActionResult) | undefined;
  /** A retained caller restriction checked before native publication and platform actions. */
  readonly assertCurrent?: (() => void) | undefined;
  readonly binaryBaseName?: string | undefined;
  readonly defaultServiceName?: string | undefined;
  readonly defaultServiceDescription?: string | undefined;
  readonly featureFlags?: FeatureFlagReader | undefined;
}

/**
 * The directory under a home where the managed service keeps its own state:
 * the pid file the manual platform finds, stops and restarts it by, the default
 * log, and the manual and Windows definitions. One value for every process
 * that manages the service (the daemon, the terminals, autostart).
 */
export const SERVICE_STATE_ROOT = 'daemon';

/**
 * The service's state directory: under the home its unit is registered from
 * (the manager's `homeDirectory`), never a process's working directory, so
 * the terminal that started the service and the daemon that runs it read the
 * same pid file and report the same log.
 */
export function serviceStateDirectory(homeDirectory: string): string {
  return join(resolve(homeDirectory), '.goodvibes', SERVICE_STATE_ROOT, 'service');
}

/** Where earlier versions kept the same files: under the working directory, in one of three roots. */
function legacyServiceStateDirectories(workingDirectory: string): string[] {
  return [
    join(workingDirectory, '.goodvibes', 'goodvibes', 'service'),
    join(workingDirectory, '.goodvibes', 'daemon', 'service'),
    join(workingDirectory, '.goodvibes', 'service'),
  ];
}

/** Resolves the configured `service.platform` (default `auto`) against the host operating system. */
export function detectPlatform(platform: string, hostPlatform: string = process.platform): ManagedServicePlatform {
  switch (platform) {
    case 'systemd':
    case 'launchd':
    case 'windows':
    case 'manual':
      return platform;
    case 'auto':
    default:
      if (hostPlatform === 'darwin') return 'launchd';
      if (hostPlatform === 'win32') return 'windows';
      if (hostPlatform === 'linux') return 'systemd';
      return 'manual';
  }
}

function buildDefaultDefinition(
  configManager: ConfigManager,
  workingDirectory: string,
  options: Pick<ManagedServiceManagerOptions, 'binaryBaseName' | 'defaultServiceName' | 'defaultServiceDescription'>,
): ManagedServiceDefinition {
  const serviceName = resolveServiceName(configManager, options.defaultServiceName);
  // ExecStart is derived from how THIS process was actually started, a compiled
  // binary launches itself with its real argv; only a source/dev run yields the
  // `run <cli.ts>` shape (and that path is never self-promoted, see
  // facade-lifecycle.promoteToServiceAtBoot). This replaces a dist/-existence
  // heuristic that wrote a dev command line for a compiled binary running
  // elsewhere.
  const invocation = resolveDaemonExecInvocation(currentProcessSignals(), workingDirectory);
  return {
    name: serviceName,
    description: options.defaultServiceDescription?.trim() || `${serviceName} daemon host`,
    workingDirectory,
    command: invocation.command,
    args: invocation.args,
    env: {
      GOODVIBES_DAEMON_TOKEN: process.env.GOODVIBES_DAEMON_TOKEN ?? '',
      GOODVIBES_HTTP_TOKEN: process.env.GOODVIBES_HTTP_TOKEN ?? '',
      NODE_ENV: process.env.NODE_ENV ?? 'production',
    },
    restartOnFailure: Boolean(configManager.get('service.restartOnFailure')),
  };
}

function resolveServiceName(configManager: ConfigManager, defaultServiceName?: string): string {
  const fallback = defaultServiceName ?? 'daemon';
  // A consumer's platform default may replace the shared schema default, while
  // every persisted choice and invocation overlay remains the owner's choice.
  // Minimal embedded config readers without provenance retain prior behavior.
  if (defaultServiceName !== undefined && typeof configManager.describeConfigKeySource === 'function') {
    const source = configManager.describeConfigKeySource('service.serviceName');
    if (source.tier === 'default' && (source.effectiveOrigin === undefined || source.effectiveOrigin === 'default')) return fallback;
  }
  return String(configManager.get('service.serviceName') ?? fallback).trim() || fallback;
}

function resolveLogPath(
  configManager: ConfigManager,
  platform: ManagedServicePlatform,
  workingDirectory: string,
  stateDirectory: string,
): string {
  const configured = String(configManager.get('service.logPath') ?? '').trim();
  if (configured) return resolve(workingDirectory, configured);
  return join(stateDirectory, `${platform}.log`);
}

/**
 * Escalating restart delays (RestartSteps=/RestartMaxDelaySec=) landed in
 * systemd 254. On older systemd, or when the version cannot be read, the
 * unit degrades to the flat RestartSec retry, which StartLimitIntervalSec=0
 * already keeps retrying forever instead of tombstoning.
 */
export function systemdSupportsRestartSteps(majorVersion: number | null): boolean {
  return majorVersion !== null && majorVersion >= 254;
}

/**
 * The restart policy a restartOnFailure unit is rendered with, stated once so
 * anything that waits on the unit (the service migration) derives its deadline
 * from the same numbers systemd was given.
 */
export const MANAGED_UNIT_RESTART_POLICY = { restartSec: 2, restartSteps: 8, restartMaxDelaySec: 300 } as const;

/**
 * How long to wait for a just-started unit to answer: the daemon's own boot
 * allowance, plus one full restart delay so a first process that failed for a
 * transient reason gets its restart inside the window.
 */
export function managedUnitStartDeadlineMs(bootAllowanceMs = 10_000): number {
  return bootAllowanceMs + MANAGED_UNIT_RESTART_POLICY.restartSec * 1000;
}

/** First line of `systemctl --version` is "systemd NNN (...)"; returns NNN or null. */
export function parseSystemdMajorVersion(versionOutput: string | undefined): number | null {
  const firstLine = (versionOutput ?? '').split('\n')[0] ?? '';
  const match = firstLine.match(/^systemd (\d+)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** WorkingDirectory and Description expand specifiers but do not unquote C escapes. */
function systemdScalar(value: string, field: string): string {
  if (/[\x00-\x1f\x7f]/.test(value) || /^[ \t]|[ \t]$/.test(value) || value.endsWith('\\')) {
    throw new Error(`The systemd ${field} cannot preserve this value.`);
  }
  return value.replaceAll('%', '%%');
}

/** ExecStart words and complete Environment assignments accept systemd C quoting. */
function systemdWord(value: string, expandEnvironment = false): string {
  if (value.includes('\0')) throw new Error('Systemd service values cannot contain NUL.');
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  const escaped = value.replace(/[\\"\x01-\x1f\x7f%$]/g, (character) => {
    if (character === '\\') return '\\\\';
    if (character === '"') return '\\"';
    if (character === '%') return '%%';
    if (character === '$') return expandEnvironment ? '$$' : '$';
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
  return `"${escaped}"`;
}

/**
 * Survival contract for a restartOnFailure unit: StartLimitIntervalSec=0
 * disables the start-rate limiter, so a crashing daemon keeps retrying
 * (spaced by the delays below) instead of landing in the permanent
 * "start-limit-hit" failed state that only a manual reset-failed clears. On
 * systemd 254+ the retry delay escalates from RestartSec up to
 * RestartMaxDelaySec across RestartSteps attempts; on older systemd those
 * two directives are omitted (they would be ignored with a warning) and the
 * flat RestartSec applies to every retry.
 */
export function renderSystemdUnit(
  definition: ManagedServiceDefinition,
  systemdMajorVersion: number | null = null,
): string {
  if (!definition.command || /^[-@:+!|;]/.test(definition.command) || /[\x00-\x1f\x7f]/.test(definition.command)) {
    throw new Error('The systemd executable must be a literal executable name or path.');
  }
  // The executable path itself does not expand $, but argv[0] does. Disable
  // argv expansion when it contains $, preserving the literal path in both.
  const literalExecutable = definition.command.includes('$');
  const envLines = Object.entries(definition.env)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid systemd environment variable name.');
      return `Environment=${systemdWord(`${key}=${value}`)}`;
    });
  const restartLines = definition.restartOnFailure
    ? [
        'Restart=on-failure',
        `RestartSec=${MANAGED_UNIT_RESTART_POLICY.restartSec}`,
        ...(systemdSupportsRestartSteps(systemdMajorVersion)
          ? [`RestartSteps=${MANAGED_UNIT_RESTART_POLICY.restartSteps}`, `RestartMaxDelaySec=${MANAGED_UNIT_RESTART_POLICY.restartMaxDelaySec}`]
          : []),
      ]
    : ['Restart=no'];
  return [
    '[Unit]',
    `Description=${systemdScalar(definition.description, 'Description')}`,
    'After=network-online.target',
    ...(definition.restartOnFailure ? ['StartLimitIntervalSec=0'] : []),
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${systemdScalar(definition.workingDirectory, 'WorkingDirectory')}`,
    `ExecStart=${literalExecutable ? ':' : ''}${[systemdWord(definition.command), ...definition.args.map((argument) => systemdWord(argument, !literalExecutable))].join(' ')}`,
    ...envLines,
    ...restartLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * Stable provenance marker written into every product-generated launchd plist.
 * launchd has no Description field (unlike a systemd unit), so the definition's
 * description was previously dropped entirely, a product-written plist was not
 * provenance-identifiable. This additive custom key carries the writer identity
 * plus the description; launchd ignores keys it does not know. The prefix is
 * STABLE (pinned by a render test) so tooling can match product-written plists.
 */
const LAUNCHD_MANAGED_BY_PREFIX = 'goodvibes daemon service manager';

function xmlText(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function renderLaunchdPlist(definition: ManagedServiceDefinition): string {
  const envLines = Object.entries(definition.env)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `    <key>${xmlText(key)}</key>\n    <string>${xmlText(value)}</string>`)
    .join('\n');
  const args = [definition.command, ...definition.args]
    .map((value) => `    <string>${xmlText(value)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlText(definition.name)}</string>`,
    '  <key>GoodVibesManagedBy</key>',
    `  <string>${xmlText(`${LAUNCHD_MANAGED_BY_PREFIX}, ${definition.description}`)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlText(definition.workingDirectory)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    definition.restartOnFailure ? '  <true/>' : '  <false/>',
    ...(envLines ? ['  <key>EnvironmentVariables</key>', '  <dict>', envLines, '  </dict>'] : []),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function renderWindowsCommand(definition: ManagedServiceDefinition): string {
  const taskName = definition.name;
  const commandLine = [definition.command, ...definition.args].join(' ');
  return `schtasks /Create /SC ONLOGON /TN "${taskName}" /TR "${commandLine}" /F`;
}

function windowsCreateArgs(definition: ManagedServiceDefinition): string[] {
  const commandLine = [definition.command, ...definition.args].join(' ');
  return ['/Create', '/SC', 'ONLOGON', '/TN', definition.name, '/TR', commandLine, '/F'];
}

/**
 * The definition file carries the daemon's tokens, so status output shows the
 * variable names but never their values.
 */
function redactDefinitionSecrets(contents: string): string {
  let inLaunchdEnvironment = false;
  let pendingLaunchdKey = false;
  return contents.split('\n').map((line) => {
    if (/^\s*Environment="?[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
      return line.replace(/^(\s*Environment="?[A-Za-z_][A-Za-z0-9_]*=).*$/, '$1<redacted>');
    }
    if (/<key>EnvironmentVariables<\/key>/.test(line)) { inLaunchdEnvironment = true; return line; }
    if (inLaunchdEnvironment && /<\/dict>/.test(line)) { inLaunchdEnvironment = false; return line; }
    if (inLaunchdEnvironment && /<key>.*<\/key>/.test(line)) { pendingLaunchdKey = true; return line; }
    if (inLaunchdEnvironment && pendingLaunchdKey && /<string>.*<\/string>/.test(line)) {
      pendingLaunchdKey = false;
      return line.replace(/<string>.*<\/string>/, '<string>&lt;redacted&gt;</string>');
    }
    return line;
  }).join('\n');
}

function definitionPath(
  platform: ManagedServicePlatform,
  serviceName: string,
  paths: ManagedServicePaths,
): string {
  switch (platform) {
    case 'systemd':
      return join(paths.homeDirectory, '.config', 'systemd', 'user', `${serviceName}.service`);
    case 'launchd':
      return join(paths.homeDirectory, 'Library', 'LaunchAgents', `${serviceName}.plist`);
    case 'windows':
      return join(serviceStateDirectory(paths.homeDirectory), 'windows-task.txt');
    case 'manual':
    default:
      return join(serviceStateDirectory(paths.homeDirectory), 'manual-service.txt');
  }
}

function pidFilePath(platform: ManagedServicePlatform, stateDirectory: string): string {
  return join(stateDirectory, `${platform}.pid`);
}

function suggestedCommands(platform: ManagedServicePlatform, path: string, serviceName: string): string[] {
  switch (platform) {
    case 'systemd':
      return [
        `systemctl --user daemon-reload`,
        `systemctl --user enable --now ${serviceName}.service`,
        `systemctl --user status ${serviceName}.service`,
      ];
    case 'launchd':
      return [
        `launchctl unload ${path} || true`,
        `launchctl load ${path}`,
        `launchctl list | grep ${serviceName}`,
      ];
    case 'windows':
      return [
        `schtasks /Run /TN "${serviceName}"`,
        `schtasks /Query /TN "${serviceName}"`,
        `schtasks /Delete /TN "${serviceName}" /F`,
      ];
    case 'manual':
    default:
      return [
        `bun run src/daemon/cli.ts`,
      ];
  }
}

export class PlatformServiceManager {
  private readonly configManager: ConfigManager;
  private readonly workingDirectory: string;
  private readonly homeDirectory: string;
  private readonly definitionOverride?: ManagedServiceDefinition | undefined;
  private readonly actionRunner?: ((command: string, args: readonly string[]) => ManagedServiceActionResult) | undefined;
  private readonly currentRestriction?: (() => void) | undefined;
  /** {@link serviceStateDirectory} of this manager's home. */
  private readonly stateDirectory: string;
  /** Records left in a legacy location are moved once per manager. */
  private legacyStateAdopted = false;
  private readonly binaryBaseName?: string | undefined;
  private readonly defaultServiceName?: string | undefined;
  private readonly defaultServiceDescription?: string | undefined;
  private readonly featureFlags: FeatureFlagReader;
  private readonly processControl: ManagedServiceProcessControl;

  constructor(configManager: ConfigManager, options: ManagedServiceManagerOptions) {
    this.configManager = configManager;
    this.workingDirectory = resolve(options.workingDirectory);
    this.homeDirectory = resolve(options.homeDirectory);
    this.definitionOverride = options.definitionOverride;
    this.actionRunner = options.actionRunner;
    this.currentRestriction = options.assertCurrent;
    this.stateDirectory = serviceStateDirectory(this.homeDirectory);
    this.binaryBaseName = options.binaryBaseName;
    this.defaultServiceName = options.defaultServiceName;
    this.defaultServiceDescription = options.defaultServiceDescription;
    this.featureFlags = options.featureFlags ?? null;
    this.processControl = options.processControl ?? {};
  }

  private assertCurrent(): void {
    assertSynchronousJudgmentGuard(() => this.currentRestriction?.(), () => new Error('Service current restriction must complete synchronously without returning a value'));
  }

  private isEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, SERVICE_MANAGEMENT_FEATURE_FLAG);
  }

  private requireEnabled(operation: string): void {
    requireFeatureGate(this.featureFlags, SERVICE_MANAGEMENT_FEATURE_FLAG, operation);
  }

  private getPaths(): ManagedServicePaths {
    return {
      workingDirectory: this.workingDirectory,
      homeDirectory: this.homeDirectory,
    };
  }

  /** {@link getPaths}, after any record a legacy location still holds was moved to the state directory. */
  private statePaths(): ManagedServicePaths {
    this.adoptLegacyState();
    return this.getPaths();
  }

  /** The pid file of `platform`, after any legacy record was moved into place. */
  private pidPath(platform: ManagedServicePlatform): string {
    this.adoptLegacyState();
    return pidFilePath(platform, this.stateDirectory);
  }

  /**
   * Earlier versions kept the pid file and the manual/Windows definitions
   * under the working directory, in a root that depended on which process
   * built the manager. The first read of a path moves each such file into
   * the one state directory when nothing is there yet: a few existence checks
   * once per manager, nothing after.
   */
  private adoptLegacyState(): void {
    if (this.legacyStateAdopted) return;
    this.legacyStateAdopted = true;
    const names = ['systemd.pid', 'launchd.pid', 'windows.pid', 'manual.pid', 'manual-service.txt', 'windows-task.txt'];
    for (const legacy of legacyServiceStateDirectories(this.workingDirectory)) {
      if (legacy === this.stateDirectory) continue;
      for (const name of names) {
        const from = join(legacy, name);
        const to = join(this.stateDirectory, name);
        if (!existsSync(from) || existsSync(to)) continue;
        try {
          this.assertCurrent();
          mkdirSync(this.stateDirectory, { recursive: true });
          renameSync(from, to);
        } catch {
          // Left where it is; the next manager tries again.
        }
      }
    }
  }

  /** Read-only identity check; an installed definition grants no authority for another selected host. */
  installedDefinitionMatches(): boolean {
    this.assertCurrent();
    if (!this.isEnabled()) return false;
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    const path = definitionPath(platform, serviceName, this.statePaths());
    try {
      const actual = readFileSync(path, 'utf-8');
      const definition = this.resolveDefinition();
      const candidates = platform === 'systemd'
        ? [renderSystemdUnit(definition), renderSystemdUnit(definition, 254)]
        : [platform === 'launchd' ? renderLaunchdPlist(definition)
          : platform === 'windows' ? renderWindowsCommand(definition)
            : [definition.command, ...definition.args].join(' ')];
      return candidates.some((contents) => actual === `${contents}\n`);
    } catch { return false; }
  }

  /**
   * Every public method below is written once, as a flow of service-manager
   * commands, and run by one of two drivers: the synchronous one for the
   * terminal apps and the daemon CLI (a separate process, which may wait), and
   * the asynchronous one for the daemon's own routes, where a waiting command
   * would freeze every session the daemon serves.
   */
  status(): ManagedServiceStatus {
    return this.drive(this.statusFlow());
  }

  install(): ManagedServiceStatus {
    return this.drive(this.installFlow());
  }

  uninstall(): ManagedServiceStatus {
    return this.drive(this.uninstallFlow(false));
  }

  start(): ManagedServiceStatus {
    return this.drive(this.actionFlow('start', false));
  }

  stop(): ManagedServiceStatus {
    return this.drive(this.actionFlow('stop', false));
  }

  restart(): ManagedServiceStatus {
    return this.drive(this.actionFlow('restart', false));
  }

  /** `status()` without blocking the caller's thread: the daemon's service read. */
  statusAsync(): Promise<ManagedServiceStatus> {
    return this.driveAsync(this.statusFlow());
  }

  /**
   * A service action asked of the daemon the service may be running. Nothing
   * waits: every command runs asynchronously. A stop, restart or uninstall
   * that ends this daemon is issued without waiting for the stop (systemd
   * `--no-block`; launchd through launchd itself, `kickstart -k` or
   * `bootout`, so no second step depends on this process surviving the
   * first) and answered with `accepted`, which says what happens next.
   */
  requestFromDaemon(action: 'install' | 'start' | 'stop' | 'restart' | 'uninstall'): Promise<ManagedServiceStatus> {
    switch (action) {
      case 'install': return this.driveAsync(this.installFlow());
      case 'uninstall': return this.driveAsync(this.uninstallFlow(true));
      default: return this.driveAsync(this.actionFlow(action, true));
    }
  }

  private *statusFlow(): ServiceFlow<ManagedServiceStatus> {
    this.assertCurrent();
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    const path = definitionPath(platform, serviceName, this.statePaths());
    if (!this.isEnabled()) {
      const definition = this.resolveDefinition();
      return {
        platform,
        serviceName,
        path,
        installed: false,
        autostart: false,
        running: false,
        logPath: resolveLogPath(this.configManager, platform, this.workingDirectory, this.stateDirectory),
        commandPreview: [definition.command, ...definition.args].join(' '),
        suggestedCommands: [],
        lastAction: 'status',
        actionError: 'service management is turned off (see the service.enabled setting)',
      };
    }
    const installed = existsSync(path);
    const { running, pid, unreachable } = yield* this.runningFlow(platform, serviceName);
    const definition = this.resolveDefinition();
    return {
      platform,
      serviceName,
      path,
      installed,
      autostart: Boolean(this.configManager.get('service.autostart')),
      running,
      ...(pid !== undefined && running ? { pid } : {}),
      logPath: resolveLogPath(this.configManager, platform, this.workingDirectory, this.stateDirectory),
      commandPreview: installed ? path : [definition.command, ...definition.args].join(' '),
      contents: installed ? redactDefinitionSecrets(readFileSync(path, 'utf-8')) : undefined,
      suggestedCommands: suggestedCommands(platform, path, serviceName),
      lastAction: 'status',
      ...(unreachable ? { actionError: unreachable } : {}),
    };
  }

  private *installFlow(): ServiceFlow<ManagedServiceStatus> {
    this.assertCurrent();
    this.requireEnabled('install service');
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    const definition = this.resolveDefinition();
    const path = definitionPath(platform, serviceName, this.statePaths());
    const contents = platform === 'systemd'
      ? renderSystemdUnit(definition, yield* this.systemdMajorVersionFlow())
      : platform === 'launchd'
        ? renderLaunchdPlist(definition)
        : platform === 'windows'
          ? renderWindowsCommand(definition)
          : [definition.command, ...definition.args].join(' ');
    this.assertCurrent();
    mkdirSync(dirname(path), { recursive: true });
    this.assertCurrent();
    // The definition embeds the daemon's tokens: owner-only, and tightened
    // again because an older install left it world-readable.
    writeFileSync(path, `${contents}\n`, { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* a platform without POSIX modes */ }
    // Without the reload, systemd keeps acting on the previously loaded unit.
    const registrationError = yield* this.registerInstalledDefinitionFlow(platform, definition);
    const lingerNote = platform === 'systemd' ? yield* this.ensureLingerFlow() : undefined;
    return {
      ...(yield* this.statusFlow()),
      lastAction: 'install',
      ...(registrationError === undefined ? {} : { actionError: registrationError }),
      ...(lingerNote ? { lingerNote } : {}),
    };
  }

  /** Makes the platform pick up a freshly written definition; returns the failure text, or undefined. */
  private *registerInstalledDefinitionFlow(platform: ManagedServicePlatform, definition: ManagedServiceDefinition): ServiceFlow<string | undefined> {
    const argv = platform === 'systemd' ? ['systemctl', '--user', 'daemon-reload']
      : platform === 'windows' ? ['schtasks', ...windowsCreateArgs(definition)]
        : undefined;
    if (argv === undefined) return undefined;
    const result = yield { run: argv };
    if ((result.status ?? 1) === 0) return undefined;
    return `${argv.slice(0, 2).join(' ')} failed: ${commandFailureText(result)}`;
  }

  /** systemd major version, or null when unreadable. */
  private *systemdMajorVersionFlow(): ServiceFlow<number | null> {
    const result = yield { run: ['systemctl', '--version'] };
    if (result.status !== 0) return null;
    return parseSystemdMajorVersion(result.stdout);
  }

  /**
   * A user unit with WantedBy=default.target only starts when its user logs
   * in. Lingering starts the user's systemd instance at boot, so the daemon
   * comes up on a machine nobody has logged into. `loginctl enable-linger`
   * can exit 0 without taking effect in some polkit setups, so the
   * show-user property readback is the source of truth, checked before and
   * after enabling. Returns exactly one honest line either way.
   */
  private *ensureLingerFlow(): ServiceFlow<string> {
    const user = process.env.USER ?? process.env.LOGNAME ?? '';
    if (!user) {
      return 'lingering: could not determine the current user, the daemon starts at login rather than at boot. Enable it once yourself with: loginctl enable-linger <user>';
    }
    const lingerEnabled = (readback: ManagedServiceActionResult): boolean => readback.status === 0 && (readback.stdout ?? '').trim() === 'Linger=yes';
    const readback: readonly string[] = ['loginctl', 'show-user', user, '--property=Linger'];
    if (lingerEnabled(yield { run: readback })) {
      return `lingering: already enabled for ${user}, the daemon starts at boot.`;
    }
    yield { run: ['loginctl', 'enable-linger', user] };
    if (lingerEnabled(yield { run: readback })) {
      return `lingering: enabled for ${user}, the daemon starts at boot.`;
    }
    return `lingering: could not be enabled (polkit may require an interactive session), the daemon starts at login rather than at boot. Enable it once yourself with: loginctl enable-linger ${user}`;
  }

  private *uninstallFlow(fromDaemon: boolean): ServiceFlow<ManagedServiceStatus> {
    this.assertCurrent();
    this.requireEnabled('uninstall service');
    const status = yield* this.statusFlow();
    let actionError: string | undefined;
    let accepted: string | undefined;
    if (existsSync(status.path)) {
      const self = fromDaemon && this.runsThisDaemon(status);
      if (self && status.platform === 'systemd') {
        // Unregister and remove while this process still runs; the stop that ends
        // it is queued last and not waited for.
        const disable = yield { run: ['systemctl', '--user', 'disable', `${status.serviceName}.service`] };
        if ((disable.status ?? 1) !== 0) {
          actionError = `systemctl --user disable failed, so the service was left installed and running: ${commandFailureText(disable)}`;
        } else {
          this.assertCurrent();
          rmSync(status.path, { force: true });
          yield { run: ['systemctl', '--user', 'daemon-reload'] };
          const stop = yield { run: ['systemctl', '--user', '--no-block', 'stop', `${status.serviceName}.service`] };
          if ((stop.status ?? 1) !== 0) actionError = `the service was removed, but systemctl --user stop failed, so this daemon is still running: ${commandFailureText(stop)}`;
          else accepted = 'The service was removed and its stop is queued: this daemon stops after this answer and will not start at login again.';
        }
      } else if (self && status.platform === 'launchd') {
        // launchd ends this process the moment the job is booted out, so the file goes first.
        this.assertCurrent();
        rmSync(status.path, { force: true });
        yield { detach: ['launchctl', 'bootout', `gui/${launchdUid()}/${status.serviceName}`] };
        accepted = 'The service was removed and launchd is unloading it: this daemon stops after this answer and will not start at login again.';
      } else {
        // Stop and unregister while the definition still names the service, so
        // removing the file does not leave a running, autostarting daemon behind.
        // Ending a task that is not running, or unloading a job that is not loaded,
        // exits non-zero without anything being left behind, so those are best effort.
        const teardown: ReadonlyArray<{ readonly argv: readonly string[]; readonly bestEffort?: boolean }> = status.platform === 'systemd'
          ? [{ argv: ['systemctl', '--user', 'disable', '--now', `${status.serviceName}.service`] }]
          : status.platform === 'launchd'
            ? [{ argv: ['launchctl', 'unload', status.path], bestEffort: true }]
            : status.platform === 'windows'
              ? [{ argv: ['schtasks', '/End', '/TN', status.serviceName], bestEffort: true }, { argv: ['schtasks', '/Delete', '/TN', status.serviceName, '/F'] }]
              : [];
        for (const { argv, bestEffort } of teardown) {
          const result = yield { run: argv };
          if ((result.status ?? 1) !== 0 && !bestEffort && actionError === undefined) {
            actionError = `${argv.slice(0, 2).join(' ')} failed, so the service may still be running: ${commandFailureText(result)}`;
          }
        }
        this.assertCurrent();
        rmSync(status.path, { force: true });
        if (status.platform === 'systemd') yield { run: ['systemctl', '--user', 'daemon-reload'] };
      }
    }
    const pidPath = this.pidPath(status.platform);
    if (existsSync(pidPath) && accepted === undefined) {
      this.assertCurrent();
      rmSync(pidPath, { force: true });
    }
    // After a queued stop of this daemon the manager is not asked again: the answer is the state it was asked from.
    const after = accepted === undefined ? yield* this.statusFlow() : { ...status, installed: false, contents: undefined };
    return {
      ...after,
      lastAction: 'uninstall',
      ...(actionError === undefined ? {} : { actionError }),
      ...(accepted === undefined ? {} : { accepted }),
    };
  }

  private *actionFlow(action: 'start' | 'stop' | 'restart', fromDaemon: boolean): ServiceFlow<ManagedServiceStatus> {
    this.assertCurrent();
    this.requireEnabled(`${action} service`);
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    if (platform === 'manual') {
      if (action === 'start') return yield* this.startManualFlow(platform);
      if (action === 'stop') return yield* this.stopManualFlow(platform);
      return yield* this.restartManualFlow(platform);
    }
    return yield* this.platformActionFlow(platform, action, fromDaemon);
  }

  /** Whether the service is this daemon: launchd names its pid; a running systemd unit asked from inside the daemon is taken to be it. */
  private runsThisDaemon(status: ManagedServiceStatus): boolean {
    if (!status.installed || !status.running) return false;
    return status.platform === 'launchd' ? status.pid === process.pid : status.platform === 'systemd';
  }

  /**
   * The unit name this manager installs and controls: the owner's
   * `service.serviceName`, else the default this manager was built with. No
   * service-manager query; the one answer for every caller that needs the name.
   */
  serviceName(): string {
    return this.definitionOverride?.name ?? resolveServiceName(this.configManager, this.defaultServiceName);
  }

  private resolveDefinition(): ManagedServiceDefinition {
    return this.definitionOverride ?? buildDefaultDefinition(this.configManager, this.workingDirectory, {
      binaryBaseName: this.binaryBaseName,
      defaultServiceName: this.defaultServiceName,
      defaultServiceDescription: this.defaultServiceDescription,
    });
  }

  private *startManualFlow(platform: ManagedServicePlatform, action: ManagedServiceStatus['lastAction'] = 'start'): ServiceFlow<ManagedServiceStatus> {
    const current = yield* this.statusFlow();
    if (current.running) {
      return {
        ...current,
        lastAction: action,
      };
    }
    const definition = this.resolveDefinition();
    const logPath = resolveLogPath(this.configManager, platform, this.workingDirectory, this.stateDirectory);
    const pidPath = this.pidPath(platform);
    this.assertCurrent();
    mkdirSync(dirname(pidPath), { recursive: true });
    this.assertCurrent();
    mkdirSync(dirname(logPath), { recursive: true });
    this.assertCurrent();
    const stdoutFd = openSync(logPath, 'a');
    let stderrFd: number | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let launchError: unknown;
    try {
      this.assertCurrent();
      stderrFd = openSync(logPath, 'a');
      const spawnOptions: SpawnOptions = {
        cwd: definition.workingDirectory,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        // An empty value means "not set" (the unit renderers drop it too); passing
        // it on would shadow a token the child resolves for itself.
        env: {
          ...process.env,
          ...Object.fromEntries(Object.entries(definition.env).filter(([, value]) => value.length > 0)),
        },
      };
      this.assertCurrent();
      const launch = this.processControl.spawn ?? ((command: string, args: readonly string[], options: SpawnOptions) => spawn(command, [...args], options));
      child = launch(definition.command, definition.args, spawnOptions);
    } catch (error) {
      launchError = error;
    } finally {
      closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
    if (child === undefined) {
      return {
        ...(yield* this.statusFlow()),
        lastAction: action,
        actionError: `could not start ${definition.command}: ${launchError instanceof Error ? launchError.message : String(launchError)}`,
      };
    }
    // A failed spawn reports asynchronously; without a listener it would be an
    // uncaught exception in the daemon.
    child.once('error', () => {});
    child.unref();
    if (child.pid === undefined) {
      return {
        ...(yield* this.statusFlow()),
        lastAction: action,
        actionError: `could not start ${definition.command}: the process did not launch (check that the command exists and is executable)`,
      };
    }
    try {
      this.assertCurrent();
      const startedAt = this.startTimeOf(child.pid);
      writeFileSync(pidPath, `${child.pid}\n${startedAt ?? ''}\n`, 'utf-8');
    } catch (error) {
      // This newly acquired child belongs to this call even if its restriction retired.
      child.kill('SIGTERM');
      throw error;
    }
    return {
      ...(yield* this.statusFlow()),
      lastAction: action,
    };
  }

  private stopManualProcess(platform: ManagedServicePlatform): void {
    const pidPath = this.pidPath(platform);
    const record = existsSync(pidPath) ? this.readPidRecord(pidPath) : undefined;
    if (record !== undefined && this.isServiceProcess(record)) {
      this.assertCurrent();
      try {
        if (this.processControl.signal) this.processControl.signal(record.pid, 'SIGTERM');
        else process.kill(record.pid, 'SIGTERM');
      } catch {
        // ignore stale processes
      }
    }
    if (existsSync(pidPath)) {
      this.assertCurrent();
      rmSync(pidPath, { force: true });
    }
  }

  private *stopManualFlow(platform: ManagedServicePlatform): ServiceFlow<ManagedServiceStatus> {
    this.stopManualProcess(platform);
    return {
      ...(yield* this.statusFlow()),
      lastAction: 'stop',
    };
  }

  /** Stops the recorded process, waits for it to exit, and only then starts a new one. */
  private *restartManualFlow(platform: ManagedServicePlatform): ServiceFlow<ManagedServiceStatus> {
    const pidPath = this.pidPath(platform);
    const record = existsSync(pidPath) ? this.readPidRecord(pidPath) : undefined;
    if (record !== undefined && record.pid === process.pid && this.isServiceProcess(record)) {
      // This daemon is the recorded process: its own SIGTERM cannot be handled
      // while this call waits for it, so it would only time out and start nothing.
      return {
        ...(yield* this.statusFlow()),
        lastAction: 'restart',
        actionError: `the service process (pid ${record.pid}) is the daemon answering this request and cannot restart itself; run the restart from a terminal (service restart) instead`,
      };
    }
    this.stopManualProcess(platform);
    if (record !== undefined && this.isServiceProcess(record)) {
      for (let waited = 0; this.isServiceProcess(record) && waited < MANUAL_STOP_WAIT_MS; waited += MANUAL_STOP_POLL_MS) {
        yield { pause: MANUAL_STOP_POLL_MS };
      }
      if (this.isServiceProcess(record)) {
        // Keep tracking it so stop/status can still find the process that did not exit.
        this.assertCurrent();
        writeFileSync(pidPath, `${record.pid}\n${record.startTime ?? ''}\n`, 'utf-8');
        return {
          ...(yield* this.statusFlow()),
          lastAction: 'restart',
          actionError: `the previous service process (pid ${record.pid}) did not exit within ${MANUAL_STOP_WAIT_MS / 1000} seconds, so no second one was started`,
        };
      }
    }
    return yield* this.startManualFlow(platform, 'restart');
  }

  private *platformActionFlow(platform: ManagedServicePlatform, action: 'start' | 'stop' | 'restart', fromDaemon: boolean): ServiceFlow<ManagedServiceStatus> {
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    const path = definitionPath(platform, serviceName, this.statePaths());
    if (fromDaemon && action !== 'start' && (platform === 'systemd' || platform === 'launchd')) {
      const before = yield* this.statusFlow();
      if (this.runsThisDaemon(before)) {
        if (platform === 'systemd') {
          // The stop reaches this process after the answer: the manager is asked to queue the job, not to wait for it.
          const queued = yield { run: ['systemctl', '--user', '--no-block', action, `${serviceName}.service`] };
          if ((queued.status ?? 1) !== 0) return { ...before, lastAction: action, actionError: commandFailureText(queued) };
        } else {
          // launchd stops and starts the job itself, so nothing depends on this process outliving the stop.
          yield { detach: action === 'restart'
            ? ['launchctl', 'kickstart', '-k', `gui/${launchdUid()}/${serviceName}`]
            : ['launchctl', 'bootout', `gui/${launchdUid()}/${serviceName}`] };
        }
        return {
          ...before,
          lastAction: action,
          accepted: action === 'restart'
            ? 'The service manager accepted the restart: this daemon stops after this answer and comes back in a few seconds.'
            : 'The service manager accepted the stop: this daemon stops after this answer.',
        };
      }
    }
    // Each step is an argv plus a bestEffort flag. launchd has no native restart
    // verb, so restart is an honest unload-then-load; the unload is best-effort
    // (the agent may simply not be loaded yet), mirroring suggestedCommands()'
    // human-facing `launchctl unload <path> || true`.
    const steps: ReadonlyArray<{ readonly argv: readonly string[]; readonly bestEffort?: boolean }> = platform === 'systemd'
      ? [{ argv: ['systemctl', '--user', action === 'start' ? 'enable' : action, ...(action === 'start' ? ['--now'] : []), `${serviceName}.service`] }]
      : platform === 'launchd'
        ? action === 'restart'
          ? [
              { argv: ['launchctl', 'unload', path], bestEffort: true },
              { argv: ['launchctl', 'load', path] },
            ]
          : [{ argv: ['launchctl', action === 'stop' ? 'unload' : 'load', path] }]
        : platform === 'windows'
          ? action === 'restart'
            ? [
                { argv: ['schtasks', '/End', '/TN', serviceName], bestEffort: true },
                { argv: ['schtasks', '/Run', '/TN', serviceName] },
              ]
            : [{ argv: ['schtasks', action === 'start' ? '/Run' : '/End', '/TN', serviceName] }]
          : [];
    if (steps.length === 0) {
      return {
        ...(yield* this.statusFlow()),
        lastAction: action,
        actionError: `Unsupported platform action: ${platform}`,
      };
    }
    let actionError: string | undefined;
    for (const step of steps) {
      const result = yield { run: step.argv };
      if ((result.status ?? 1) !== 0 && !step.bestEffort) {
        actionError = commandFailureText(result);
        break;
      }
    }
    return {
      ...(yield* this.statusFlow()),
      lastAction: action,
      ...(actionError === undefined ? {} : { actionError }),
    };
  }

  /**
   * Resolves `running` (+ `pid` when known) for the status. Only the manual
   * platform's `startManual` ever writes the pid file (`start()` branches on
   * `platform === 'manual'` before ever reaching `platformActionFlow`), so for
   * systemd/launchd the pid file is permanently absent and a pid-file-only
   * check would report `running: false` for a genuinely active unit. systemd
   * and launchd are queried live instead, through the same injected
   * `actionRunner` used by start/stop/restart (never a raw exec bypassing it,
   * so tests can fake the query deterministically).
   */
  private *runningFlow(platform: ManagedServicePlatform, serviceName: string): ServiceFlow<{ running: boolean; pid?: number | undefined; unreachable?: string | undefined }> {
    if (platform === 'systemd') {
      const result = yield { run: ['systemctl', '--user', 'is-active', `${serviceName}.service`] };
      const state = (result.stdout ?? '').trim();
      // A reachable manager always names a state ("inactive", "failed", ...),
      // even for a unit it has never heard of. No exit status or an empty
      // answer means no systemctl or no user bus (containers, WSL without
      // systemd, other init systems): "not running" there would invite an
      // unattended handover that cannot be completed after the stop.
      if (result.status === null || (result.status !== 0 && state === '')) {
        return { running: false, unreachable: 'the systemd user manager could not be reached (no systemctl or no user session bus)' };
      }
      return { running: result.status === 0 && state === 'active' };
    }
    if (platform === 'launchd') {
      // launchd: no single-job query is used here, `launchctl list <label>` prints
      // a plist dump on modern macOS, not a stable parseable field. Instead run the
      // plain `launchctl list` (same command this module's suggestedCommands()
      // already tells operators to run: `launchctl list | grep <name>`) and find the
      // job's own tabular line: `<pid-or-dash>\t<last-exit-status>\t<label>`. No
      // matching line = not loaded = not running; a `-` PID column = loaded but
      // stopped; a numeric PID = running.
      const result = yield { run: ['launchctl', 'list'] };
      if (result.status === null) {
        return { running: false, unreachable: 'launchctl could not be reached or did not answer in time' };
      }
      const match = (result.stdout ?? '')
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find((fields) => fields[fields.length - 1] === serviceName);
      if (!match) return { running: false };
      const pidToken = match[0];
      const pid = pidToken && /^\d+$/.test(pidToken) ? Number(pidToken) : undefined;
      return pid !== undefined ? { running: true, pid } : { running: false };
    }
    const pidPath = this.pidPath(platform);
    const record = existsSync(pidPath) ? this.readPidRecord(pidPath) : undefined;
    const running = record !== undefined ? this.isServiceProcess(record) : false;
    // Status is observational; explicit stop/uninstall own stale PID cleanup.
    return running && record !== undefined ? { running, pid: record.pid } : { running };
  }

  /** The synchronous driver: each command through the injected actionRunner, else a real spawnSync. */
  private drive<T>(flow: ServiceFlow<T>): T {
    let next = flow.next();
    while (!next.done) {
      const step = next.value;
      if ('pause' in step) {
        (this.processControl.pause ?? sleepSynchronously)(step.pause);
        next = flow.next(DONE);
      } else if ('detach' in step) {
        next = flow.next(this.runDetached(step.detach));
      } else {
        next = flow.next(this.runQuery(step.run[0]!, step.run.slice(1)));
      }
    }
    return next.value;
  }

  /** The asynchronous driver: no command and no wait blocks the caller's thread. */
  private async driveAsync<T>(flow: ServiceFlow<T>): Promise<T> {
    let next = flow.next();
    while (!next.done) {
      const step = next.value;
      if ('pause' in step) {
        if (this.processControl.pause) this.processControl.pause(step.pause);
        else await new Promise<void>((resolveWait) => { setTimeout(resolveWait, step.pause); });
        next = flow.next(DONE);
      } else if ('detach' in step) {
        next = flow.next(this.runDetached(step.detach));
      } else {
        next = flow.next(await this.runQueryAsync(step.run[0]!, step.run.slice(1)));
      }
    }
    return next.value;
  }

  /** Runs a service-management query/action through the injected actionRunner when present, else a real spawnSync. */
  private runQuery(command: string, args: readonly string[]): ManagedServiceActionResult {
    this.assertCurrent();
    try {
      return this.actionRunner
        ? this.actionRunner(command, args)
        : spawnSync(command, args, { stdio: 'pipe', encoding: 'utf-8', timeout: SERVICE_QUERY_TIMEOUT_MS });
    } finally { this.assertCurrent(); }
  }

  /** `runQuery` without blocking: the same timeout, the output collected as it arrives. */
  private async runQueryAsync(command: string, args: readonly string[]): Promise<ManagedServiceActionResult> {
    this.assertCurrent();
    try {
      if (this.actionRunner) return this.actionRunner(command, args);
      return await new Promise<ManagedServiceActionResult>((resolveResult) => {
        let stdout = '', stderr = '', settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: ManagedServiceActionResult): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolveResult(result);
        };
        let child: ChildProcess;
        try {
          child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          finish({ status: null, stderr: error instanceof Error ? error.message : String(error) });
          return;
        }
        timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          finish({ status: null, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${command} did not answer within ${SERVICE_QUERY_TIMEOUT_MS / 1000} seconds` });
        }, SERVICE_QUERY_TIMEOUT_MS);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        child.once('error', (error) => finish({ status: null, stdout, stderr: error.message }));
        child.once('close', (code) => finish({ status: code, stdout, stderr }));
      });
    } finally { this.assertCurrent(); }
  }

  /**
   * Issues a command that ends this process and is carried out by the service
   * manager itself. It runs in its own process group, so the stop it causes
   * does not take it down, and nothing waits for it.
   */
  private runDetached(argv: readonly string[]): ManagedServiceActionResult {
    this.assertCurrent();
    if (this.actionRunner) return this.actionRunner(argv[0]!, argv.slice(1));
    try {
      const child = spawn(argv[0]!, [...argv.slice(1)], { stdio: 'ignore', detached: true });
      child.once('error', () => {});
      child.unref();
      return DONE;
    } catch (error) {
      return { status: null, stderr: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The pid file is `pid` then, optionally, the process start time that proves a reused pid is not ours. */
  private readPidRecord(path: string): { pid: number; startTime?: string | undefined } | undefined {
    const [first = '', second = ''] = readFileSync(path, 'utf-8').split('\n').map((line) => line.trim());
    const pid = Number.parseInt(first, 10);
    if (!Number.isFinite(pid) || pid <= 0) return undefined;
    return second.length > 0 ? { pid, startTime: second } : { pid };
  }

  private startTimeOf(pid: number): string | null {
    return (this.processControl.startTime ?? processStartTime)(pid);
  }

  /** Alive, and (when a start time was recorded and is readable) still the process that was started. */
  private isServiceProcess(record: { pid: number; startTime?: string | undefined }): boolean {
    if (!this.isPidRunning(record.pid)) return false;
    if (record.startTime === undefined) return true;
    const current = this.startTimeOf(record.pid);
    return current === null || current === record.startTime;
  }

  private isPidRunning(pid: number): boolean {
    if (this.processControl.isRunning) return this.processControl.isRunning(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
