import type { CommandRegistry } from './command-registry.ts';
import { COMMON_SUBCOMMAND_HINTS, buildCommandArgsHint as hint } from '@goodvibes-jev/engine/terminal-shell/command-args-hint';
const SUBCOMMAND_HINTS = { ...COMMON_SUBCOMMAND_HINTS,
session: { rename: '<name>', resume: '<id|name>', info: '<id>', export: '<id> [format]', search: '<query>', delete: '<id>' },
danger: {} };
export const buildCommandArgsHint = (prompt: string, commandRegistry: Pick<CommandRegistry, 'get'>) => hint(prompt, commandRegistry, SUBCOMMAND_HINTS);
