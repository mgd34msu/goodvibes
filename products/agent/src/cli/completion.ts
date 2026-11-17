import {
  completionTableFromCatalog,
  runCompletionCommand,
  type CompletionCommandResult,
  type CompletionTable,
} from '@goodvibes-jev/engine/terminal-shell/shell-completion';
import { AGENT_CLI_CATALOG } from './catalog.ts';
import { describeGoodVibesCommandHelp } from './help.ts';

// `unknown` collects the words of other products' commands, refused by name, and
// `tui` is the bare launch: neither is a word to offer.
const EXCLUDED_COMMANDS: ReadonlySet<string> = new Set(['unknown', 'tui']);
// `--port`, `--hostname` and `--host` only act under `pair`; offering them at
// every position would suggest they configure the shell.
const HIDDEN_OPTIONS: ReadonlySet<string> = new Set(['--port', '--hostname', '--host']);
const DIRECTORY_FLAGS: ReadonlySet<string> = new Set(['--working-dir', '--cd', '-C']);

/** The Agent's command table, derived from its CLI catalog and help table. */
export function agentCompletionTable(binary = 'goodvibes-agent'): CompletionTable {
  return completionTableFromCatalog(AGENT_CLI_CATALOG, binary, {
    exclude: EXCLUDED_COMMANDS,
    hiddenFlags: HIDDEN_OPTIONS,
    directoryFlags: DIRECTORY_FLAGS,
    describe: (name) => {
      const help = describeGoodVibesCommandHelp(name);
      return help ? { description: help.summary, subcommands: help.subcommands } : undefined;
    },
  });
}

/** `goodvibes-agent completion <shell>`: bash, zsh or fish; any other name is refused with exit 2. */
export const renderCompletion = (args: readonly string[], binary = 'goodvibes-agent'): CompletionCommandResult =>
  runCompletionCommand(args, agentCompletionTable(binary));
