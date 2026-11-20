/**
 * completion.ts, `goodvibes-daemon completion <shell>`: the shared generator
 * (terminal-shell/shell-completion) over a table derived from the command
 * catalog, so a command added to `./command-catalog.ts` completes the moment
 * it exists and one removed stops being offered.
 */
import {
  completionFlagFromCatalog,
  runCompletionCommand as runSharedCompletionCommand,
  type CompletionTable,
} from '@goodvibes/engine/terminal-shell/shell-completion';
import { DAEMON_COMMANDS, GLOBAL_FLAGS } from './command-catalog.ts';

export { COMPLETION_SHELLS, isCompletionShell, type CompletionShell } from '@goodvibes/engine/terminal-shell/shell-completion';

const DIRECTORY_FLAGS: ReadonlySet<string> = new Set(['--daemon-home', '--working-dir', '--cd', '-C']);

/** The daemon's command table: every catalog command, its sub-words and its own flags. */
export function daemonCompletionTable(binary = 'goodvibes-daemon'): CompletionTable {
  return {
    binary,
    commands: DAEMON_COMMANDS.map((spec) => ({
      name: spec.name,
      aliases: spec.aliases,
      description: spec.summary,
      subcommands: spec.subcommands,
      // A passthrough command reads every word after its name itself; it lists the flags it reads.
      flags: spec.passthrough
        ? (spec.passthroughFlags ?? []).map((flag) => ({ tokens: flag.tokens, takesValue: flag.takesValue, description: flag.summary }))
        : spec.flags.map((flag) => completionFlagFromCatalog(flag, DIRECTORY_FLAGS)),
      ...(spec.passthrough ? { passthrough: true } : {}),
    })),
    globalFlags: GLOBAL_FLAGS.map((flag) => completionFlagFromCatalog(flag, DIRECTORY_FLAGS)),
  };
}

export interface CompletionCommandResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

/** `goodvibes-daemon completion <shell>`; a missing or unsupported shell is a usage refusal (exit 2). */
export function runCompletionCommand(argv: readonly string[], binary = 'goodvibes-daemon'): CompletionCommandResult {
  const result = runSharedCompletionCommand(argv, daemonCompletionTable(binary));
  return { exitCode: result.exitCode, lines: [result.stdout ?? result.stderr ?? ''] };
}
