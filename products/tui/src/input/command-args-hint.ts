import type { CommandRegistry } from './command-registry.ts';
import { SESSION_SUBCOMMAND_ARG_HINTS } from './commands/session.ts';
import { CLUSTER_SUBCOMMAND_ARG_HINTS } from './commands/cluster-runtime.ts';
import { COMMON_SUBCOMMAND_HINTS, buildCommandArgsHint as hint } from '@goodvibes-jev/engine/terminal-shell/command-args-hint';
const SUBCOMMAND_HINTS = { ...COMMON_SUBCOMMAND_HINTS,
session: SESSION_SUBCOMMAND_ARG_HINTS,
cluster: CLUSTER_SUBCOMMAND_ARG_HINTS };
export const buildCommandArgsHint = (prompt: string, commandRegistry: Pick<CommandRegistry, 'get'>) => hint(prompt, commandRegistry, SUBCOMMAND_HINTS);
