import {
  claimSessionHere,
  closeSessionHere,
  confirmRecoveryRestore,
  isSessionOpenElsewhere,
  readLastSessionPointer,
  sessionIdentityFile,
  findSessionCrashSnapshot,
  writeLastSessionPointer,
  type SessionSurface,
} from '@goodvibes/engine/platform/platform/runtime/operations';
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { existsSync } from 'node:fs';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

import { resumeSessionCore, type SessionResumeDeps } from './session-resume.js';
import { whenCrashSnapshotFound } from './session-crash-offer.js';
import { restoreCrashSnapshot, type CrashRecoveryReport } from './session-crash-recovery.js';

export type InteractiveTerminalCheckInput = {
  readonly binary: string;
  readonly stdinIsTTY: boolean | undefined;
  readonly stdoutIsTTY: boolean | undefined;
  /** The words the program was started with, when they would have become the first prompt. */
  readonly words?: string | undefined;
};

/**
 * Both terminal programs' refusal to start their full-screen view without a
 * terminal (exit 2): one plain line saying so, and the command that runs the
 * same words without one. Null when stdin and stdout are terminals.
 */
export function getInteractiveTerminalLaunchError(input: InteractiveTerminalCheckInput): string | null {
  const stdinReady = input.stdinIsTTY === true;
  const stdoutReady = input.stdoutIsTTY === true;
  if (stdinReady && stdoutReady) return null;

  const missing = [stdinReady ? null : 'stdin', stdoutReady ? null : 'stdout'].filter((entry): entry is string => entry !== null);
  const missingLabel = missing.length === 1 ? `${missing[0]} is` : `${missing.join(' and ')} are`;
  const words = input.words?.trim();
  const quoted = words ? JSON.stringify(words) : '"<prompt>"';
  return `${input.binary} needs an interactive terminal (${missingLabel} not a terminal); to run a prompt without one: ${input.binary} run ${quoted}`;
}

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
/** The refusal code of a run told to resume a session that does not exist (or, for --continue, of having none). */
export const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND';

function sessionNotFound(named: string | undefined): RefusalError {
  return new RefusalError(refusal({
    code: SESSION_NOT_FOUND,
    state: named ? `there is no saved session ${named}; nothing was sent` : 'there is no saved session to continue; nothing was sent',
    reason: 'The run was told to continue a session, and a new one is never started in its place.',
    next: ['Run with the id of a saved session', 'Run without --resume, --continue or --session to start a new session'],
  }));
}

function sessionOpenElsewhere(sessionId: string): RefusalError {
  return new RefusalError(refusal({
    code: SESSION_OPEN_ELSEWHERE,
    state: `session ${sessionId} is open in another running copy (a terminal app or another run); nothing was sent`,
    reason: 'Running here would write the same session that copy is writing, and each would overwrite the other\'s turns.',
    next: [`Close session ${sessionId} where it is open, then run again`, 'Run without --resume, --continue or --session to start a new session'],
  }));
}

/** The resume flags of a headless run. */
export type HeadlessResumeFlags = { readonly continueLast?: boolean | undefined; readonly resume?: string | undefined; readonly session?: string | undefined };

/**
 * The session a headless run was told to resume: the named one, or the last
 * one for `--continue` / a bare `--resume`. `requested` is false for a fresh
 * run; `target` is undefined when it was requested and there is none.
 */
function headlessResumeTarget(flags: HeadlessResumeFlags, surface: SessionSurface): { readonly requested: boolean; readonly target?: string | undefined } {
  const named = flags.session ?? (flags.resume !== 'latest' ? flags.resume : undefined);
  const requested = named !== undefined || flags.continueLast === true || flags.resume === 'latest';
  if (!requested) return { requested };
  return { requested, target: named ?? readLastSessionPointer({ surface }) ?? undefined };
}

/**
 * Take the session a headless run resumes before anything is sent anywhere:
 * refused with {@link SESSION_OPEN_ELSEWHERE} when another running copy has it
 * open, otherwise held by this process (a later move into it is the same
 * hold). Returns the session taken, or undefined for a fresh run or when there
 * is nothing to resume (the restore says so). Release it with
 * `closeSessionHere` when the run never moves into it; moving in hands the hold
 * to the run's session.
 *
 * Cost: one stat and one lock attempt that never waits when the session is
 * open elsewhere; otherwise one lock taken (it waits only when another process
 * is taking the same lock at that instant, at most a second).
 */
export async function claimHeadlessSession(flags: HeadlessResumeFlags, surface: SessionSurface): Promise<string | undefined> {
  const { requested, target } = headlessResumeTarget(flags, surface);
  if (!requested) return undefined;
  // Checked before anything is sent: a run told to continue a session that does not exist is refused here,
  // so native intake never records work for it. A session whose only copy is a crash snapshot exists.
  if (target === undefined) throw sessionNotFound(undefined);
  if (!existsSync(sessionIdentityFile(surface, target)) && !findSessionCrashSnapshot(surface, target)) throw sessionNotFound(target);
  if (isSessionOpenElsewhere(surface, target) || !(await claimSessionHere(surface, target))) throw sessionOpenElsewhere(target);
  return target;
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
  flags: HeadlessResumeFlags,
  ports: SessionResumeDeps & { readonly surface: NonNullable<SessionResumeDeps['surface']> },
  signal: AbortSignal,
): Promise<CrashRecoveryReport | undefined> {
  signal.throwIfAborted();
  const { requested } = headlessResumeTarget(flags, ports.surface);
  if (!requested) return undefined;
  // Already held when the product claimed it before intake (claimHeadlessSession); then this is a map lookup.
  const target = await claimHeadlessSession(flags, ports.surface);
  if (!target) throw new Error('No saved conversation is available to resume. Inspect sessions before submitting a new request.');
  signal.throwIfAborted();
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
    // The session store refused to open it for writing: another copy has it open. The run says so in its refusal.
    if (!(error instanceof RefusalError) && error instanceof Error && (error as { readonly code?: unknown }).code === SESSION_OPEN_ELSEWHERE) {
      throw sessionOpenElsewhere(target);
    }
    // A session whose only copy was the snapshot fails to open when the snapshot does not apply; say why.
    const report = recovery.report;
    if (report && !report.applied && error instanceof Error) error.message = `${error.message} ${report.lost.join(' ')}`;
    throw error;
  } finally {
    stopRecovering();
  }
  signal.throwIfAborted();
  // The session opened; a pointer that was not written is said, and the next save writes it again.
  try { writeLastSessionPointer(target, { surface: ports.surface }); }
  catch (error) { logger.warn('The last-session pointer was not written after the session opened', { sessionId: target, error: summarizeError(error) }); }
  return recovery.report;
}
