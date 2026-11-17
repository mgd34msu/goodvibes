/**
 * facade-boot-guarantees, the things the daemon must not depend on its host to
 * have remembered.
 *
 * An omission here has no symptom at the point of omission and an expensive
 * one much later somewhere else, so the daemon facade, the one construction
 * every host goes through, owns them.
 */
import { join } from 'node:path';
import type { SweepableSecrets } from '../config/plaintext-credential-sweep.js';
import { describePlaintextSweep, sweepPlaintextCredentials } from '../config/plaintext-credential-sweep.js';
import { raiseReaderFloorInFile } from '../config/shared-config-tier.js';
import type { ConfigManager } from '../config/manager.js';
import { ensureActivityLoggerConfigured, logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * Guarantee the shared activity logger has somewhere to write.
 *
 * The daemon is the process that runs the chat surfaces, so it is the one
 * process where "the bot token was rejected", "this surface is enabled but
 * cannot start", and "the reply had nowhere to go" are the only evidence an
 * operator will ever get. Those all go through `logger`, which discards every
 * entry until a host names a destination. One shipped daemon binary never
 * named one, and the result was a process that ran the entire channel stack
 * and said nothing about any of it for its whole lifetime, an enabled,
 * configured, inert surface and a healthy-looking daemon.
 *
 * A host that already configured a log keeps it; this never relocates one.
 *
 * A destination the daemon named is the daemon's to end: `holder` (one value
 * per daemon, its config manager) is recorded, and `releaseDaemonActivityLog`
 * called from the daemon's stop disposes the logger once the last daemon that
 * holds it has stopped. Without that, lines logged during teardown stayed
 * buffered and the next flush rebuilt `<workdir>/.goodvibes/logs` after the host
 * had stopped the daemon and deleted its working directory.
 */
export function ensureDaemonActivityLog(workingDirectory: string, holder: object): void {
  const logDir = join(workingDirectory, '.goodvibes', 'logs');
  if (!ensureActivityLoggerConfigured(logDir)) {
    // Another daemon in this process already named the destination: share it.
    if (daemonLogHolders.size > 0) daemonLogHolders.add(holder);
    return;
  }
  daemonLogHolders.add(holder);
  logger.warn('DaemonServer: the host started the daemon without configuring the activity log', {
    detail: 'every platform log line before this point was discarded',
    action: 'call configureActivityLogger() in the host entrypoint; the daemon has now defaulted it',
    logDir,
  });
}

/** Daemons in this process that hold an activity log destination a daemon named. */
const daemonLogHolders = new Set<object>();

/**
 * End the activity log this daemon named, once no other daemon in the process
 * holds it: a final flush that never rebuilds a removed directory, then the
 * logger accepts nothing more. A host-configured log is never touched. Called
 * by the daemon's stop with the same `holder` it booted with; a second call is
 * a no-op.
 */
export function releaseDaemonActivityLog(holder: object): void {
  if (!daemonLogHolders.delete(holder)) return;
  if (daemonLogHolders.size === 0) logger.dispose();
}

/**
 * Every boot guarantee, in the order they depend on each other: the log has to
 * exist before anything can report.
 */
export async function runDaemonBootGuarantees(
  configManager: ConfigManager,
  services: DaemonBootServices,
): Promise<void> {
  ensureDaemonActivityLog(services.shellPaths.workingDirectory, configManager);
  await sweepPlaintextCredentialsOnBoot(configManager, services);
  // The live watch was armed during graph acquisition, before the sweep's
  // owned writes. Consume their disk generations before readiness. This uses
  // the ordinary reload/invalidation path and also observes external edits
  // that arrived during boot; no same-value or ABA invalidation is suppressed.
  configManager.flushConfigFileChanges();
}

/**
 * Move any credential written literally into a settings file (by hand, or by
 * another tool) into the store. See config/plaintext-credential-sweep.ts for the
 * ordering that makes this safe: a literal is replaced by a reference only
 * after the store has been read back and matched.
 */
async function sweepPlaintextCredentialsOnBoot(
  configManager: ConfigManager,
  services: DaemonBootServices,
): Promise<void> {
  try {
    const manager = configManager as unknown as { get(key: string): unknown; setDynamic(key: string, value: unknown): void };
    const daemonTierPath = configManager.getDaemonTierPath();
    const report = await sweepPlaintextCredentials(
      { get: (key) => manager.get(key), set: (key, value) => { manager.setDynamic(key, value); } },
      services.secretsManager,
      [],
      // The sweep rewrites the daemon's settings file, which every component on
      // this machine reads. Record what a reader now needs, so one that is too
      // old says exactly that instead of failing on whichever key it could not
      // walk. See config/settings-reader-floor.ts.
      daemonTierPath === null
        ? undefined
        : (minReaderVersion, setBy) => { raiseReaderFloorInFile(daemonTierPath, minReaderVersion, setBy); },
    );
    if (report.noop) return;
    logger.info('DaemonServer: credentials stored in the clear were moved into the secret store', {
      summary: describePlaintextSweep(report),
      entries: report.entries.map((entry) => `${entry.configKey}:${entry.outcome}`),
    });
  } catch (error) {
    logger.warn('DaemonServer: the plaintext credential sweep failed', {
      error: summarizeError(error),
      detail: 'a credential may still be stored in the clear in a settings file',
    });
  }
}

/**
 * What the guarantees need from the runtime, structurally.
 *
 * Structural rather than a `RuntimeServices` import so this module keeps the
 * narrow surface it has: it takes a secret store it can list, read, write and
 * delete through, and two directory paths. Nothing else.
 */
export interface DaemonBootServices {
  readonly secretsManager: SweepableSecrets;
  readonly shellPaths: { readonly workingDirectory: string; readonly homeDirectory: string };
}
