import {
  claimSessionHere,
  closeSessionHere,
  confirmRecoveryRestore,
  isSessionOpenElsewhere,
  readLastSessionPointer,
  writeLastSessionPointer,
} from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { resumeSessionCore, type SessionResumeDeps } from './session-resume.js';
import { whenCrashSnapshotFound } from './session-crash-offer.js';
import { restoreCrashSnapshot, type CrashRecoveryReport } from './session-crash-recovery.js';

/** Fatal diagnostics are independent: failure of one sink cannot suppress another or the exit. */
export function reportStartupFailure(
  error: unknown,
  ports: {
    readonly userMessage: (error: unknown) => string;
    readonly logContext: (error: unknown) => Record<string, unknown>;
    readonly write: (message: string) => void;
    readonly log: (message: string, context: Record<string, unknown>) => void;
    readonly exit: (code: number) => void;
    readonly stderrFirst: boolean;
  },
): void {
  const write = () => {
    try {
      ports.write(ports.userMessage(error));
    } catch {
      /* A torn-down stream cannot suppress the original exit. */
    }
  };
  const log = () => {
    try {
      ports.log('Fatal error', ports.logContext(error));
    } catch {
      /* Logging may be unavailable before boot finishes. */
    }
  };
  if (ports.stderrFirst) {
    write();
    log();
  } else {
    log();
    write();
  }
  ports.exit(1);
}
export function applySeededCliPrompt(
  cli: {
    readonly flags: { readonly prompt?: string | undefined };
    readonly rawCommand?: string | undefined;
    readonly positionals: readonly string[];
  },
  input: { prompt: string; cursorPos: number },
): void {
  const seeded = cli.flags.prompt ?? (cli.rawCommand === undefined && cli.positionals.length > 0 ? cli.positionals.join(' ') : undefined);
  if (seeded) {
    input.prompt = seeded;
    input.cursorPos = seeded.length;
  }
}
export function resumeSessionAndRender<Context>(
  registry: { execute(name: string, args: string[], context: Context): Promise<unknown> },
  target: string,
  context: Context,
  render: () => void,
): Promise<void> {
  return registry.execute('session', ['resume', target], context).then(() => render());
}

/** The refusal code of a run resuming a session another running copy has open. */
export const SESSION_OPEN_ELSEWHERE = 'SESSION_OPEN_ELSEWHERE';

function sessionOpenElsewhere(sessionId: string): RefusalError {
  return new RefusalError(refusal({
    code: SESSION_OPEN_ELSEWHERE,
    state: `session ${sessionId} is open in another running copy (a terminal app or another run); nothing was sent`,
    reason: 'Running here would write the same session that copy is writing, and each would overwrite the other\'s turns.',
    next: [`Close session ${sessionId} where it is open, then run again`, 'Run without --resume, --continue or --session to start a new session'],
  }));
}

/** Headless startup must restore the selected transcript before submitting a new
 * prompt. A missing requested conversation is an error, never a fresh retry.
 *
 * A resumed session with a crash snapshot newer than its saved copy (a run or
 * terminal killed inside a turn) is restored from the snapshot before the first
 * request, without asking: the run's own `--resume` / `--continue` / `--session`
 * is the ask, and nobody is there to answer another. The report says what came
 * back and what did not. A run without one of those flags restores nothing.
 *
 * A session another running copy has open (a terminal app, another run) is
 * refused before anything is read, with {@link SESSION_OPEN_ELSEWHERE}: the run
 * would write the same session that copy is writing. The run takes the
 * session's lock before it loads it, so two runs started at once cannot both
 * get it.
 */
export async function restoreHeadlessSession(
  flags: { readonly continueLast?: boolean | undefined; readonly resume?: string | undefined; readonly session?: string | undefined },
  ports: SessionResumeDeps & { readonly surface: NonNullable<SessionResumeDeps['surface']> },
  signal: AbortSignal,
): Promise<CrashRecoveryReport | undefined> {
  signal.throwIfAborted();
  const named = flags.session ?? (flags.resume !== 'latest' ? flags.resume : undefined);
  const requested = named !== undefined || flags.continueLast === true || flags.resume === 'latest';
  if (!requested) return undefined;
  const target = named ?? readLastSessionPointer({ surface: ports.surface });
  if (!target) throw new Error('No saved conversation is available to resume. Inspect sessions before submitting a new request.');
  signal.throwIfAborted();
  // One stat and one lock attempt refuse at once; the claim then makes it this run's (at most a second's wait on a race).
  if (isSessionOpenElsewhere(ports.surface, target) || !(await claimSessionHere(ports.surface, target))) throw sessionOpenElsewhere(target);
  // Filled by the resume routine when the session has a newer crash snapshot.
  const recovery: { report?: CrashRecoveryReport } = {};
  const stopRecovering = whenCrashSnapshotFound(ports.conversation, ({ info }) => {
    const report = restoreCrashSnapshot({
      surface: ports.surface,
      info,
      sessionManager: ports.sessionManager,
      runtime: ports.runtime,
      conversation: ports.conversation,
      // The run was started to resume this session; that flag is the answer.
      confirmation: confirmRecoveryRestore(true)!,
      hydrateSessionUsage: ports.hydrateSessionUsage,
    });
    recovery.report = report;
    return report.applied ? 'applied' : 'declined';
  });
  try {
    // Interactive resume handlers present errors and may return after a declined
    // modal. Headless callers require the actual restore to succeed before work.
    await resumeSessionCore(target, { ...ports,
      canResume: () => !signal.aborted && ports.canResume?.() !== false,
    });
  } catch (error) {
    // The claimed session goes back unless the run moved into it.
    if (ports.runtime.sessionId !== target) closeSessionHere(ports.surface, target);
    // A session whose only copy was the snapshot fails to open when the snapshot does not apply; say why.
    const report = recovery.report;
    if (report && !report.applied && error instanceof Error) error.message = `${error.message} ${report.lost.join(' ')}`;
    throw error;
  } finally {
    stopRecovering();
  }
  signal.throwIfAborted();
  writeLastSessionPointer(target, { surface: ports.surface });
  return recovery.report;
}
