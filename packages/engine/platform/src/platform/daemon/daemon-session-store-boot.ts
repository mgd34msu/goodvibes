/**
 * daemon-session-store-boot.ts, what the daemon does to its session store
 * before the broker serves: fold the terminal apps' project session stores
 * and the companion chat sessions into the store the broker serves.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { discoverLegacySessionSources, importLegacySessionStores } from '../control-plane/index.js';

/** The subset of the shell path service the fold needs. */
export interface DaemonSessionStoreBootPaths {
  readonly workingDirectory: string;
  resolveUserPath(...segments: string[]): string;
}

/**
 * Fold the other session stores into the store the broker actually serves,
 * before it serves (idempotent; failures are logged, never fatal).
 *
 * The live path comes FROM the broker rather than being derived here: a
 * composed daemon can be given any store path at all. A broker constructed on
 * an INJECTED store has no file, so there is nothing to fold into.
 */
export async function runDaemonSessionStoreBoot(input: {
  readonly sessionBroker: { readonly storePath: string | null };
  readonly shellPaths: DaemonSessionStoreBootPaths;
}): Promise<void> {
  const liveStorePath = input.sessionBroker.storePath;
  if (liveStorePath === null) return;
  const sources = discoverLegacySessionSources({
    projectRoot: input.shellPaths.workingDirectory,
    companionSessionsDir: input.shellPaths.resolveUserPath('companion-chat', 'sessions'), // injected home
  });
  await importLegacySessionStores({ homeStorePath: liveStorePath, sources })
    .catch((error: unknown) => logger.warn('DaemonServer: session store fold failed', { error: summarizeError(error) }));
}
