/**
 * daemon-repair.ts, the Agent's one owner of "what state is the daemon on this
 * machine in, and how is it brought up".
 *
 * Three paths ask that question and all of them answer it here:
 *
 * - the boot-time autostart (bootstrap-external-services.ts), which starts an
 *   installed-but-stopped service through the platform service manager;
 * - the repair question at first render (shell/daemon-repair-prompt.ts), for a
 *   machine whose `daemon.enabled` is false while no daemon runs, where the
 *   flag stops discovery before the autostart is ever consulted;
 * - a headless run, which cannot prompt and prints the commands that repair it.
 *
 * The service query is the platform's `DaemonServiceControl`, the same one the
 * autostart uses. The repair is "set the setting, install the service if there
 * is none, then run the autostart": installing goes through the daemon's own
 * CLI (`goodvibes-daemon install-service`), because the unit must carry the
 * daemon's command line, which this process does not own; everything after
 * that is the autostart's job.
 *
 * Boundaries: the offer is made only when the flag is false AND the service is
 * stopped or absent (a false flag beside a running daemon is a deliberate
 * local-only configuration). Declining changes nothing and is remembered for
 * the session. Every step reports what it did, a partial repair included.
 * Nothing here reads or writes the terminal.
 */
import net from 'node:net';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { daemonLifecycleMarkerPathForHome } from '@goodvibes/engine/platform/platform/daemon/lifecycle-marker';
import {
  ConfigManager,
  DEFAULT_CONTROL_PLANE_PORT,
  deriveControlPlaneBaseUrl,
  parseDaemonOrigin,
  readControlPlaneBinding,
  resolveDaemonEnabled,
} from '@goodvibes/engine/platform/platform/config';
import {
  autostartInstalledDaemon,
  createDaemonServiceControl,
  waitForStartingDaemon,
  type DaemonAutostartOutcome,
  type DaemonServiceControl,
} from '@goodvibes/engine/platform/platform/runtime/client';
import {
  createDaemonCliRunner,
  installDaemonService,
  type DaemonCliRunner,
} from './daemon-cli-service.ts';

/** The setting this repair turns back on, named once so every string agrees. */
export const DAEMON_ENABLED_KEY = 'daemon.enabled';

/** The daemon CLI commands a person or an agent runs to repair a machine by hand. */
export const DAEMON_INSTALL_COMMAND = 'goodvibes-daemon install-service';
export const DAEMON_START_COMMAND = 'goodvibes-daemon start-service';

/**
 * The config surface this module needs: read the adopt flag, write it back, and
 * resolve the address the daemon is expected to answer on.
 */
export type DaemonRepairConfigKey =
  | 'daemon.enabled'
  | 'controlPlane.hostMode'
  | 'controlPlane.host'
  | 'controlPlane.port'
  | 'controlPlane.tls.mode'
  | 'controlPlane.publicBaseUrl';

export interface DaemonRepairConfig {
  get(key: DaemonRepairConfigKey): boolean | string | number | undefined;
  set(key: 'daemon.enabled', value: boolean): void;
}

/** What the daemon's service entry on this machine is doing, from the platform service manager. */
export interface DaemonServiceState {
  readonly kind: 'running' | 'installed-not-running' | 'not-installed' | 'unknown';
  /** The unit the state describes, when one is installed. */
  readonly serviceName: string | null;
}

/** The one service query: the same snapshot the boot-time autostart acts on. */
export function readDaemonServiceState(control: DaemonServiceControl): DaemonServiceState {
  const entries = control.snapshot();
  const installed = entries.filter((entry) => entry.installed);
  if (installed.length === 0) {
    // 'unknown' platform on every entry means the service manager did not
    // answer, which is not the same as "nothing is installed".
    const answered = entries.some((entry) => entry.platform !== 'unknown');
    return { kind: answered ? 'not-installed' : 'unknown', serviceName: null };
  }
  const running = installed.find((entry) => entry.running);
  if (running) return { kind: 'running', serviceName: running.serviceName };
  const target = installed.find((entry) => entry.startSupported) ?? installed[0]!;
  return { kind: 'installed-not-running', serviceName: target.serviceName };
}

/** The result of bringing the daemon up through the autostart. */
export interface DaemonBringUpResult {
  /** True only when the daemon answered afterwards (adopted, when a host controller ran it). */
  readonly answered: boolean;
  /** One line saying what happened, in the words the person reads. */
  readonly detail: string;
}

/**
 * The daemon on this machine: its service state and how to bring it up. The
 * Agent's connected-host controller implements it (bootstrap-external-services.ts),
 * so a repair re-probes and adopts the daemon in this same session.
 */
export interface DaemonHost {
  serviceState(): DaemonServiceState;
  bringUp(): Promise<DaemonBringUpResult>;
}

/**
 * A host over the platform service manager alone, for a caller with no
 * connected-host controller to hand: same query, same autostart, and a TCP
 * connect to the configured address as the proof the daemon answers.
 */
export function createStandaloneDaemonHost(options: {
  readonly config: DaemonRepairConfig;
  readonly control: DaemonServiceControl;
  readonly isReachable?: () => Promise<boolean>;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Ends the wait for a daemon still starting (the process is exiting). */
  readonly signal?: AbortSignal;
  /** The daemon's lifecycle marker (`daemonLifecycleMarkerPathForHome`), whose ready record a still-starting unit is waited on. */
  readonly markerPath: string;
}): DaemonHost {
  const isReachable = options.isReachable ?? tcpReachability(options.config);
  return {
    serviceState: () => readDaemonServiceState(options.control),
    bringUp: async () => {
      let outcome: DaemonAutostartOutcome = await autostartInstalledDaemon({
        // The caller established that nothing answers; the autostart acts only then.
        daemonMode: 'unavailable',
        control: options.control,
        isReachable,
        waitTimeoutMs: options.waitTimeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        sleep: options.sleep,
      });
      if (outcome.action === 'starting') {
        // An explicit repair waits for a unit that is still starting rather than reporting a failure.
        const serviceName = outcome.serviceName;
        const waited = await waitForStartingDaemon({
          control: options.control,
          serviceName,
          since: outcome.since,
          markerPath: options.markerPath,
          signal: options.signal ?? new AbortController().signal,
        });
        outcome = waited === 'online'
          ? { action: 'came-online', serviceName }
          : {
            action: 'start-failed',
            serviceName,
            reason: waited === 'stopped'
              ? `service "${serviceName}" stopped before the daemon answered (the service manager no longer reports it running), check its logs`
              : `stopped waiting for service "${serviceName}" to answer`,
          };
      }
      switch (outcome.action) {
        case 'started':
          return { answered: true, detail: `started the daemon service "${outcome.serviceName}" and it answers on its configured address` };
        case 'came-online':
          return { answered: true, detail: `the daemon service "${outcome.serviceName}" was already starting and now answers` };
        case 'start-failed':
          return { answered: false, detail: `${outcome.reason}; start it with: ${DAEMON_START_COMMAND}` };
        case 'not-installed':
          return { answered: false, detail: `no daemon service is installed on this machine; install it with: ${DAEMON_INSTALL_COMMAND}` };
        case 'none':
          return { answered: false, detail: `nothing was started (${outcome.reason})` };
      }
    },
  };
}

/**
 * The standalone host for a config that is a real ConfigManager (the service
 * manager reads its `service.*` settings and directories); null otherwise.
 */
function defaultDaemonHost(config: DaemonRepairConfig): DaemonHost | null {
  if (!(config instanceof ConfigManager)) return null;
  const workingDirectory = config.getWorkingDirectory();
  const homeDirectory = config.getHomeDirectory();
  if (!workingDirectory || !homeDirectory) return null;
  return createStandaloneDaemonHost({
    config,
    // The service's unit lives under the login home, not this config's tree home.
    control: createDaemonServiceControl({ configManager: config, workingDirectory }),
    markerPath: daemonLifecycleMarkerPathForHome(homeDirectory),
  });
}

/**
 * A read-only TCP connect to the address this machine's daemon answers on,
 * derived from its bind by the rule every other client dial uses.
 */
function tcpReachability(config: DaemonRepairConfig): () => Promise<boolean> {
  const origin = parseDaemonOrigin(deriveControlPlaneBaseUrl(
    readControlPlaneBinding((key) => config.get(key as DaemonRepairConfigKey)),
    'loopback',
  ));
  const host = origin?.host ?? '127.0.0.1';
  const port = origin?.port ?? DEFAULT_CONTROL_PLANE_PORT;
  return () => new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * A decline, remembered for the life of this process. Not persisted: it
 * answers "fix this machine now" about a state that is still broken, and a
 * durable "no" would turn one dismissal into permanent silence.
 */
export interface DaemonRepairSessionMemory {
  readonly declined: () => boolean;
  readonly decline: () => void;
}

export function createDaemonRepairSessionMemory(): DaemonRepairSessionMemory {
  let declined = false;
  return {
    declined: () => declined,
    decline: () => { declined = true; },
  };
}

/** The wedged state, once both halves have been confirmed. */
export interface DaemonRepairOffer {
  /** Whether a unit exists already: decides whether the repair installs one first. */
  readonly serviceInstalled: boolean;
  /** The unit name the service manager reported, when one is installed. */
  readonly serviceName: string | null;
  /** One plain line stating what is wrong. */
  readonly diagnosis: string;
  /** The offer itself, in the wording the interactive surface presents verbatim. */
  readonly offer: string;
}

export interface DaemonRepairDiagnosisOptions {
  readonly config: DaemonRepairConfig;
  readonly session: DaemonRepairSessionMemory;
  /** The daemon on this machine; defaults to the platform service manager over `config`. */
  readonly host?: DaemonHost | undefined;
}

/**
 * Decide whether this machine is in the wedged state, and say so.
 *
 * Returns null in every ordinary case. The service manager is consulted only
 * when the flag is already off, so a healthy machine pays one setting read.
 */
export function diagnoseDaemonRepair(options: DaemonRepairDiagnosisOptions): DaemonRepairOffer | null {
  if (options.session.declined()) return null;
  // `resolveDaemonEnabled` is the reader discovery uses, so this cannot
  // disagree with the thing it is diagnosing.
  if (resolveDaemonEnabled(options.config)) return null;
  const host = options.host ?? defaultDaemonHost(options.config);
  if (!host) return null;

  let state: DaemonServiceState;
  try {
    state = host.serviceState();
  } catch (error) {
    logger.debug('[daemon-repair] reading the daemon service entry failed', { error: summarizeError(error) });
    return null;
  }
  // 'running' is a deliberate local-only configuration; 'unknown' is an
  // unanswered question, and an offer built on a guess is a wrong offer.
  if (state.kind !== 'installed-not-running' && state.kind !== 'not-installed') return null;

  const serviceInstalled = state.kind === 'installed-not-running';
  const named = state.serviceName ? ` "${state.serviceName}"` : '';
  const diagnosis = serviceInstalled
    ? `This machine cannot reach a GoodVibes daemon: its service${named} is installed but stopped, and this Agent's ${DAEMON_ENABLED_KEY} setting is false, which stops it from even looking.`
    : `This machine cannot reach a GoodVibes daemon: no daemon service is installed here, and this Agent's ${DAEMON_ENABLED_KEY} setting is false, which stops it from even looking.`;
  const offer = serviceInstalled
    ? `Choose "Start the daemon" in the question to set ${DAEMON_ENABLED_KEY} to true, start the daemon service, and connect to it; "Leave it as it is" or Escape changes nothing.`
    : `Choose "Install and start the daemon" in the question to set ${DAEMON_ENABLED_KEY} to true, install and start the daemon service, and connect to it; "Leave it as it is" or Escape changes nothing.`;

  return { serviceInstalled, serviceName: state.serviceName, diagnosis, offer };
}

/** What a repair actually did, step by step, in the order it did it. */
export interface DaemonRepairResult {
  /** True only when the daemon answered afterwards. */
  readonly repaired: boolean;
  /** One line per step performed, in the order things happened. */
  readonly steps: readonly string[];
  /** The single line a surface shows the user. */
  readonly summary: string;
}

export interface DaemonRepairRunOptions {
  readonly config: DaemonRepairConfig;
  readonly offer: DaemonRepairOffer;
  /** The daemon on this machine; defaults to the platform service manager over `config`. */
  readonly host?: DaemonHost | undefined;
  /** Runs the daemon's own CLI for the install step; injectable so a test never spawns it. */
  readonly runDaemonCli?: DaemonCliRunner | undefined;
  /** Receipt sink; defaults to the activity log. */
  readonly recordReceipt?: (text: string) => void;
}

/**
 * Perform the repair the user confirmed: set the setting, install the service
 * when there is none, then run the autostart. Never throws; everything that
 * goes wrong comes back as a step that says so.
 */
export async function runDaemonRepair(options: DaemonRepairRunOptions): Promise<DaemonRepairResult> {
  const { config, offer } = options;
  const steps: string[] = [];
  const recordReceipt = options.recordReceipt ?? ((text: string) => { logger.info(text); });
  const finish = (repaired: boolean, summary: string): DaemonRepairResult => {
    recordReceipt(`${summary} Steps: ${steps.join('; ')}`);
    return { repaired, steps, summary };
  };

  // The setting first and on its own: it is the half that silenced discovery,
  // and it survives a failed service step, so the next launch's ordinary
  // autostart can finish the job without asking anything.
  try {
    config.set(DAEMON_ENABLED_KEY, true);
    steps.push(`set ${DAEMON_ENABLED_KEY} to true (it was false, which stopped this Agent from looking for a daemon at all)`);
  } catch (error) {
    const reason = summarizeError(error);
    steps.push(`could not set ${DAEMON_ENABLED_KEY} to true: ${reason}`);
    return finish(false, `[Daemon] Repair could not start: the setting "Use the background daemon" could not be saved (${reason}). Nothing was changed.`);
  }

  if (!offer.serviceInstalled) {
    const installed = await installDaemonService(options.runDaemonCli ?? createDaemonCliRunner());
    if (!installed.ok) {
      steps.push(`could not install the daemon service: ${installed.detail}`);
      return finish(false, `[Daemon] Not repaired: "Use the background daemon" is now on, but the daemon service could not be installed (${installed.detail}). Install it with: ${DAEMON_INSTALL_COMMAND}`);
    }
    steps.push(`installed the daemon service through goodvibes-daemon (${installed.detail})`);
  }

  const host = options.host ?? defaultDaemonHost(config);
  if (!host) {
    steps.push('could not reach the service manager from this process');
    return finish(false, `[Daemon] Partly repaired: "Use the background daemon" is now on. Start the daemon with: ${DAEMON_START_COMMAND}`);
  }
  let brought: DaemonBringUpResult;
  try {
    brought = await host.bringUp();
  } catch (error) {
    brought = { answered: false, detail: summarizeError(error) };
  }
  steps.push(brought.detail);
  return brought.answered
    ? finish(true, `[Daemon] Repaired: "Use the background daemon" is on and the daemon answers. ${steps.length} steps recorded in the activity log.`)
    : finish(false, `[Daemon] Partly repaired: "Use the background daemon" is now on, but the daemon is not answering yet: ${brought.detail}. The Agent tries again at the next launch.`);
}

/**
 * The lines a headless run writes to stderr for a wedged machine. Run mode
 * never prompts, so it names the commands that repair the machine, which a
 * person or an agent can run as they are.
 */
export function describeDaemonRepairForHeadless(offer: DaemonRepairOffer): readonly string[] {
  const serviceStep = offer.serviceInstalled ? DAEMON_START_COMMAND : DAEMON_INSTALL_COMMAND;
  return [
    `[Daemon] ${offer.diagnosis}`,
    `[Daemon] To repair: run \`${serviceStep}\`, then set ${DAEMON_ENABLED_KEY} to true in the Agent's settings (or pass \`-c ${DAEMON_ENABLED_KEY}=true\` for one run).`,
  ];
}
