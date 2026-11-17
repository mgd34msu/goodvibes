import type { CommandRegistry } from './command-registry.ts';
import { COMMON_SUBCOMMAND_HINTS, buildCommandArgsHint as hint } from '@goodvibes-jev/engine/terminal-shell/command-args-hint';

/** The composer's argument hint: each command's own `subcommands`, resolved through aliases. */
export const buildCommandArgsHint = (prompt: string, commandRegistry: Pick<CommandRegistry, 'get'>) => hint(prompt, commandRegistry, COMMON_SUBCOMMAND_HINTS);
