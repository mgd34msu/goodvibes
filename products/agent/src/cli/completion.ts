import { renderCompletion as render } from '@goodvibes-jev/engine/terminal-shell/shell-completion';
import { AGENT_CLI_CATALOG } from './catalog.ts';
import { listGoodVibesCliCommands } from './parser.ts';

// `tui` is the bare launch, not a word to type. The aliases are the spellings
// the help text teaches. Everything else comes from the catalog so a new command
// or flag appears here without a second edit.
const COMPLETION_ALIASES = ['exec', 'setup', 'qrcode'] as const;
// `--port`, `--hostname` and `--host` only act under `pair`; offering them at
// every position would suggest they configure the shell.
const HIDDEN_OPTIONS: ReadonlySet<string> = new Set(['--port', '--hostname', '--host']);

export const COMPLETION_COMMANDS: readonly string[] = [
  ...listGoodVibesCliCommands().filter((command) => command !== 'tui'),
  ...COMPLETION_ALIASES,
];

export const COMPLETION_OPTIONS: readonly string[] = AGENT_CLI_CATALOG.globalFlags
  .flatMap((flag) => flag.tokens)
  .filter((token) => token.startsWith('--') && !HIDDEN_OPTIONS.has(token));

export const renderCompletion = (shell: string | undefined, binary = 'goodvibes-agent') =>
  render(shell, binary, { commands: COMPLETION_COMMANDS, options: COMPLETION_OPTIONS });
