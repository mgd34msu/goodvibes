import { readRefusal } from '@goodvibes/engine/errors';
import { describeFatalFailure } from '@goodvibes/engine/platform/platform/daemon/fatal-boot-report';

/** The next step a failed command names, in the prose and in the --json envelope's `fix`. */
export const DAEMON_COMMAND_FAILURE_NEXT_STEP = 'run goodvibes-daemon status, or see the daemon log';

/**
 * The command as the person typed it, for the failure's first line: the
 * program, the command and, when it is a plain word, its subcommand
 * (`goodvibes-daemon webui enable`). No other argument is repeated: one can
 * hold a token or a setting's value.
 */
export function daemonCommandWords(command: string | undefined, args: readonly string[] = []): string {
  if (!command) return 'goodvibes-daemon';
  const sub = args[0];
  return sub !== undefined && /^[a-z][a-z-]{0,23}$/.test(sub) ? `goodvibes-daemon ${command} ${sub}` : `goodvibes-daemon ${command}`;
}

/**
 * Lines printed when a command throws: what failed (the command the person
 * ran), its reason through the same masking pass as a failed start (each link
 * of its cause chain with tokens, keys and pairing links masked, its
 * errno-style code such as EADDRINUSE or EACCES), then the next step. A failure
 * that carries a refusal gives the refusal's code with the reason.
 */
export function daemonCommandFailureLines(error: unknown, commandWords = 'goodvibes-daemon'): readonly string[] {
  const carried = readRefusal(error);
  const reason = describeFatalFailure(error);
  return [
    `${commandWords} failed`,
    carried === undefined ? `Reason: ${reason}` : `Reason: ${carried.code}: ${reason}`,
    `Next: ${DAEMON_COMMAND_FAILURE_NEXT_STEP}`,
  ];
}
