/**
 * daemon-autostart.ts, starting a daemon that is installed but not running,
 * once, at boot.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A surface product used to solve "no daemon on the port" by BEING one: it
 * embedded a daemon server in its own process. That is gone, the daemon is its
 * own product and a surface adopts one or does without.
 *
 * Which leaves a case that must not become the user's problem: the daemon is
 * installed on this machine, the service is simply stopped, and the surface
 * boots to "no daemon" with a suggestion to go type something. So boot
 * discovery gets exactly one recovery step, ask the platform service manager
 * whether the daemon's service entry exists, start it if it does, wait a bounded
 * time, and re-probe.
 *
 * Both surface products grew this independently and arrived at the same policy,
 * with each carrying one thing the other lacked. This is the union of the two:
 * the terminal app's outcome renderer and its prefer-an-already-running-unit
 * choice, and the chat host's attempt-counted wait (which terminates even with
 * an injected no-op sleep), its `platform`/`unitPath` reporting, its
 * duplicate-name de-duplication, and its explicit refusal when the only
 * installed entry is one no service manager here can start.
 *
 * ── The boundaries, which stay strict ──────────────────────────────────────
 *
 * - A REACHABLE daemon is never restarted. Adopting is the whole point.
 * - A HELD port, `blocked` (an unverified process) or `incompatible` (a
 *   GoodVibes daemon on a wire version this build refuses), is left alone.
 *   Those are the closest states a probe has to "another owner is mid-update",
 *   and stepping on either turns a transient state into an outage.
 * - A service the manager already reports ACTIVE gets a bounded wait, never a
 *   second start underneath it.
 * - With no service installed, the daemon program on this machine
 *   (daemon-program.ts, the one lookup) is started in the background,
 *   detached, and waited for; the program says so in one line. Where the
 *   daemon program is not on this machine either, one line says so and names
 *   the installer. Nothing is asked.
 * - Every failure is reported and none of them break boot. Discovery failing is
 *   a reason to say so, not a reason to refuse to start.
 */
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { findDaemonProgram, startDaemonProgram, type DaemonProgram, type DaemonProgramStart } from './daemon-program.js';
import { configuredDaemonOrigin } from './daemon-target-resolver.js';
import { PlatformServiceManager, resolveDaemonServiceDefault, resolveServiceUnitHome, type ManagedServiceActionResult, type ManagedServiceStatus } from '../../daemon/index.js';
import { readLifecycleMarker } from '../../daemon/lifecycle-marker.js';
import { logger, summarizeError } from '../../utils/index.js';
import type { ConfigManager } from '../../config/manager.js';

/** The service manager's action-runner result, under this module's name. */
export type DaemonServiceActionResult = ManagedServiceActionResult;

/** One candidate service entry, as the platform service manager sees it. */
export interface DaemonServiceSnapshot {
  readonly serviceName: string;
  readonly platform: ManagedServiceStatus['platform'] | 'unknown';
  readonly unitPath: string;
  readonly installed: boolean;
  readonly running: boolean;
  /**
   * False on the 'manual' platform: there the service manager would spawn its
   * own locally-resolved command, which a surface cannot honestly resolve for a
   * daemon it does not own, those stay on the guidance path.
   */
  readonly startSupported: boolean;
}

export interface DaemonServiceStartResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
}

/** The narrow detector/starter seam, so tests never touch the host's services. */
export interface DaemonServiceControl {
  snapshot(): readonly DaemonServiceSnapshot[];
  start(serviceName: string): DaemonServiceStartResult;
  /** Restart a running entry onto the binary now on disk (systemd, launchd, Windows tasks). Absent on a control that can only start. */
  restart?(serviceName: string): DaemonServiceStartResult;
}

export interface DaemonServiceControlOptions {
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  /**
   * The login home the service's unit and pid file live under. Defaults to
   * {@link resolveServiceUnitHome}; never the GOODVIBES_HOME tree, which the
   * service manager does not read. Pass it only to scope the control elsewhere.
   */
  readonly homeDirectory?: string | undefined;
  /** Injectable systemctl/launchctl/schtasks runner. */
  readonly actionRunner?: ((command: string, args: readonly string[]) => DaemonServiceActionResult) | undefined;
}

/**
 * Build the detector/starter over `PlatformServiceManager`.
 *
 * The one unit is the owner's `service.serviceName` when configured, else the
 * platform's default name.
 */
export function createDaemonServiceControl(options: DaemonServiceControlOptions): DaemonServiceControl {
  const unitHome = options.homeDirectory ?? resolveServiceUnitHome();
  const configuredName = String(options.configManager.get('service.serviceName') ?? '').trim();
  const candidateNames = [configuredName || resolveDaemonServiceDefault()];
  // Pin each manager's view of `service.serviceName` to its candidate so the
  // manager's own resolution yields exactly that unit; the schema default would
  // otherwise shadow every `defaultServiceName`. Only `get` is consulted by the
  // manager, so the narrow delegate below is honest.
  const pinnedConfigView = (serviceName: string): ConfigManager => ({
    get: (key: string) => key === 'service.serviceName' ? serviceName : options.configManager.get(key as Parameters<ConfigManager['get']>[0]),
  }) as unknown as ConfigManager;
  const managers = candidateNames.map((resolvedName) => ({
    resolvedName,
    manager: new PlatformServiceManager(pinnedConfigView(resolvedName), {
      workingDirectory: options.workingDirectory,
      homeDirectory: unitHome,
      defaultServiceName: resolvedName,
      ...(options.actionRunner ? { actionRunner: options.actionRunner } : {}),
    }),
  }));

  const act = (serviceName: string, action: 'start' | 'restart'): DaemonServiceStartResult => {
    const entry = managers.find((candidate) => candidate.resolvedName === serviceName)
      ?? managers.find((candidate) => {
        try {
          return candidate.manager.status().serviceName === serviceName;
        } catch {
          return false;
        }
      });
    if (!entry) return { ok: false, error: `no service entry named "${serviceName}" is tracked on this host` };
    try {
      // The manager returns a fresh status rather than throwing; `actionError`
      // is where it records a refusal.
      const result = action === 'start' ? entry.manager.start() : entry.manager.restart();
      return result.actionError === undefined
        ? { ok: true }
        : { ok: false, error: result.actionError };
    } catch (error) {
      return { ok: false, error: summarizeError(error) };
    }
  };

  return {
    snapshot: () => {
      const seen = new Set<string>();
      const snapshots: DaemonServiceSnapshot[] = [];
      for (const { resolvedName, manager } of managers) {
        if (seen.has(resolvedName)) continue;
        seen.add(resolvedName);
        try {
          const status = manager.status();
          snapshots.push({
            serviceName: status.serviceName,
            platform: status.platform,
            unitPath: status.path,
            installed: status.installed === true,
            running: status.running === true,
            startSupported: status.platform !== 'manual',
          });
        } catch (error) {
          // A service manager that cannot answer is "no entry here", said out
          // loud. It is never a reason to fail boot.
          logger.debug('[startup] reading the daemon service entry failed', { serviceName: resolvedName, error: summarizeError(error) });
          snapshots.push({
            serviceName: resolvedName,
            platform: 'unknown',
            unitPath: '',
            installed: false,
            running: false,
            startSupported: false,
          });
        }
      }
      return snapshots;
    },
    start: (serviceName) => act(serviceName, 'start'),
    restart: (serviceName) => act(serviceName, 'restart'),
  };
}

/** Why there was nothing to do. */
export type DaemonAutostartInactionReason =
  | 'daemon-active'
  | 'port-held'
  | 'daemon-disabled'
  /** A probe verdict this policy does not recognise, never treated as recoverable. */
  | 'unrecognized-mode';

/** What the one boot-time recovery step did. */
export type DaemonAutostartOutcome =
  | { readonly action: 'none'; readonly reason: DaemonAutostartInactionReason }
  /** No service entry to start; `program: false` when the daemon program itself is not on this machine either. */
  | { readonly action: 'not-installed'; readonly program?: boolean | undefined }
  /** No service is installed, and the daemon program found here was started in the background and answers. */
  | { readonly action: 'program-started'; readonly command: string }
  /** No service is installed, and starting the daemon program found here did not bring a daemon that answers. */
  | { readonly action: 'program-start-failed'; readonly reason: string }
  | { readonly action: 'started'; readonly serviceName: string }
  | { readonly action: 'came-online'; readonly serviceName: string }
  /**
   * The service manager still reports the unit running but the daemon has not
   * answered yet: wait with {@link waitForStartingDaemon}. `since` is when this
   * start began (epoch ms); the daemon's ready record stamped at or after it is this start's.
   */
  | { readonly action: 'starting'; readonly serviceName: string; readonly since: number; readonly startedHere?: boolean | undefined }
  | { readonly action: 'start-failed'; readonly serviceName: string; readonly reason: string };

export interface DaemonAutostartOptions {
  /** The probe's verdict for the configured daemon port. */
  readonly daemonMode: string;
  readonly control: DaemonServiceControl;
  /** Is a daemon answering yet? Polled until the bounded wait runs out. */
  readonly isReachable: () => Promise<boolean>;
  readonly waitTimeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  /** Injectable so tests drive the wait loop deterministically. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * The daemon program on this machine, started when no service is installed (default {@link findDaemonProgram}; the
   * daemon's own `do` passes itself). Null: it is not here.
   */
  readonly program?: (() => DaemonProgram | null) | undefined;
  /** Starts the daemon program (default {@link startDaemonProgram}). */
  readonly startProgram?: ((program: DaemonProgram) => DaemonProgramStart) | undefined;
  /**
   * Whether the daemon program started here answers (default `isReachable`). A daemon that never ran before has
   * written no credential yet when the program began, so its answer is read without one ({@link daemonAddressAnswers}).
   */
  readonly programAnswers?: (() => Promise<boolean>) | undefined;
}

/**
 * Whether anything answers HTTP at the configured daemon's address (`/status`, any status: a daemon that refuses a
 * request without a credential still answers). Used for a daemon program this process started.
 */
export async function daemonAddressAnswers(configManager: Parameters<typeof configuredDaemonOrigin>[0]): Promise<boolean> {
  const origin = configuredDaemonOrigin(configManager);
  if (!origin) return false;
  try {
    const response = await fetch(`${origin.baseUrl}/status`, { signal: AbortSignal.timeout(2_000), redirect: 'manual' });
    await response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Whether the daemon program is on this machine ({@link findDaemonProgram}). */
export function daemonProgramInstalled(): boolean {
  try {
    return findDaemonProgram() !== null;
  } catch {
    // Unknown is not "missing": the line then names the service step, which is right if the program is there.
    return true;
  }
}

const DEFAULT_WAIT_TIMEOUT_MS = 8_000;
/** How long a daemon program started here is waited for: it opens every store before it answers. */
const PROGRAM_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 400;

/** Whether the service manager reports `serviceName` running now. */
function unitRunning(control: DaemonServiceControl, serviceName: string): boolean {
  try {
    return control.snapshot().some((entry) => entry.serviceName === serviceName && entry.running);
  } catch (error) {
    logger.debug('[startup] reading the daemon service state failed', { serviceName, error: summarizeError(error) });
    return false;
  }
}

/** What the foreground wait says once it ends unanswered: the service manager's state decides, not the time spent. */
function unansweredOutcome(control: DaemonServiceControl, serviceName: string, since: number, startedHere = false): DaemonAutostartOutcome {
  if (unitRunning(control, serviceName)) return { action: 'starting', serviceName, since, ...(startedHere ? { startedHere: true } : {}) };
  return {
    action: 'start-failed',
    serviceName,
    reason: `service "${serviceName}" stopped before the daemon answered (the service manager no longer reports it running), check its logs`,
  };
}

/** A watch on one directory's entries; `close` ends it. */
export type DirectoryWatch = (directory: string, onChange: (filename: string | null) => void, onError?: (error: unknown) => void) => { close(): void };

const watchDirectory: DirectoryWatch = (directory, onChange, onError) => {
  const watcher = watch(directory, { persistent: false }, (_event, filename) => onChange(filename === null ? null : String(filename)));
  watcher.on('error', (error) => onError?.(error));
  return { close: () => watcher.close() };
};

/** The marker as it stands, read only: an unreadable file is "not ready yet", never moved aside from under the daemon. */
function readMarkerReadOnly(markerPath: string): ReturnType<typeof readLifecycleMarker> {
  return readLifecycleMarker(markerPath, {
    read: (path) => { try { return readFileSync(path, 'utf-8'); } catch { return null; } },
    write: () => { throw new Error('the daemon lifecycle marker is read-only here'); },
  });
}

export interface WaitForStartingDaemonOptions {
  readonly control: DaemonServiceControl;
  readonly serviceName: string;
  /** The daemon's lifecycle marker (`daemonLifecycleMarkerPathForHome`). */
  readonly markerPath: string;
  /** When this start began (the `starting` outcome's `since`). */
  readonly since: number;
  /** Ends the wait (the app is shutting down); the wait then resolves `aborted`. */
  readonly signal: AbortSignal;
  /** Injectable directory watch (tests); defaults to `fs.watch`. */
  readonly watch?: DirectoryWatch | undefined;
}

/**
 * Wait for a daemon whose unit the service manager reports running but which
 * has not answered yet ({@link DaemonAutostartOutcome} `starting`), on real
 * signals only: a watch on the daemon's lifecycle marker, which the daemon
 * stamps `running` once it is fully started and accepting (`online`), and
 * which it rewrites at every start attempt, so a restart after a failed start
 * is seen; on each such change the service manager is asked once whether the
 * unit still runs (`stopped` when not). `aborted` when `signal` fires. No
 * timer and no time limit. The watch is closed on every path. Never throws.
 *
 * What it cannot see: a unit that ends without writing the marker again (it
 * died before its first start attempt and is not restarted) stays waited on
 * until `signal` fires; the app's start-up never waits on this.
 */
export function waitForStartingDaemon(options: WaitForStartingDaemonOptions): Promise<'online' | 'stopped' | 'aborted'> {
  return new Promise((resolve) => {
    let settled = false;
    let watcher: { close(): void } | null = null;
    const finish = (result: 'online' | 'stopped' | 'aborted'): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', onAbort);
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
      resolve(result);
    };
    const onAbort = (): void => finish('aborted');
    const ready = (): boolean => {
      const marker = readMarkerReadOnly(options.markerPath);
      return marker !== null && marker.state === 'running' && marker.at >= options.since;
    };
    const check = (): void => {
      if (settled) return;
      if (ready()) { finish('online'); return; }
      if (!unitRunning(options.control, options.serviceName)) finish('stopped');
    };
    if (options.signal.aborted) { finish('aborted'); return; }
    options.signal.addEventListener('abort', onAbort, { once: true });
    const directory = dirname(options.markerPath);
    const name = basename(options.markerPath);
    try {
      // The daemon creates this directory with its state; making it here only lets the watch start first.
      mkdirSync(directory, { recursive: true });
      watcher = (options.watch ?? watchDirectory)(directory, (filename) => {
        // The marker is replaced by rename from `<name>.tmp-...`, so the directory is
        // watched; some platforms name only the staging file in the event.
        if (filename === null || filename === name || filename.startsWith(`${name}.`)) check();
      }, (error) => {
        logger.warn('[startup] the daemon\'s lifecycle marker watch errored; it will connect on a later request', { error: summarizeError(error) });
        finish('aborted');
      });
    } catch (error) {
      logger.warn('[startup] the daemon\'s lifecycle marker cannot be watched; it is connected once it answers a later request', { error: summarizeError(error) });
      finish('aborted');
      return;
    }
    // A ready record written before the watch began, or a unit already gone.
    check();
  });
}

function classifyMode(daemonMode: string): DaemonAutostartInactionReason | 'recoverable' {
  switch (daemonMode) {
    case 'embedded':
    case 'external':
      // A running daemon is never restarted.
      return 'daemon-active';
    case 'blocked':
    case 'incompatible':
      // The port is held, by an unverified process or a daemon this build
      // refuses to adopt. Either way another owner may be mid-update or
      // mid-restart; never fight it.
      return 'port-held';
    case 'disabled':
      return 'daemon-disabled';
    case 'unavailable':
      return 'recoverable';
    default:
      return 'unrecognized-mode';
  }
}

/**
 * Start an installed-but-stopped daemon once, and wait a bounded time for it.
 *
 * Returns what happened rather than throwing: the caller renders it, and a
 * failure here never breaks boot. Pure over its seams, every effect goes
 * through `control` and `isReachable`.
 */
export async function autostartInstalledDaemon(options: DaemonAutostartOptions): Promise<DaemonAutostartOutcome> {
  const classification = classifyMode(options.daemonMode);
  if (classification !== 'recoverable') return { action: 'none', reason: classification };
  // A ready record the daemon stamps from here on belongs to this start.
  const since = Date.now();

  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  // Attempt-counted (not wall-clock) so an injected no-op sleep still terminates.
  const attempts = Math.max(1, Math.ceil(waitTimeoutMs / pollIntervalMs));

  const waitForAnswer = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(pollIntervalMs);
      try {
        if (await options.isReachable()) return true;
      } catch (error) {
        logger.debug('[startup] re-probing the daemon failed', { error: summarizeError(error) });
      }
    }
    return false;
  };

  const installedEntries = options.control.snapshot().filter((entry) => entry.installed);
  if (installedEntries.length === 0) {
    // No service: the daemon program on this machine is started in the background and waited for; nothing is asked.
    let program: DaemonProgram | null;
    try {
      program = (options.program ?? findDaemonProgram)();
    } catch (error) {
      logger.debug('[startup] looking for the daemon program failed', { error: summarizeError(error) });
      program = null;
    }
    if (!program) return { action: 'not-installed', program: false };
    const started = (options.startProgram ?? startDaemonProgram)(program);
    if (!started.ok) return { action: 'program-start-failed', reason: started.error };
    const programAttempts = Math.max(1, Math.ceil(Math.max(waitTimeoutMs, PROGRAM_WAIT_TIMEOUT_MS) / pollIntervalMs));
    // A start that ended may have lost the port to another program's start at the same moment: a few more probes for that one.
    let endedAt: number | undefined;
    // This wait holds the process open (a `do` has nothing else running while the daemon it started comes up).
    const holdingSleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    for (let attempt = 0; attempt < programAttempts; attempt += 1) {
      if (attempt > 0) await holdingSleep(pollIntervalMs);
      try {
        // A daemon that answers is the one asked for, whether this start or another program's at the same moment won the port.
        if (await (options.programAnswers ?? options.isReachable)()) return { action: 'program-started', command: program.command };
      } catch (error) {
        logger.debug('[startup] re-probing the daemon failed', { error: summarizeError(error) });
      }
      const code = started.exited();
      if (code !== null) endedAt ??= attempt;
      if (code !== null && endedAt !== undefined && attempt - endedAt >= 10) {
        return { action: 'program-start-failed', reason: `the daemon program ${program.command} ended (exit ${code}) before it answered; what it said is in ${started.logPath}` };
      }
    }
    return { action: 'program-start-failed', reason: `the daemon program ${program.command} was started but did not answer within ${Math.round(PROGRAM_WAIT_TIMEOUT_MS / 1000)} s; what it said is in ${started.logPath}` };
  }
  // Prefer a unit already running (wait only), then one this host can actually
  // start, and only then whatever is installed, so a machine carrying both a
  // startable unit and an unstartable one is not refused because of the latter.
  const target = installedEntries.find((entry) => entry.running)
    ?? installedEntries.find((entry) => entry.startSupported)
    ?? installedEntries[0];
  if (!target) return { action: 'not-installed' };

  if (target.running) {
    // The service manager already reports the unit active, it may be mid-start
    // or mid-restart. Wait for it, but never issue another start underneath it.
    if (await waitForAnswer()) return { action: 'came-online', serviceName: target.serviceName };
    return unansweredOutcome(options.control, target.serviceName, since);
  }

  if (!target.startSupported) {
    return {
      action: 'start-failed',
      serviceName: target.serviceName,
      reason: `service "${target.serviceName}" is installed without a service-manager entry this surface can start`,
    };
  }

  const started = options.control.start(target.serviceName);
  if (!started.ok) {
    return {
      action: 'start-failed',
      serviceName: target.serviceName,
      reason: started.error ?? 'the service manager refused the start',
    };
  }
  if (await waitForAnswer()) return { action: 'started', serviceName: target.serviceName };
  return unansweredOutcome(options.control, target.serviceName, since, true);
}

/** What a surface says when no daemon answers and no daemon service is installed to start. */
export const DAEMON_NOT_INSTALLED_NOTICE = 'No GoodVibes daemon is running and none is installed on this machine, so shared sessions, the web UI, phone access, push and the relay are off. Install and start it with: goodvibes-daemon install-service';

/** The GoodVibes installer, which puts the daemon program on this machine. */
export const GOODVIBES_INSTALLER_COMMAND = 'curl -fsSL https://goodvibes.sh/install.sh | sh';

/** What a surface says when the daemon program itself is not on this machine: the installer puts it there. */
export const DAEMON_PROGRAM_MISSING_NOTICE = `The GoodVibes daemon is not installed on this machine, so GoodVibes runs without it (no shared sessions, web UI, phone access or daemon capabilities). Install it with the GoodVibes installer: ${GOODVIBES_INSTALLER_COMMAND}`;

/** What every program says, in one line, when it started the daemon program itself. */
export const DAEMON_PROGRAM_STARTED_LINE = 'Started the GoodVibes daemon.';

/** What every program says when the daemon program it started did not answer. */
export function daemonProgramStartFailedLine(reason: string): string {
  return `The GoodVibes daemon could not be started: ${reason}.`;
}

/** The not-installed line for an outcome: the installer when the program is missing, the service step when only the service is. */
export function daemonNotInstalledNotice(outcome: { readonly program?: boolean | undefined }): string {
  return outcome.program === false ? DAEMON_PROGRAM_MISSING_NOTICE : DAEMON_NOT_INSTALLED_NOTICE;
}

/**
 * Render one autostart outcome as the line the user reads.
 *
 * Kept beside the outcome type so the wording and the states it covers cannot
 * drift apart, and so a product's boot path stays a call rather than a switch.
 */
export function describeDaemonAutostart(
  outcome: DaemonAutostartOutcome,
  adoptedAfterwards: boolean,
  adoptionFailureReason?: string | undefined,
): { readonly level: 'low' | 'high'; readonly text: string } | null {
  const suffix = adoptedAfterwards ? '' : `, but connecting to it still failed: ${adoptionFailureReason ?? 'no reason given'}`;
  switch (outcome.action) {
    case 'program-started':
      return { level: 'low', text: adoptedAfterwards ? `[Startup] ${DAEMON_PROGRAM_STARTED_LINE}` : `[Startup] Started the GoodVibes daemon${suffix}.` };
    case 'program-start-failed':
      return { level: 'high', text: `[Startup] ${daemonProgramStartFailedLine(outcome.reason)}` };
    case 'started':
      return { level: 'low', text: `[Startup] The GoodVibes daemon was stopped; GoodVibes started it${suffix}.` };
    case 'came-online':
      return { level: 'low', text: `[Startup] The GoodVibes daemon was already starting; GoodVibes connected once it answered${suffix}.` };
    case 'starting':
      return { level: 'low', text: '[Startup] The GoodVibes daemon is starting; shared sessions, the web UI, phone access and the other things that need it work once it is ready.' };
    case 'start-failed':
      return { level: 'high', text: `[Startup] The daemon is installed but not answering, and starting it did not succeed: ${outcome.reason}. Start it manually with: goodvibes service start` };
    case 'not-installed':
      // Nothing answers and nothing is installed to start: without this line
      // every daemon-backed feature would fail one at a time with no reason given.
      return { level: 'high', text: `[Startup] ${daemonNotInstalledNotice(outcome)}` };
    case 'none':
      return null;
  }
}
