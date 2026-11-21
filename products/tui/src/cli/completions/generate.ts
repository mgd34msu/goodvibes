/**
 * The command table behind `goodvibes completion <shell>`. The scripts come
 * from the shared generator (terminal-shell/shell-completion), the same one
 * the Agent and the daemon use. Command words and sub-words come from the
 * parser's catalog (through `listTuiCommands`, which adds the commands served
 * before the parser and leaves out the refused `serve`); descriptions come
 * from the help table, so a command in `goodvibes help` is offered here too.
 */

import { GOODVIBES_CLI_CATALOG } from '@goodvibes/engine/terminal-shell/cli-command-catalog';
import {
  runCompletionCommand,
  type CompletionCommandResult,
  type CompletionTable,
} from '@goodvibes/engine/terminal-shell/shell-completion';
import { listTuiCommands } from '../help.ts';

// ---------------------------------------------------------------------------
// Typed completion data surface
// ---------------------------------------------------------------------------

/** A flag definition for completion purposes. */
export interface CompletionFlag {
  /** Primary flag name, e.g. '--model' */
  readonly name: string;
  /** Short alias if any, e.g. '-m' */
  readonly short?: string;
  /** Additional aliases (long), e.g. '--working-dir' */
  readonly aliases?: readonly string[];
  /** Whether the flag takes a value argument */
  readonly takesValue: boolean;
  /** Enumerated completions for the flag value, if applicable */
  readonly valueEnum?: readonly string[];
  /** Human-readable description */
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Global flags
// ---------------------------------------------------------------------------

/** Every global flag the parser accepts, read from the shared CLI catalog (the parser's own table), so completion offers exactly what parses. */
export const GLOBAL_FLAGS: readonly CompletionFlag[] = GOODVIBES_CLI_CATALOG.globalFlags.map((spec): CompletionFlag => {
  const offered = spec.tokens.filter((token) => !(spec.unlistedTokens ?? []).includes(token));
  const long = offered.filter((token) => token.startsWith('--'));
  const short = offered.find((token) => /^-[^-]/.test(token));
  return {
    name: long[0] ?? offered[0]!,
    ...(short !== undefined ? { short } : {}),
    ...(long.length > 1 ? { aliases: long.slice(1) } : {}),
    takesValue: spec.kind !== 'boolean' && spec.kind !== 'const',
    ...(spec.enumValues !== undefined ? { valueEnum: spec.enumValues } : {}),
    description: spec.summary,
  };
});

/** Flags whose value is a directory. */
const DIRECTORY_FLAGS: ReadonlySet<string> = new Set(['--cd', '--daemon-home']);

/** The TUI's table in the shared generator's shape. */
export function tuiCompletionTable(binary = 'goodvibes'): CompletionTable {
  return {
    binary,
    commands: listTuiCommands().map((command) => ({
      name: command.name,
      aliases: [command.name, ...command.aliases],
      description: command.line,
      subcommands: command.subcommands,
    })),
    globalFlags: GLOBAL_FLAGS.map((flag) => ({
      tokens: [flag.name, ...(flag.aliases ?? []), ...(flag.short !== undefined ? [flag.short] : [])],
      takesValue: flag.takesValue,
      ...(flag.valueEnum !== undefined ? { valueEnum: flag.valueEnum } : {}),
      ...(DIRECTORY_FLAGS.has(flag.name) ? { directory: true } : {}),
      description: flag.description,
    })),
  };
}

/** `goodvibes completion <shell>`; a missing or unsupported shell is a usage refusal (exit 2). */
export function runTuiCompletion(args: readonly string[], binary = 'goodvibes'): CompletionCommandResult {
  return runCompletionCommand(args, tuiCompletionTable(binary));
}
