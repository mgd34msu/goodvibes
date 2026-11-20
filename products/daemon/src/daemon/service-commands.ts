/**
 * Service-lifecycle subcommands, `goodvibes-daemon install-service |
 * refresh-service | uninstall-service | service-status | start-service |
 * stop-service | restart-service`.
 *
 * The daemon is the one writer of its service definition: the release
 * installer (scripts/install.sh) runs `install-service` on a first install and
 * `refresh-service` on an upgrade, and asks `service-status --json` for the
 * unit's name, path and whether the definition there is this product's. None
 * of these commands writes over, or removes, a definition this product did not
 * write (exit 5).
 *
 * The daemon is a SYSTEM SERVICE. These subcommands install it as a durable host
 * service (systemd user unit on Linux, launchd agent on macOS, a Scheduled Task
 * on Windows) so N surfaces share ONE daemon that starts on its own at login (at boot with lingering), instead of
 * every surface spawning a session-scoped daemon.
 *
 * Drift note: the platform's older `systemd-user-service.ts` (a Linux-only,
 * bespoke systemd shim) was dead code and got deleted from the platform. The platform's
 * REAL wired service machinery, reached in production by the daemon's own HTTP
 * `/api/service/*` routes via facade-composition.ts, is
 * `PlatformServiceManager` (`@goodvibes-jev/engine/platform/platform/daemon`): a single
 * systemd/launchd/windows-aware manager with install/uninstall/status/start/
 * stop/restart and a `suggestedCommands` hint list. This module now rewires the
 * three CLI subcommands onto that manager instead of the deleted shim.
 *
 * `install()` only WRITES the unit/plist/task; it does not enable or start it,
 * so `install-service` calls `install()` then `start()` and exits 3 (installed,
 * not running) when the start did not leave the daemon running. `uninstall()`
 * stops, unregisters (`systemctl --user disable --now`, `launchctl bootout`,
 * `schtasks /End` + `/Delete`), removes the file and reloads, so
 * `uninstall-service` calls it once.
 */

import { copyFileSync } from 'node:fs';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { PlatformServiceManager, type ManagedServiceStatus } from '@goodvibes-jev/engine/platform/platform/daemon';
import {
  buildManagedDaemonServiceManager,
  readDefinitionWorkingDirectory,
  readManagedDefinitionOwner,
  type ManagedDefinitionOwner,
  type ManagedServiceActionRunner,
} from '../runtime/managed-daemon-service.js';

// `resolveInstalledDaemonBinary` lives in the runtime module, re-exported
// here so this module stays the CLI's stable public surface (and so existing
// test imports keep working).
export {
  resolveInstalledDaemonBinary,
  type ResolveDaemonBinaryOptions,
} from '../runtime/managed-daemon-service.js';
export type { ManagedServiceActionRunner } from '../runtime/managed-daemon-service.js';

export const DAEMON_SERVICE_SUBCOMMANDS = [
  'install-service',
  'refresh-service',
  'uninstall-service',
  'service-status',
  'start-service',
  'stop-service',
  'restart-service',
] as const;

export type DaemonServiceSubcommand = (typeof DAEMON_SERVICE_SUBCOMMANDS)[number];

export function isDaemonServiceSubcommand(value: string | undefined): value is DaemonServiceSubcommand {
  return typeof value === 'string' && (DAEMON_SERVICE_SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * Exit codes `service-status` reports, so a script never parses prose.
 *
 * 0/3/4 are the three answers the question actually has; 1 stays what it has
 * always been, the platform refused the query and the error is printed.
 */
export const SERVICE_STATUS_EXIT_RUNNING = 0;
export const SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING = 3;
export const SERVICE_STATUS_EXIT_NOT_INSTALLED = 4;
/**
 * `install-service`, `refresh-service` and `uninstall-service`: a definition
 * this product did not write is at the service's path, so nothing was changed.
 */
export const SERVICE_EXIT_NOT_OURS = 5;

export interface DaemonServiceCliInput {
  readonly subcommand: DaemonServiceSubcommand;
  readonly binaryPath: string;
  /** Retained native executable restriction; never grants service activation. */
  readonly assertCurrent?: () => void;
  /** The GoodVibes tree home (GOODVIBES_HOME-overridable), config/state root only, never unit-path resolution. See `unitHomeDir`. */
  readonly homeDir: string;
  /** Selected daemon identity/settings directory, already resolved by the CLI. */
  readonly daemonHomeDirectory?: string | undefined;
  /** A relocated invocation may activate only its matching installed definition. */
  readonly requireInstalledDefinitionMatch?: boolean | undefined;
  /**
   * The LOGIN user's home, where the systemd/launchd/Windows unit actually
   * lives, regardless of any GOODVIBES_HOME/GOODVIBES_DAEMON_HOME override.
   * Required (no default to `homeDir`) so a unit-management subcommand can
   * never silently search for its unit under a relocated tree home instead of
   * where the service manager actually looks.
   */
  readonly unitHomeDir: string;
  /** Defaults to `homeDir`, overridable so tests can scope both to one tempdir. */
  readonly workingDirectory?: string | undefined;
  /**
   * The working directory was named for this command (`--working-dir`,
   * GOODVIBES_WORKING_DIR). Otherwise `refresh-service` keeps the one the
   * existing definition names: a refresh re-derives the launch, not the
   * workspace the owner chose.
   */
  readonly workingDirectoryExplicit?: boolean | undefined;
  /** Injected in tests; a real `ConfigManager` rooted at `homeDir` otherwise. */
  readonly configManager?: ConfigManager | undefined;
  /** Injectable systemctl/launchctl/schtasks runner so tests never touch the host. */
  readonly actionRunner?: ManagedServiceActionRunner | undefined;
  /**
   * `service-status` only: report one JSON document instead of prose. The exit
   * code is the same either way, the codes are the machine-readable answer,
   * and JSON is for when a script wants the fields as well.
   */
  readonly json?: boolean | undefined;
}

export interface DaemonServiceCliResult {
  readonly ok: boolean;
  readonly exitCode: number;
  /** Honest, human-readable stdout lines describing exactly what happened. */
  readonly lines: readonly string[];
  /** Last confirmed observation; an incomplete receipt identifies when this predates the failed action. */
  readonly status: ManagedServiceStatus;
}

/**
 * The manager's definition (`ExecStart` command/args, name, description) is
 * built once, in `../runtime/managed-daemon-service.ts`, and shared with the
 * terminal app's onboarding.
 */
function buildManager(input: DaemonServiceCliInput): PlatformServiceManager {
  return buildManagedDaemonServiceManager({
    binaryPath: input.binaryPath,
    homeDir: input.homeDir,
    daemonHomeDirectory: input.daemonHomeDirectory,
    unitHomeDir: input.unitHomeDir,
    workingDirectory: input.workingDirectory,
    configManager: input.configManager,
    actionRunner: input.actionRunner,
    assertCurrent: input.assertCurrent,
  });
}

function statusLines(status: ManagedServiceStatus): string[] {
  const lines = [
    `platform: ${status.platform}`,
    `installed: ${status.installed}`,
    `running: ${status.running}`,
    `unit path: ${status.path}`,
  ];
  if (status.pid !== undefined) lines.push(`pid: ${status.pid}`);
  if (status.platform !== 'manual' && status.installed && !status.running) {
    // W3 Finding 4: this used to assert "'running' here only reflects
    // processes this tool started directly", true for the pid-file-only
    // check the (currently linked) platform still uses, but the parallel platform
    // batch is making status().running query systemd honestly via
    // `is-active`, which would make that specific claim stale. Drop the
    // claim about HOW running was computed and just offer the escape
    // hatch, true and useful under either platform version.
    lines.push(
      `note: if this looks wrong, verify directly: ${status.suggestedCommands[status.suggestedCommands.length - 1] ?? 'the platform service-status command'}`,
    );
  }
  return lines;
}

/**
 * Build the install-branch's result lines. Exported for direct unit
 * coverage: the "suggested follow-ups" block is gated on the actual
 * not-started case (W3 Finding 4 friction fix) rather than printed
 * unconditionally, and driving that through the full
 * PlatformServiceManager/systemd integration can't reliably produce
 * `running: true` under the (currently linked) platform build, whose systemd
 * status check is still pid-file-only (see the honesty note above).
 */
export function buildInstallResultLines(status: ManagedServiceStatus): string[] {
  const lines = [`installed the ${status.platform} service at ${status.path}`];
  if (status.running) {
    lines.push('service is enabled and running');
  } else {
    lines.push('suggested follow-ups if it did not start automatically:');
    for (const cmd of status.suggestedCommands) lines.push(`  ${cmd}`);
  }
  return lines;
}

/**
 * The receipt for `start-service` / `stop-service` / `restart-service`.
 *
 * Every line names the RESOLVED unit (`status.serviceName`, `status.path`) and
 * says what the platform reported afterwards, rather than asserting the verb
 * worked because it was dispatched without throwing. A verb aimed at a service
 * that is not installed says exactly that, installing it silently would be a
 * different command than the one that was run.
 */
export function buildLifecycleResultLines(
  action: 'start' | 'stop' | 'restart',
  status: ManagedServiceStatus,
): string[] {
  if (!status.installed) {
    return [
      `no ${status.platform} service is installed at ${status.path}, so there is nothing to ${action}.`,
      `install it first:  goodvibes-daemon install-service`,
    ];
  }
  const past = action === 'stop' ? 'stopped' : `${action}ed`;
  const lines = [`${past} the ${status.platform} service ${status.serviceName} (${status.path})`];
  lines.push(status.running ? 'it is running' : 'it is not running');
  if (action !== 'stop' && !status.running) {
    lines.push('suggested follow-ups:');
    for (const cmd of status.suggestedCommands) lines.push(`  ${cmd}`);
  }
  return lines;
}

/**
 * Run one of start / stop / restart against the managed service.
 *
 * The installed check happens BEFORE the platform verb is dispatched, not
 * after: `systemctl --user enable --now <unit>.service` against a unit that
 * does not exist fails with systemd's own wording, which reads like a broken
 * service rather than an absent one. Exit 4 is the same "not installed" answer
 * `service-status` gives, so a script reading one reads the other.
 */
function runLifecycleVerb(
  action: 'start' | 'stop' | 'restart',
  manager: PlatformServiceManager,
  requireInstalledDefinitionMatch = false,
): DaemonServiceCliResult {
  const before = manager.status();
  if (!before.installed) {
    return {
      ok: false,
      exitCode: SERVICE_STATUS_EXIT_NOT_INSTALLED,
      lines: buildLifecycleResultLines(action, before),
      status: before,
    };
  }
  if (action !== 'stop' && requireInstalledDefinitionMatch && !manager.installedDefinitionMatches()) {
    return { ok: false, exitCode: 1, status: before,
      lines: ['Service activation refused: the installed definition does not match the selected executable, tree, daemon home and workspace. No service was changed.'] };
  }
  const status = action === 'start'
    ? manager.start()
    : action === 'stop'
      ? manager.stop()
      : manager.restart();
  if (status.actionError) {
    return {
      ok: false,
      exitCode: 1,
      lines: [`service ${action} failed: ${status.actionError}`],
      status,
    };
  }
  return { ok: true, exitCode: 0, lines: buildLifecycleResultLines(action, status), status };
}

/** The honest 0/3/4 answer to "is the service installed, and is it running?". */
export function serviceStatusExitCode(status: ManagedServiceStatus): number {
  if (!status.installed) return SERVICE_STATUS_EXIT_NOT_INSTALLED;
  return status.running ? SERVICE_STATUS_EXIT_RUNNING : SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING;
}

/**
 * The `--json` document for `service-status`: the status fields, who wrote the
 * definition at `path` (`definitionOwner`, see `ManagedDefinitionOwner`) when
 * known, plus the code.
 */
export function serviceStatusJson(status: ManagedServiceStatus, owner?: ManagedDefinitionOwner): string {
  return JSON.stringify(
    {
      ok: true,
      data: {
        platform: status.platform,
        serviceName: status.serviceName,
        path: status.path,
        ...(owner === undefined ? {} : { definitionOwner: owner }),
        installed: status.installed,
        running: status.running,
        autostart: status.autostart,
        ...(status.pid === undefined ? {} : { pid: status.pid }),
        ...(status.logPath === undefined ? {} : { logPath: status.logPath }),
        ...(status.lingerNote === undefined ? {} : { lingerNote: status.lingerNote }),
        suggestedCommands: status.suggestedCommands,
        exitCode: serviceStatusExitCode(status),
      },
    },
    null,
    2,
  );
}

function ok(action: 'install' | 'uninstall' | 'status', status: ManagedServiceStatus, extra: string[] = []): DaemonServiceCliResult {
  const lines: string[] = [];
  if (action === 'install') {
    lines.push(...buildInstallResultLines(status));
  } else if (action === 'uninstall') {
    lines.push(`stopped and removed the ${status.platform} service ${status.serviceName} (${status.path})`);
  } else {
    lines.push(...statusLines(status));
  }
  lines.push(...extra);
  return { ok: true, exitCode: 0, lines, status };
}

function failed(action: 'install' | 'refresh' | 'uninstall' | 'status', status: ManagedServiceStatus): DaemonServiceCliResult {
  return {
    ok: false,
    exitCode: 1,
    lines: [`service ${action} failed: ${status.actionError ?? 'unknown error'}`],
    status,
  };
}

/**
 * The refusal for a definition this product did not write (or could not read):
 * nothing is written over or removed, and the receipt says how to hand the path
 * to the daemon.
 */
function notOurs(action: 'install' | 'refresh' | 'uninstall', owner: 'other' | 'unreadable', status: ManagedServiceStatus): DaemonServiceCliResult {
  if (owner === 'unreadable') {
    return { ok: false, exitCode: 1, status, lines: [`service ${action} failed: ${status.path} could not be read, so nothing was changed.`] };
  }
  return {
    ok: false,
    exitCode: SERVICE_EXIT_NOT_OURS,
    status,
    lines: [
      `${status.path} is a ${status.platform} service definition GoodVibes did not write (or a link to one), so it was left as it is and nothing was ${action === 'uninstall' ? 'removed' : 'written'}.`,
      action === 'uninstall'
        ? 'Remove it yourself if it is no longer wanted.'
        : `To let goodvibes-daemon manage the service, move that file aside and run goodvibes-daemon ${action}-service again.`,
    ],
  };
}

/**
 * Who wrote the definition at the status's path. The Windows task and manual
 * definitions live in the service's own state directory, which nothing else
 * writes; a systemd unit or LaunchAgent is read (see `readManagedDefinitionOwner`).
 */
function definitionOwner(status: ManagedServiceStatus): ManagedDefinitionOwner {
  if (status.platform !== 'systemd' && status.platform !== 'launchd') return status.installed ? 'product' : 'absent';
  return readManagedDefinitionOwner(status.path);
}

/** `<path>.bak.<YYYYMMDDHHMMSS>`: a rewrite never destroys the previous content, which may hold the owner's own edits. */
function backupDefinition(path: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = `${path}.bak.${stamp}`;
  copyFileSync(path, backup);
  return backup;
}

/**
 * `refresh-service`: write the current definition over this product's own
 * (or where none exists), without starting, stopping or changing lingering.
 * An existing definition that already matches is left untouched; a rewritten
 * one is backed up first and keeps the working directory it named.
 */
function refreshService(input: DaemonServiceCliInput, initial: PlatformServiceManager): DaemonServiceCliResult {
  const before = initial.status();
  const owner = definitionOwner(before);
  if (owner === 'other' || owner === 'unreadable') return notOurs('refresh', owner, before);
  const kept = owner === 'product' && input.workingDirectoryExplicit !== true ? readDefinitionWorkingDirectory(before.path) : undefined;
  const manager = kept === undefined || kept === (input.workingDirectory ?? input.homeDir)
    ? initial
    : buildManager({ ...input, workingDirectory: kept });
  if (owner === 'product' && manager.installedDefinitionMatches()) {
    return { ok: true, exitCode: 0, status: before,
      lines: [`the ${before.platform} service definition at ${before.path} is already current; nothing was changed.`] };
  }
  let backup: string | undefined;
  if (owner === 'product') {
    try {
      backup = backupDefinition(before.path);
    } catch (error) {
      return { ok: false, exitCode: 1, status: before,
        lines: [`service refresh failed: ${before.path} could not be backed up (${error instanceof Error ? error.message : String(error)}), so it was not rewritten.`] };
    }
  }
  const written = manager.refresh();
  const wrote = backup === undefined
    ? `wrote the ${written.platform} service definition at ${written.path} (not started)`
    : `rewrote ${written.path} with the current launch; the previous file is kept at ${backup}`;
  if (written.actionError) {
    return { ok: false, exitCode: 1, status: written, lines: [wrote, `service refresh failed: ${written.actionError}`] };
  }
  const lines = [wrote];
  if (before.running) {
    lines.push(`the running service keeps its previous launch until it restarts: goodvibes-daemon restart-service`);
  }
  return { ok: true, exitCode: 0, status: written, lines };
}

/** Dispatch a daemon service subcommand to the platform's `PlatformServiceManager`. */
export async function runDaemonServiceCli(input: DaemonServiceCliInput): Promise<DaemonServiceCliResult> {
  input.assertCurrent?.();
  const manager = buildManager(input);
  switch (input.subcommand) {
    case 'install-service': {
      const existing = manager.status();
      const owner = definitionOwner(existing);
      if (owner === 'other' || owner === 'unreadable') return notOurs('install', owner, existing);
      const installed = manager.install();
      if (installed.actionError) return failed('install', installed);
      const started = manager.start();
      // A failed start does not undo the write. The unit is installed, but a
      // script must not treat a daemon that is down as installed and started:
      // exit 3 is the same "installed, not running" answer service-status gives.
      // Whether lingering was enabled decides "starts at boot" versus "at login"; the install says which.
      const linger = installed.lingerNote === undefined ? [] : [installed.lingerNote];
      const result = started.actionError
        ? ok('install', { ...started, running: false }, [`could not start it automatically: ${started.actionError}`, ...linger])
        : ok('install', started, linger);
      return result.status.running ? result : { ...result, ok: false, exitCode: SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING };
    }
    case 'refresh-service':
      return refreshService(input, manager);
    case 'uninstall-service': {
      const before = manager.status();
      if (before.actionError) return failed('uninstall', before);
      const owner = definitionOwner(before);
      if (owner === 'other' || owner === 'unreadable') return notOurs('uninstall', owner, before);
      if (!before.installed) {
        return {
          ok: false,
          exitCode: SERVICE_STATUS_EXIT_NOT_INSTALLED,
          lines: [
            `no ${before.platform} service is installed at ${before.path}, so there is nothing to uninstall.`,
          ],
          status: before,
        };
      }
      // uninstall() stops and unregisters the service before it removes the file.
      let uninstalled: ManagedServiceStatus;
      try {
        uninstalled = manager.uninstall();
      } catch {
        return {
          ...failed('uninstall', before),
          lines: [
            'service uninstall incomplete: removal or final status could not be confirmed; removal may already have happened. Run goodvibes-daemon service-status before retrying.',
            'last confirmed state before removal:',
            ...statusLines(before),
          ],
        };
      }
      if (uninstalled.actionError !== undefined || uninstalled.installed || uninstalled.running) {
        return failed('uninstall', {
          ...uninstalled,
          actionError: uninstalled.actionError || 'removal is incomplete: the platform still reports an installed or running service',
        });
      }
      return ok('uninstall', uninstalled);
    }
    case 'start-service':
      return runLifecycleVerb('start', manager, input.requireInstalledDefinitionMatch);
    case 'stop-service':
      return runLifecycleVerb('stop', manager);
    case 'restart-service':
      return runLifecycleVerb('restart', manager, input.requireInstalledDefinitionMatch);
    case 'service-status': {
      const status = manager.status();
      if (status.actionError) return failed('status', status);
      const owner = definitionOwner(status);
      if (input.json) {
        return {
          ok: true,
          exitCode: serviceStatusExitCode(status),
          lines: [serviceStatusJson(status, owner)],
          status,
        };
      }
      const result = ok('status', status, status.installed
        ? [`definition: ${owner === 'product' ? 'written by GoodVibes' : owner === 'other' ? 'not written by GoodVibes (the service commands leave it as it is)' : 'unreadable'}`]
        : []);
      // The status verb reports; it does not fail. `ok` is still true, the
      // question was answered, while the exit code carries the answer itself
      // (0 running / 3 installed-not-running / 4 not installed), so a script
      // never has to read the prose above.
      return { ...result, exitCode: serviceStatusExitCode(status) };
    }
  }
}
