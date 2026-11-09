import { readLastSessionPointer, writeLastSessionPointer } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { resumeSessionCore, type SessionResumeDeps } from './session-resume.js';

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

/** Headless startup must restore the selected transcript before submitting a new
 * prompt. A missing requested conversation is an error, never a fresh retry.
 */
export async function restoreHeadlessSession(
  flags: { readonly continueLast?: boolean | undefined; readonly resume?: string | undefined; readonly session?: string | undefined },
  ports: SessionResumeDeps,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const named = flags.session ?? (flags.resume !== 'latest' ? flags.resume : undefined);
  const requested = named !== undefined || flags.continueLast === true || flags.resume === 'latest';
  if (!requested) return;
  const target = named ?? readLastSessionPointer({ surface: ports.surface });
  if (!target) throw new Error('No saved conversation is available to resume. Inspect sessions before submitting a new request.');
  signal.throwIfAborted();
  // Interactive resume handlers present errors and may return after a declined
  // modal. Headless callers require the actual restore to succeed before work.
  await resumeSessionCore(target, { ...ports,
    canResume: () => !signal.aborted && ports.canResume?.() !== false,
  });
  signal.throwIfAborted();
  writeLastSessionPointer(target, { surface: ports.surface });
}
