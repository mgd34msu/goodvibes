import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { processStartTime } from '../config/process-start-time.js';
import { ConfigManager } from '../config/manager.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';
import { SERVICE_MANAGEMENT_FEATURE_FLAG } from '../runtime/feature-flags/flags.js';
import { currentProcessSignals, resolveDaemonExecInvocation } from './daemon-exec-invocation.js';
import { buildManagedDaemonServiceDefinition } from './managed-service-definition.js';
export { MANAGED_SERVICE_DESCRIPTION } from './managed-service-definition.js';
import { resolveGoodVibesHomeOwnership } from '../config/goodvibes-home.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';

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
  readonly lastAction?: 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status' | 'autostart' | undefined;
  readonly actionError?: string | undefined;
  /**
   * The manager accepted an action that ends the daemon giving this answer
   * (a stop, restart or uninstall of its own service) and carries it out after
   * the answer: what happens next, in one sentence. The rest of the record is
   * the state the action was asked from.
   */
  readonly accepted?: string | undefined;
  /**
   * The action was handed to the service manager and nothing has seen it
   * finish yet (launchd runs `kickstart` and `bootout` after this daemon
   * answers): `check` is the command that tells whether it did.
   */
  readonly pending?: { readonly check: string; readonly since: number } | undefined;
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
  /**
   * The login home the unit is registered under and the service keeps its pid
   * file and log under (`resolveServiceUnitHome`). Every process that manages
   * the service passes the same one, never a GOODVIBES_HOME tree.
   */
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
/** How long a process that ignored SIGTERM has to exit after SIGKILL. */
const MANUAL_KILL_WAIT_MS = 2_000;
/** How long a service-manager command may take before it is reported as not answering (a broken user bus). */
const SERVICE_QUERY_TIMEOUT_MS = 10_000;
/**
 * How long a blocking start, stop or restart may take. The manager answers
 * only once the job is done, and a stop waits for the daemon's own orderly
 * shutdown (systemd allows 90 s by default before it kills), so the query
 * bound would end the client while the job it asked for still runs.
 */
const SERVICE_JOB_TIMEOUT_MS = 120_000;

/** One step a service flow hands its driver: a command to run and read, a command to issue and leave, or a wait. */
type ServiceStep =
  | { readonly run: readonly string[]; readonly timeoutMs?: number | undefined }
  | { readonly detach: readonly string[] }
  | { readonly pause: number };
type ServiceFlow<T> = Generator<ServiceStep, T, ManagedServiceActionResult>;
const DONE: ManagedServiceActionResult = Object.freeze({ status: 0 });

/** Results of a command a signal ended, with that signal. */
const endedBySignal = new WeakMap<ManagedServiceActionResult, NodeJS.Signals>();

/**
 * A command that ended without an exit status: what ended it, in words. Its
 * own output, if any, follows. A manager client that was stopped did not
 * report a result; the job it asked for may still have been carried out.
 */
function unfinishedCommand(command: string, args: readonly string[], timeoutMs: number, ended: { signal?: NodeJS.Signals | null | undefined; timedOut?: boolean; error?: Error | undefined }, output: { stdout?: string | undefined; stderr?: string | undefined }): ManagedServiceActionResult {
  const name = [command, ...args.filter(word => !word.startsWith('-'))].slice(0, 3).join(' ');
  const why = ended.timedOut
    ? `${name} did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped`
    : ended.signal
      ? `${name} was ended by ${ended.signal} before it reported a result`
      : `${name} could not be run${ended.error ? ` (${ended.error.message})` : ''}`;
  const said = (output.stderr ?? '').trim();
  const result: ManagedServiceActionResult = { status: null, stdout: output.stdout, stderr: said ? `${why}: ${said}` : why };
  if (!ended.timedOut && ended.signal) endedBySignal.set(result, ended.signal);
  return result;
}

/** What a failed command said, for the person reading the action's result. */
function commandFailureText(result: ManagedServiceActionResult): string {
  return ((result.stderr ?? '') || (result.stdout ?? '') || (result.status === null ? 'the command ended without an exit status' : `command exited with ${result.status}`)).trim();
}

/**
 * The launchd domain of this user's agents (`gui/<uid>`), named on every
 * launchctl command. The legacy `load`, `unload` and `list` act on whichever
 * domain the CALLING process belongs to: the GUI domain from a Terminal window,
 * but the user's background domain from an SSH login, so a job loaded over SSH
 * was not where `kickstart`/`bootout gui/<uid>/...` (the restart, stop and
 * uninstall asked of a running daemon, and the update handover) look. `load`
 * and `unload` also exit 0 whatever happened, so a failed start read as
 * success. `bootstrap`, `bootout`, `kickstart` and `print` take the domain
 * explicitly and report failure in their exit status.
 */
function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? ''}`;
}

/** `launchctl`'s exit status for a service its domain does not hold. */
const LAUNCHCTL_NOT_FOUND = 113;
/** How long a restart waits for launchd to let go of a booted-out job: 20 looks, 250 ms apart. */
const LAUNCHD_RELEASE_POLLS = 20;
const LAUNCHD_RELEASE_POLL_MS = 250;
const LAUNCHD_RELEASE_SECONDS = (LAUNCHD_RELEASE_POLLS * LAUNCHD_RELEASE_POLL_MS) / 1000;

/** The failure when the user's GUI domain cannot be asked. */
function launchdUnreachable(): string {
  return `launchd could not be asked about the ${launchdDomain()} domain (launchctl did not answer, or no one is logged in at this Mac's screen; a LaunchAgent runs only in a logged-in session)`;
}

/** This service's launchd target, `gui/<uid>/<label>`. */
function launchdTarget(serviceName: string): string {
  return `${launchdDomain()}/${serviceName}`;
}

/**
 * Whether the job is loaded in the user's GUI domain, and its pid while it
 * runs, from `launchctl print gui/<uid>/<label>`. Only the `state` and `pid`
 * lines are read; the rest (the job's environment among it) is not kept.
 * Exit 113 is launchd's "could not find service": not loaded. Any other
 * failure, or a launchctl that could not be run or did not answer, means the
 * GUI domain could not be asked (no one is logged in at the Mac's screen).
 */
function readLaunchdJob(result: ManagedServiceActionResult): { readonly reachable: boolean; readonly loaded: boolean; readonly running: boolean; readonly pid?: number | undefined } {
  if (result.status === LAUNCHCTL_NOT_FOUND) return { reachable: true, loaded: false, running: false };
  if (result.status !== 0) return { reachable: false, loaded: false, running: false };
  const text = result.stdout ?? '';
  const state = /^\s*state = (.+?)\s*$/m.exec(text)?.[1];
  const pidText = /^\s*pid = (\d+)\s*$/m.exec(text)?.[1];
  const pid = pidText === undefined ? undefined : Number(pidText);
  const running = state === 'running' && pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
  return { reachable: true, loaded: true, running, ...(running ? { pid } : {}) };
}

export interface ManagedServiceManagerOptions extends ManagedServicePaths {
  readonly processControl?: ManagedServiceProcessControl | undefined;
  readonly definitionOverride?: ManagedServiceDefinition | undefined;
  readonly actionRunner?: ((command: string, args: readonly string[]) => ManagedServiceActionResult) | undefined;
  /** A retained caller restriction checked before native publication and platform actions. */
  readonly assertCurrent?: (() => void) | undefined;
  /**
   * What the service launches: the daemon executable and the homes it runs
   * with. Absent: this process's own executable and the homes its environment
   * names. Either way the definition comes from `buildManagedDaemonServiceDefinition`.
   */
  readonly launch?: ManagedDaemonLaunch | undefined;
  readonly defaultServiceName?: string | undefined;
  readonly featureFlags?: FeatureFlagReader | undefined;
}

/** The executable and homes a managed daemon service runs with. */
export interface ManagedDaemonLaunch {
  /** The daemon executable; absent means this process's own. */
  readonly command?: string | undefined;
  readonly homeDirectory: string;
  readonly daemonHomeDirectory?: string | undefined;
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
  unitHomeDirectory: string,
  options: Pick<ManagedServiceManagerOptions, 'launch' | 'defaultServiceName'>,
): ManagedServiceDefinition {
  // The executable is this process's own when the caller named none: a
  // compiled binary is itself; a source run yields the `run <cli.ts>` shape,
  // which boot promotion never installs (facade-lifecycle.promoteToServiceAtBoot).
  // Only the executable is taken from how this process started, never its
  // arguments: the daemon reads its endpoint and settings at every start.
  const invocation = options.launch?.command === undefined
    ? resolveDaemonExecInvocation(currentProcessSignals(), workingDirectory)
    : undefined;
  const homes = options.launch ?? resolveGoodVibesHomeOwnership();
  const definition = buildManagedDaemonServiceDefinition({
    name: resolveServiceName(configManager, options.defaultServiceName),
    command: options.launch?.command ?? invocation!.command,
    homeDirectory: homes.homeDirectory,
    daemonHomeDirectory: homes.daemonHomeDirectory,
    unitHomeDirectory,
    workingDirectory,
    restartOnFailure: configManager.get('service.restartOnFailure') !== false,
  });
  return invocation !== undefined && !invocation.fromCompiledBinary
    ? { ...definition, args: [...invocation.args, ...definition.args] }
    : definition;
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

/**
 * The LaunchAgent for the daemon. `startAtLogin` (service.autostart) decides
 * RunAtLoad; with it off, a restart policy is kept as "restart after a
 * failure" only, because an unconditional KeepAlive would start the job at
 * login all the same.
 */
function renderLaunchdPlist(definition: ManagedServiceDefinition, startAtLogin: boolean): string {
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
    startAtLogin ? '  <true/>' : '  <false/>',
    '  <key>KeepAlive</key>',
    !definition.restartOnFailure ? '  <false/>'
      : startAtLogin ? '  <true/>'
        : '  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>',
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
 * A GoodVibes definition carries no secret, but one the owner edited may: status
 * output shows each environment variable's name, never its value.
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
        `launchctl bootout ${launchdTarget(serviceName)} || true`,
        `launchctl bootstrap ${launchdDomain()} ${path}`,
        `launchctl print ${launchdTarget(serviceName)}`,
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
  private readonly launch?: ManagedDaemonLaunch | undefined;
  private readonly defaultServiceName?: string | undefined;
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
    this.launch = options.launch;
    this.defaultServiceName = options.defaultServiceName;
    this.featureFlags = options.featureFlags ?? null;
    this.processControl = options.processControl ?? {};
  }

  private assertCurrent(): void {
    assertSynchronousJudgmentGuard(() => this.currentRestriction?.(), () => new Error('Service current restriction must complete synchronously without returning a value'));
  }

  private isEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, SERVICE_MANAGEMENT_FEATURE_FLAG);
  }

  /** service.autostart: whether the service is to start on its own at login. */
  private startsAtLogin(): boolean {
    return this.configManager.get('service.autostart') === true;
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

  /** The paths service definitions are kept under. */
  private statePaths(): ManagedServicePaths {
    return this.getPaths();
  }

  /** The pid file of `platform`, in the one state directory. */
  private pidPath(platform: ManagedServicePlatform): string {
    return pidFilePath(platform, this.stateDirectory);
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
        : [platform === 'launchd' ? renderLaunchdPlist(definition, this.startsAtLogin())
          : platform === 'windows' ? renderWindowsCommand(definition)
            : [definition.command, ...definition.args].join(' ')];
      return candidates.some((contents) => actual === `${contents}\n`);
    } catch { return false; }
  }

  /**
   * Whether the service manager has not taken the definition on disk yet, so a
   * matching file alone does not make it current: systemd has not loaded the
   * unit, reports a pending `daemon-reload`, or cannot say (the reload runs
   * again); a Windows logon task is missing. launchd reads the plist when it
   * loads the job, so nothing is pending there.
   */
  registrationPending(): boolean {
    return this.drive(this.registrationPendingFlow());
  }

  private *registrationPendingFlow(): ServiceFlow<boolean> {
    this.assertCurrent();
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    if (platform === 'systemd') {
      const result = yield { run: ['systemctl', '--user', 'show', '-p', 'NeedDaemonReload', '-p', 'LoadState', `${serviceName}.service`] };
      if ((result.status ?? 1) !== 0) return true;
      const properties = new Map((result.stdout ?? '').split('\n').map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
      }));
      return properties.get('NeedDaemonReload') !== 'no' || properties.get('LoadState') !== 'loaded';
    }
    if (platform === 'windows') {
      const result = yield { run: ['schtasks', '/Query', '/TN', serviceName] };
      return (result.status ?? 1) !== 0;
    }
    return false;
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

  /**
   * Write the current definition and register it with the service manager
   * (systemd `daemon-reload`, the Windows task), the way {@link install}
   * does, but without changing login lingering. Nothing is started or
   * stopped: a running service keeps its current launch until it restarts,
   * and a stopped one stays stopped.
   */
  refresh(): ManagedServiceStatus {
    return this.drive(this.installFlow(false));
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

  /**
   * Makes the service start on its own at login, or not, as service.autostart
   * says now: the one place the setting acts, called by the daemon whenever the
   * value changes, however it was set. On: installs the service when it is not
   * (systemd enables the unit, a LaunchAgent gets RunAtLoad). Off: the unit is
   * disabled, or the LaunchAgent rewritten without RunAtLoad; the service stays
   * installed and a running daemon keeps running. A Windows logon task always
   * starts at login while installed, which the answer says. Never waits.
   */
  applyAutostart(): Promise<ManagedServiceStatus> {
    return this.driveAsync(this.autostartFlow());
  }

  private *autostartFlow(): ServiceFlow<ManagedServiceStatus> {
    this.assertCurrent();
    this.requireEnabled('change whether the service starts at login');
    const on = this.startsAtLogin();
    let status = yield* this.statusFlow();
    if (status.platform === 'manual') {
      return { ...status, lastAction: 'autostart', ...(on ? { actionError: 'the manual platform never starts the daemon at login; set service.platform to systemd, launchd or windows' } : {}) };
    }
    let lingerNote: string | undefined;
    if (on && !status.installed) {
      const installed = yield* this.installFlow();
      if (installed.actionError) return { ...installed, lastAction: 'autostart' };
      lingerNote = installed.lingerNote;
      status = installed;
    }
    let actionError: string | undefined;
    if (status.installed && status.platform === 'systemd') {
      const result = yield { run: ['systemctl', '--user', on ? 'enable' : 'disable', `${status.serviceName}.service`] };
      if ((result.status ?? 1) !== 0) actionError = `systemctl --user ${on ? 'enable' : 'disable'} failed: ${commandFailureText(result)}`;
    } else if (status.installed && status.platform === 'launchd') {
      // The LaunchAgent's RunAtLoad is written from the setting; a running job keeps running.
      actionError = (yield* this.installFlow(false)).actionError ?? undefined;
    } else if (status.installed && status.platform === 'windows' && !on) {
      actionError = 'a Windows logon task starts the daemon at login while it is installed; goodvibes service uninstall removes it';
    }
    return {
      ...(yield* this.statusFlow()),
      lastAction: 'autostart',
      ...(actionError === undefined ? {} : { actionError }),
      ...(lingerNote ? { lingerNote } : {}),
    };
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
      // systemd's enablement and the LaunchAgent's RunAtLoad follow service.autostart
      // (applyAutostart, install and start keep them so); a logon task starts at
      // login while installed; the manual platform never does.
      autostart: platform === 'manual' ? false : platform === 'windows' ? installed : installed && this.startsAtLogin(),
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

  private *installFlow(ensureLinger = true): ServiceFlow<ManagedServiceStatus> {
    this.assertCurrent();
    this.requireEnabled(ensureLinger ? 'install service' : 'refresh service');
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    const definition = this.resolveDefinition();
    const path = definitionPath(platform, serviceName, this.statePaths());
    const contents = platform === 'systemd'
      ? renderSystemdUnit(definition, yield* this.systemdMajorVersionFlow())
      : platform === 'launchd'
        ? renderLaunchdPlist(definition, this.startsAtLogin())
        : platform === 'windows'
          ? renderWindowsCommand(definition)
          : [definition.command, ...definition.args].join(' ');
    this.assertCurrent();
    mkdirSync(dirname(path), { recursive: true });
    this.assertCurrent();
    // Owner-only: the definition names this user's homes and executable.
    writeFileSync(path, `${contents}\n`, { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* a platform without POSIX modes */ }
    // Without the reload, systemd keeps acting on the previously loaded unit.
    const registrationError = yield* this.registerInstalledDefinitionFlow(platform, definition);
    const lingerNote = platform === 'systemd' && ensureLinger ? yield* this.ensureLingerFlow() : undefined;
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
    let pendingSince: number | undefined;
    if (existsSync(status.path)) {
      const self = fromDaemon && (yield* this.runsThisDaemonFlow(status));
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
        const detached = yield { detach: ['launchctl', 'bootout', launchdTarget(status.serviceName)] };
        if (detached.status !== 0) actionError = `the service file was removed, but launchctl bootout could not be started, so this daemon is still running: ${commandFailureText(detached)}`;
        else {
          accepted = 'The service file was removed and launchd was asked to unload the job; nothing has seen it unload yet. This daemon stops when it does and will not start at login again.';
          pendingSince = Date.now();
        }
      } else {
        // Stop and unregister while the definition still names the service, so
        // removing the file does not leave a running, autostarting daemon behind.
        // Ending a task that is not running, or unloading a job that is not loaded,
        // exits non-zero without anything being left behind, so those are best effort.
        const teardown: ReadonlyArray<{ readonly argv: readonly string[]; readonly bestEffort?: boolean }> = status.platform === 'systemd'
          ? [{ argv: ['systemctl', '--user', 'disable', '--now', `${status.serviceName}.service`] }]
          : status.platform === 'launchd'
            ? [{ argv: ['launchctl', 'bootout', launchdTarget(status.serviceName)], bestEffort: true }]
            : status.platform === 'windows'
              ? [{ argv: ['schtasks', '/End', '/TN', status.serviceName], bestEffort: true }, { argv: ['schtasks', '/Delete', '/TN', status.serviceName, '/F'] }]
              : [];
        for (const { argv, bestEffort } of teardown) {
          const result = yield { run: argv };
          if ((result.status ?? 1) !== 0 && !bestEffort && actionError === undefined) {
            actionError = `${argv.slice(0, 2).join(' ')} failed, so the service may still be running: ${commandFailureText(result)}`;
          }
          // A job launchd booted out may still be held for a moment; the final status must not read it as running.
          if (status.platform === 'launchd' && result.status === 0) yield* this.launchdReleaseFlow(launchdTarget(status.serviceName));
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
      ...(pendingSince === undefined ? {} : { pending: { check: 'goodvibes service status', since: pendingSince } }),
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

  /**
   * Whether the service is this daemon: launchd names its pid; systemd is
   * asked for the unit's main pid (one more command, only on a stop, restart or
   * uninstall asked of the daemon). A daemon the unit did not start (one hosted
   * in a terminal app, or another home's) is not ended by the job, so it takes
   * the waiting path and reports the job's outcome.
   */
  private *runsThisDaemonFlow(status: ManagedServiceStatus): ServiceFlow<boolean> {
    if (!status.installed || !status.running) return false;
    if (status.platform === 'launchd') return status.pid === process.pid;
    if (status.platform !== 'systemd') return false;
    const result = yield { run: ['systemctl', '--user', 'show', '-p', 'MainPID', '--value', `${status.serviceName}.service`] };
    const mainPid = (result.status ?? 1) === 0 ? Number((result.stdout ?? '').trim()) : Number.NaN;
    // Unreadable: a running unit asked from inside the daemon is taken to be it,
    // since waiting on a stop that ends this process would lose the answer.
    if (!Number.isInteger(mainPid)) return true;
    return mainPid === process.pid;
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
    return this.definitionOverride ?? buildDefaultDefinition(this.configManager, this.workingDirectory, this.homeDirectory, {
      launch: this.launch,
      defaultServiceName: this.defaultServiceName,
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

  private signalManualProcess(pid: number, signal: NodeJS.Signals): void {
    this.assertCurrent();
    try {
      if (this.processControl.signal) this.processControl.signal(pid, signal);
      else process.kill(pid, signal);
    } catch {
      // Already gone; the wait below sees it.
    }
  }

  /**
   * Stop the recorded process and keep its pid file until its exit is seen:
   * SIGTERM, up to 10 s, SIGKILL, up to 2 s more. Returns the pid still
   * running when even SIGKILL did not end it (its pid file is kept, so status
   * and a later stop still find it), else undefined. The daemon answering
   * this request cannot wait for its own exit: it is signalled and its record
   * removed, as its own shutdown would.
   */
  private *stopManualProcessFlow(platform: ManagedServicePlatform): ServiceFlow<number | undefined> {
    const pidPath = this.pidPath(platform);
    const record = existsSync(pidPath) ? this.readPidRecord(pidPath) : undefined;
    if (record !== undefined && this.isServiceProcess(record)) {
      this.signalManualProcess(record.pid, 'SIGTERM');
      if (record.pid !== process.pid) {
        for (let waited = 0; this.isServiceProcess(record) && waited < MANUAL_STOP_WAIT_MS; waited += MANUAL_STOP_POLL_MS) {
          yield { pause: MANUAL_STOP_POLL_MS };
        }
        if (this.isServiceProcess(record)) {
          this.signalManualProcess(record.pid, 'SIGKILL');
          for (let waited = 0; this.isServiceProcess(record) && waited < MANUAL_KILL_WAIT_MS; waited += MANUAL_STOP_POLL_MS) {
            yield { pause: MANUAL_STOP_POLL_MS };
          }
        }
        if (this.isServiceProcess(record)) return record.pid;
      }
    }
    if (existsSync(pidPath)) {
      this.assertCurrent();
      rmSync(pidPath, { force: true });
    }
    return undefined;
  }

  private *stopManualFlow(platform: ManagedServicePlatform): ServiceFlow<ManagedServiceStatus> {
    const stillRunning = yield* this.stopManualProcessFlow(platform);
    return {
      ...(yield* this.statusFlow()),
      lastAction: 'stop',
      ...(stillRunning !== undefined
        ? { actionError: `the service process (pid ${stillRunning}) did not exit after SIGTERM and SIGKILL; its pid file is kept so status still finds it` }
        : {}),
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
    const stillRunning = yield* this.stopManualProcessFlow(platform);
    if (stillRunning !== undefined) {
      // Its pid file was kept, so stop/status can still find the process that did not exit.
      return {
        ...(yield* this.statusFlow()),
        lastAction: 'restart',
        actionError: `the previous service process (pid ${stillRunning}) did not exit after SIGTERM and SIGKILL, so no second one was started`,
      };
    }
    return yield* this.startManualFlow(platform, 'restart');
  }

  private *platformActionFlow(platform: ManagedServicePlatform, action: 'start' | 'stop' | 'restart', fromDaemon: boolean): ServiceFlow<ManagedServiceStatus> {
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    const path = definitionPath(platform, serviceName, this.statePaths());
    if (fromDaemon && action !== 'start' && (platform === 'systemd' || platform === 'launchd')) {
      const before = yield* this.statusFlow();
      if (yield* this.runsThisDaemonFlow(before)) {
        if (platform === 'systemd') {
          // The stop reaches this process after the answer: the manager is asked to queue the job, not to wait for it.
          const queued = yield { run: ['systemctl', '--user', '--no-block', action, `${serviceName}.service`] };
          // The client runs in this service's control group: the stop it queued
          // can end it with SIGTERM before it exits, and that stop is the job.
          const stoppedWithService = queued.status === null && endedBySignal.get(queued) === 'SIGTERM';
          if ((queued.status ?? 1) !== 0 && !stoppedWithService) return { ...before, lastAction: action, actionError: commandFailureText(queued) };
          return {
            ...before,
            lastAction: action,
            accepted: action === 'restart'
              ? 'The service manager accepted the restart: this daemon stops after this answer and comes back in a few seconds.'
              : 'The service manager accepted the stop: this daemon stops after this answer.',
          };
        }
        // launchd stops and starts the job itself, so nothing depends on this
        // process outliving the stop; but launchctl answers only after this
        // daemon has answered, so the receipt says what was asked, not done.
        const detached = yield { detach: action === 'restart'
          ? ['launchctl', 'kickstart', '-k', launchdTarget(serviceName)]
          : ['launchctl', 'bootout', launchdTarget(serviceName)] };
        if (detached.status !== 0) return { ...before, lastAction: action, actionError: `launchctl could not be started: ${commandFailureText(detached)}` };
        return {
          ...before,
          lastAction: action,
          accepted: action === 'restart'
            ? 'Asked launchd to restart the service; nothing has seen it come back yet. This daemon stops after this answer.'
            : 'Asked launchd to stop the service; nothing has seen it stop yet. This daemon stops when launchd stops it.',
          pending: { check: 'goodvibes service status', since: Date.now() },
        };
      }
    }
    if (platform === 'launchd') {
      const actionError = yield* this.launchdActionFlow(action, serviceName, path);
      return {
        ...(yield* this.statusFlow()),
        lastAction: action,
        ...(actionError === undefined ? {} : { actionError }),
      };
    }
    // Each step is an argv plus a bestEffort flag.
    const steps: ReadonlyArray<{ readonly argv: readonly string[]; readonly bestEffort?: boolean }> = platform === 'systemd'
      // Starting enables the unit at login only when service.autostart says so.
      ? [{ argv: action === 'start' && this.startsAtLogin()
        ? ['systemctl', '--user', 'enable', '--now', `${serviceName}.service`]
        : ['systemctl', '--user', action, `${serviceName}.service`] }]
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
      const result = yield { run: step.argv, timeoutMs: SERVICE_JOB_TIMEOUT_MS };
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
   * A start, stop or restart of the launchd agent in the user's GUI domain;
   * returns the failure text, or undefined. What each does depends on whether
   * the job is loaded there: a loaded job is started with `kickstart`; a stop
   * boots it out, and has nothing to do when it is not loaded; a restart boots
   * it out and bootstraps the definition again, so a rewritten plist takes
   * effect. `bootout` can return before launchd has let go of the job, so the
   * restart waits until `print` no longer finds it before the bootstrap.
   */
  private *launchdActionFlow(action: 'start' | 'stop' | 'restart', serviceName: string, path: string): ServiceFlow<string | undefined> {
    const target = launchdTarget(serviceName);
    const job = readLaunchdJob(yield { run: ['launchctl', 'print', target] });
    if (!job.reachable) return launchdUnreachable();
    if (action === 'start' && job.loaded) {
      const kicked = yield { run: ['launchctl', 'kickstart', target] };
      return (kicked.status ?? 1) === 0 ? undefined : commandFailureText(kicked);
    }
    if (action !== 'start' && job.loaded) {
      const booted = yield { run: ['launchctl', 'bootout', target] };
      if ((booted.status ?? 1) !== 0) return commandFailureText(booted);
      const released = yield* this.launchdReleaseFlow(target);
      if (released === 'unreachable') return launchdUnreachable();
      if (!released) {
        return action === 'stop'
          ? `launchd still held ${target} ${LAUNCHD_RELEASE_SECONDS} seconds after it was booted out`
          : `launchd still held ${target} ${LAUNCHD_RELEASE_SECONDS} seconds after it was booted out, so its definition was not loaded again; load it with: launchctl bootstrap ${launchdDomain()} ${path}`;
      }
    }
    if (action === 'stop') return undefined;
    const loaded = yield { run: ['launchctl', 'bootstrap', launchdDomain(), path] };
    if ((loaded.status ?? 1) !== 0) return commandFailureText(loaded);
    // Without RunAtLoad (service.autostart off) loading the job does not run it.
    if (this.startsAtLogin()) return undefined;
    const kicked = yield { run: ['launchctl', 'kickstart', target] };
    return (kicked.status ?? 1) === 0 ? undefined : commandFailureText(kicked);
  }

  /**
   * After a `bootout`: whether launchd has let go of the job, looked for with
   * `print` until it no longer finds it, at most {@link LAUNCHD_RELEASE_SECONDS}.
   * `bootout` can return while the job is still being torn down.
   */
  private *launchdReleaseFlow(target: string): ServiceFlow<boolean | 'unreachable'> {
    for (let attempt = 0; attempt < LAUNCHD_RELEASE_POLLS; attempt++) {
      if (attempt > 0) yield { pause: LAUNCHD_RELEASE_POLL_MS };
      const job = readLaunchdJob(yield { run: ['launchctl', 'print', target] });
      if (!job.reachable) return 'unreachable';
      if (!job.loaded) return true;
    }
    return false;
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
      // The job in the user's GUI domain, named explicitly: plain `launchctl
      // list` lists the CALLER's domain, which from an SSH login is not the one
      // the agent runs in, so a running daemon read as stopped there.
      const job = readLaunchdJob(yield { run: ['launchctl', 'print', launchdTarget(serviceName)] });
      if (!job.reachable) return { running: false, unreachable: launchdUnreachable() };
      return job.running && job.pid !== undefined ? { running: true, pid: job.pid } : { running: false };
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
        next = flow.next(this.runQuery(step.run[0]!, step.run.slice(1), step.timeoutMs));
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
        next = flow.next(await this.runQueryAsync(step.run[0]!, step.run.slice(1), step.timeoutMs));
      }
    }
    return next.value;
  }

  /** Runs a service-management query/action through the injected actionRunner when present, else a real spawnSync. */
  private runQuery(command: string, args: readonly string[], timeoutMs = SERVICE_QUERY_TIMEOUT_MS): ManagedServiceActionResult {
    this.assertCurrent();
    try {
      if (this.actionRunner) return this.actionRunner(command, args);
      const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf-8', timeout: timeoutMs });
      if (result.status !== null) return result;
      // spawnSync ends a command that outlives its timeout with SIGTERM and reports it in `error`.
      return unfinishedCommand(command, args, timeoutMs, {
        timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT', signal: result.signal, error: result.error,
      }, result);
    } finally { this.assertCurrent(); }
  }

  /** `runQuery` without blocking: the same timeout, the output collected as it arrives. */
  private async runQueryAsync(command: string, args: readonly string[], timeoutMs = SERVICE_QUERY_TIMEOUT_MS): Promise<ManagedServiceActionResult> {
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
          finish(unfinishedCommand(command, args, timeoutMs, { timedOut: true }, { stdout, stderr }));
        }, timeoutMs);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        child.once('error', (error) => finish({ status: null, stdout, stderr: error.message }));
        child.once('close', (code, signal) => finish(code === null ? unfinishedCommand(command, args, timeoutMs, { signal }, { stdout, stderr }) : { status: code, stdout, stderr }));
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
    } catch {
      return false;
    }
    // An exited child this process has not reaped yet still answers signal 0; it runs nothing.
    return !isZombie(pid);
  }
}

/** Linux: the process has exited and only waits to be reaped (state `Z` in /proc/<pid>/stat). */
function isZombie(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch {
    return false;
  }
}

function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
