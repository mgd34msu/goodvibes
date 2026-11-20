/** The daemon's home variables, kept free of heavy imports so dispatch can apply it before any command loads. */
import { resolve } from 'node:path';
import type { DaemonCliFlags } from './types.js';

/**
 * The two home variables as this daemon uses them. A moved daemon home
 * (`--daemon-home <dir>`, else `GOODVIBES_DAEMON_HOME`) holds the daemon's
 * identity, as it always has, and is also the tree root for everything else
 * the daemon keeps (sign-in users, device tokens, memory, the owner inbox,
 * hosted sessions, knowledge stores, its crash log), under `<dir>/.goodvibes/`,
 * unless `GOODVIBES_HOME` names a tree of its own. So one switch runs a daemon
 * that shares nothing with another, and a client given the same directory as
 * its daemon home still finds the operator token at `<dir>/operator-tokens.json`.
 */
export function daemonHomeEnvironment(
  flags: Pick<DaemonCliFlags, 'daemonHome'>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv {
  const daemonHome = flags.daemonHome !== undefined ? resolve(cwd, flags.daemonHome)
    : env.GOODVIBES_DAEMON_HOME?.trim() ? resolve(cwd, env.GOODVIBES_DAEMON_HOME.trim()) : undefined;
  const treeHome = env.GOODVIBES_HOME?.trim() ? resolve(cwd, env.GOODVIBES_HOME.trim()) : daemonHome;
  return {
    ...env,
    ...(treeHome !== undefined ? { GOODVIBES_HOME: treeHome } : {}),
    ...(daemonHome !== undefined ? { GOODVIBES_DAEMON_HOME: daemonHome } : {}),
  };
}

/**
 * Apply {@link daemonHomeEnvironment} to this process's own environment, so
 * every reader of `GOODVIBES_HOME` in the daemon (and every program it starts)
 * sees the same tree. Only the real process environment is changed; an
 * embedding caller's environment object is resolved per call instead.
 */
export function applyDaemonHomeEnvironment(flags: Pick<DaemonCliFlags, 'daemonHome'>, cwd: string): void {
  const next = daemonHomeEnvironment(flags, process.env, cwd);
  if (next.GOODVIBES_HOME !== undefined) process.env.GOODVIBES_HOME = next.GOODVIBES_HOME;
  if (next.GOODVIBES_DAEMON_HOME !== undefined) process.env.GOODVIBES_DAEMON_HOME = next.GOODVIBES_DAEMON_HOME;
}
