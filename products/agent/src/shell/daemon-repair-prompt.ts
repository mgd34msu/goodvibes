/**
 * daemon-repair-prompt.ts, the interactive half of the daemon repair: nothing
 * is asked. A machine whose Agent cannot reach the daemon on this computer
 * (runtime/daemon-repair.ts diagnoseDaemonRepair: "Use the background daemon"
 * off and its service stopped or absent) is repaired at once, as the boot-time
 * autostart starts a stopped daemon, and the person is told in one line what
 * was done; when it cannot be done, the line says why and what to do.
 *
 * The policy, the diagnosis and every effect live in runtime/daemon-repair.ts.
 */
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import {
  runDaemonRepair,
  type DaemonHost,
  type DaemonRepairConfig,
  type DaemonRepairOffer,
  type DaemonRepairResult,
} from '../runtime/daemon-repair.ts';
import type { NoticeLevel } from '@goodvibes/engine/platform/platform/core';
import type { DaemonCliRunner } from '../runtime/daemon-cli-service.ts';

export interface DaemonRepairOptions {
  readonly offer: DaemonRepairOffer;
  readonly config: DaemonRepairConfig;
  readonly systemMessageRouter: { userAction(message: string, level?: NoticeLevel): void };
  readonly render: () => void;
  /**
   * The daemon on this machine. Pass the connected-host controller's `daemon`
   * so the repair adopts the daemon in this session; without it the repair
   * uses the platform service manager over `config`.
   */
  readonly host?: DaemonHost | undefined;
  /** Runs the daemon's own CLI for the install step. */
  readonly runDaemonCli?: DaemonCliRunner | undefined;
  /** The repair itself; defaults to the real one. */
  readonly repair?: ((offer: DaemonRepairOffer) => Promise<DaemonRepairResult>) | undefined;
}

/**
 * Repair the connection now and say what was done in one line (each step is in
 * the activity log). Not
 * awaited by the caller: the repair waits for the service manager and the
 * daemon, so the screen keeps painting; runDaemonRepair never throws, and the
 * catch keeps a defect from becoming an unhandled rejection.
 */
export function repairDaemonConnection(options: DaemonRepairOptions): void {
  const { offer, config, systemMessageRouter, render } = options;
  const repair = options.repair ?? ((pending: DaemonRepairOffer) => runDaemonRepair({
    config,
    offer: pending,
    host: options.host,
    runDaemonCli: options.runDaemonCli,
  }));
  void repair(offer)
    .then((result) => {
      systemMessageRouter.userAction(result.summary, result.repaired ? 'success' : 'error');
      render();
    })
    .catch((error: unknown) => {
      logger.error('[daemon-repair] the repair failed unexpectedly', { error: summarizeError(error) });
      systemMessageRouter.userAction(`[Daemon] The connection to the daemon on this computer was not repaired: ${summarizeError(error)}. Start the daemon with: goodvibes-daemon start-service`, 'error');
      render();
    });
}
