import type { CommandRegistry } from './command-registry.ts';
import { buildCommandArgsHint as hint } from '@goodvibes/engine/terminal-shell/command-args-hint';

/** The composer's argument hint: each command's own `subcommands`, resolved through aliases. */
export const buildCommandArgsHint = (prompt: string, commandRegistry: Pick<CommandRegistry, 'get'>) => hint(prompt, commandRegistry);
