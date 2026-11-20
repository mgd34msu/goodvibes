/**
 * The daemon's operation log, `<control-plane dir>/control-plane/operations.jsonl`.
 *
 * For the outward operations whose path writes no record of its own (a GitHub
 * reply owed, a Cloudflare token provision): each is accepted here, synced,
 * before anyone is told it was accepted, and settled when it ends. One log per
 * daemon home, opened once per process and shared by every user of it, so all
 * of them share one batch fdatasync. See state/operation-log.ts.
 *
 * Cost: none until the first operation; opening reads the log once.
 */
import { join } from 'node:path';
import { openOperationLog, type OperationLog } from '../state/operation-log.js';

const logsByPath = new Map<string, OperationLog<unknown>>();

/** Where the daemon's operation log lives for this configuration. */
export function daemonOperationsPath(configManager: { getControlPlaneConfigDir(): string }): string {
  return join(configManager.getControlPlaneConfigDir(), 'control-plane', 'operations.jsonl');
}

/** The one operation log for this daemon home in this process. Each user reads its own kinds; the payload type is the user's. */
export function daemonOperationLog<P>(configManager: { getControlPlaneConfigDir(): string }): OperationLog<P> {
  const path = daemonOperationsPath(configManager);
  let log = logsByPath.get(path);
  if (!log) {
    log = openOperationLog<unknown>(path);
    logsByPath.set(path, log);
  }
  return log as OperationLog<P>;
}
