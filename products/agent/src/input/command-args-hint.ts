import type { CommandRegistry } from './command-registry.ts';
import { COMMON_SUBCOMMAND_HINTS, buildCommandArgsHint as hint } from '@goodvibes-jev/engine/terminal-shell/command-args-hint';

/** Every `/session` subcommand the Agent handles; the link-task, handoff and cancel verbs are blocked here, so they carry no argument hint. */
export const SESSION_SUBCOMMAND_ARG_HINTS: Record<string, string> = {
  list: '',
  rename: '<name>',
  resume: '<id|name>',
  fork: '[name]',
  save: '[name] [--replace] [--switch]',
  info: '[id]',
  export: '<id|.> [markdown|text]',
  search: '<query>',
  delete: '<id>',
  events: '[kind] [start-row] [--last N]',
  groups: '[kind] [start-row] [--last N]',
  hotspots: '[kind]',
  graph: '[--session <sid>] [--format text|json]',
  g: '[--session <sid>] [--format text|json]',
};
const SUBCOMMAND_HINTS = { ...COMMON_SUBCOMMAND_HINTS, session: SESSION_SUBCOMMAND_ARG_HINTS };
export const buildCommandArgsHint = (prompt: string, commandRegistry: Pick<CommandRegistry, 'get'>) => hint(prompt, commandRegistry, SUBCOMMAND_HINTS);
