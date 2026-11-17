/**
 * secrets-composition.ts, building the credential store with its homes wired
 * to the ones the host was actually told about.
 *
 * ── The failure this exists to prevent ────────────────────────────────────
 *
 * `SecretsManagerOptions.daemonHome` has always existed, and its own doc says
 * a caller honouring `--daemon-home` or `GOODVIBES_DAEMON_HOME` should resolve
 * it and pass it here. No composition root ever did.
 *
 * So "isolating" a daemon by giving it `--daemon-home /tmp/...` moved its
 * identity directory and nothing else. Its credential store stayed at
 * `<realHome>/.goodvibes/daemon`, and when that held nothing the read order
 * walks the working directory's ancestors, which, for any process running
 * under the owner's home, reaches the owner's real project secret store.
 *
 * A throwaway daemon therefore held the owner's real credentials. One of them
 * long-polled the owner's real Telegram bot, collided with the production
 * daemon on the same token, and inbound messages stopped.
 *
 * Passing the override through is the fix, and it lives in this one function:
 * every product and composition root builds the store here, and the daemon
 * home is a required field, so a caller that forgets it does not compile.
 * Callers without their own override pass `resolveGoodVibesDaemonHome(home)`,
 * which honours `GOODVIBES_DAEMON_HOME` (what `--daemon-home` exports).
 *
 * A `daemonHome` override does not relocate the project/user tiers, and it
 * should not: those are addressed by `projectRoot` and `globalHome`.
 */

import { SecretsManager, type SecretsManagerOptions } from '../config/secrets.js';

export interface DaemonSecretsCompositionInput {
  readonly projectRoot: string;
  readonly globalHome: string;
  readonly surfaceRoot: string;
  readonly configManager: SecretsManagerOptions['configManager'];
  /** The daemon state root holding the daemon-scoped stores, already resolved (the machine default included). */
  readonly daemonHome: string;
  readonly diagnosticMode?: SecretsManagerOptions['diagnosticMode'];
}

/** Construct the credential store, honouring a daemon-home override. */
export function createRuntimeSecretsManager(input: DaemonSecretsCompositionInput): SecretsManager {
  return new SecretsManager({
    projectRoot: input.projectRoot,
    globalHome: input.globalHome,
    surfaceRoot: input.surfaceRoot,
    configManager: input.configManager,
    daemonHome: input.daemonHome,
    ...(input.diagnosticMode === undefined ? {} : { diagnosticMode: input.diagnosticMode }),
  });
}
