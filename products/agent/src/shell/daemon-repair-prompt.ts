/**
 * daemon-repair-prompt.ts, the interactive half of the daemon repair: one
 * question at boot, asked as a selection modal, and the platform does the rest.
 *
 * The policy, the diagnosis and every effect live in runtime/daemon-repair.ts.
 * This module is only the terminal-facing shape of it: the question, the
 * "waiting for an answer" state, and a message on the router for each outcome.
 *
 * The question is a modal for the reason the workspace question is one
 * (shell/workspace-registration-question.ts): it is drawn where the owner is
 * looking and receives only the keys aimed at it, so a sentence typed into the
 * composer, a paste or a focus report from the terminal is never its answer.
 * The default is "leave it as it is"; Escape declines.
 */
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import {
  DAEMON_ENABLED_KEY,
  runDaemonRepair,
  type DaemonHost,
  type DaemonRepairConfig,
  type DaemonRepairOffer,
  type DaemonRepairResult,
  type DaemonRepairSessionMemory,
} from '../runtime/daemon-repair.ts';
import type { NoticeLevel } from '@goodvibes/engine/platform/platform/core';
import type { DaemonCliRunner } from '../runtime/daemon-cli-service.ts';
import type { SelectionItem } from '../input/selection-modal.ts';
import type { SelectionOpener } from './workspace-registration-question.ts';

export const DAEMON_REPAIR_QUESTION = 'Repair the daemon connection?';

/** Opens the repair question for `offer`; `answer` is called once, true for repair. */
export type AskDaemonRepair = (offer: DaemonRepairOffer, answer: (accepted: boolean) => void) => void;

export function daemonRepairItems(offer: DaemonRepairOffer): SelectionItem[] {
  return [
    {
      id: 'repair',
      label: offer.serviceInstalled ? 'Start the daemon' : 'Install and start the daemon',
      detail: `sets ${DAEMON_ENABLED_KEY} to true, ${offer.serviceInstalled ? 'starts the daemon service' : 'installs and starts the daemon service'}, then connects`,
    },
    { id: 'leave', label: 'Leave it as it is', detail: "nothing is changed; not asked again this session" },
  ];
}

/** The question on the input handler's selection modal. Escape or closing it declines. */
export function createDaemonRepairQuestion(opener: SelectionOpener): AskDaemonRepair {
  return (offer, answer) => {
    opener.openSelection(DAEMON_REPAIR_QUESTION, daemonRepairItems(offer), { preSelectId: 'leave', allowSearch: false }, (result) => {
      answer(result?.item.id === 'repair');
    });
  };
}

/** What the shell asks of the open question. */
export interface DaemonRepairPrompt {
  /** True while the question is on screen awaiting the owner's answer. */
  readonly pending: () => boolean;
}

export interface DaemonRepairPromptOptions {
  readonly offer: DaemonRepairOffer;
  readonly config: DaemonRepairConfig;
  readonly session: DaemonRepairSessionMemory;
  readonly systemMessageRouter: { high(message: string, level?: NoticeLevel): void; userAction(message: string, level?: NoticeLevel): void };
  readonly render: () => void;
  /** Shows the question (the shell passes {@link createDaemonRepairQuestion} over its selection modal). */
  readonly ask: AskDaemonRepair;
  /**
   * The daemon on this machine. Pass the connected-host controller's `daemon`
   * so an accepted repair adopts the daemon in this session; without it the
   * repair uses the platform service manager over `config`.
   */
  readonly host?: DaemonHost | undefined;
  /** Runs the daemon's own CLI for the install step; injectable so a test never spawns it. */
  readonly runDaemonCli?: DaemonCliRunner | undefined;
  /**
   * Injectable repair, so a test drives accept/decline without touching a
   * service manager or a socket. Defaults to the real one.
   */
  readonly repair?: ((offer: DaemonRepairOffer) => Promise<DaemonRepairResult>) | undefined;
}

export function createDaemonRepairPrompt(options: DaemonRepairPromptOptions): DaemonRepairPrompt {
  const { offer, config, session, systemMessageRouter, render } = options;
  let awaitingAnswer = true;

  const repair = options.repair ?? ((pending: DaemonRepairOffer) => runDaemonRepair({
    config,
    offer: pending,
    host: options.host,
    runDaemonCli: options.runDaemonCli,
  }));

  options.ask(offer, (accepted) => {
    if (!awaitingAnswer) return;
    awaitingAnswer = false;
    if (!accepted) {
      // A decline changes nothing at all, not the setting, not the service,
      // and is remembered for the rest of the session so it is never re-asked.
      session.decline();
      systemMessageRouter.userAction(`[Daemon] Left as it is, nothing was changed. Set ${DAEMON_ENABLED_KEY} to true in settings whenever you want this machine to reach the platform again.`);
      render();
      return;
    }

    systemMessageRouter.userAction(offer.serviceInstalled
      ? '[Daemon] Starting the daemon service and connecting to it...'
      : '[Daemon] Installing and starting the daemon service, then connecting to it...');
    render();

    // Not awaited: the repair waits for the service manager and the daemon,
    // and the CLI runs as a child process, so the screen keeps painting. Each
    // outcome lands on the router when it happens; runDaemonRepair never
    // throws, so the catch below only keeps a defect from becoming an
    // unhandled rejection.
    void repair(offer)
      .then((result) => {
        systemMessageRouter.userAction(result.summary, result.repaired ? 'success' : 'error');
        for (const step of result.steps) systemMessageRouter.high(`[Daemon]   - ${step}`);
        render();
      })
      .catch((error: unknown) => {
        logger.error('[daemon-repair] the repair failed unexpectedly', { error: summarizeError(error) });
        systemMessageRouter.high(`[Daemon] The repair did not complete: ${summarizeError(error)}`, 'error');
        render();
      });
  });
  return { pending: () => awaitingAnswer };
}
