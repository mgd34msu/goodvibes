/** Repair a daemon-only historical upgrade before configuration can publish a
 * newer data floor that its still-old sibling programs cannot read. */
import { defaultDownloadBaseUrl } from '@goodvibes-jev/engine/platform/platform/daemon';
import { applySuiteUpdate, assertSuiteUpdateCurrent, installedSuiteNeedsRepair, retainSuiteUpdateConfiguration, captureUpdateFileIo, realUpdateFileIo,
  type UpdateFetchLike } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { retainNativeUpdateSources } from '@goodvibes-jev/engine/platform/platform/runtime/compiled-native-startup';
import { createNetworkFetch } from '@goodvibes-jev/engine/platform/platform/runtime/transport';
import { restartOntoUpdatedBinaryAsync } from '@goodvibes-jev/engine/terminal-shell/service-io';
import { resolveInstalledDaemonUpdateArtifact } from '../config/native-installation.js';
import type { DaemonCliConfiguration } from './configuration.js';

export const DAEMON_STARTUP_REPAIRED_FROM = 'GOODVIBES_DAEMON_STARTUP_REPAIRED_FROM';
export interface StartupSuiteRepairOptions {
  readonly configuration: DaemonCliConfiguration;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly print: (line: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}
/** Code-owned test ports; ordinary CLI callers cannot supply these through argv. */
export interface StartupSuiteRepairPorts {
  readonly admit?: typeof resolveInstalledDaemonUpdateArtifact;
  readonly fetchImpl?: UpdateFetchLike;
  readonly restart?: typeof restartOntoUpdatedBinaryAsync;
}
/** True only after a replacement process actually closed successfully. The
 * original process must never continue into its retired writable owner. */
export async function repairDaemonSuiteBeforeStartup(options: StartupSuiteRepairOptions, ports: StartupSuiteRepairPorts = {}): Promise<boolean> {
  const { configuration, signal, print } = options, { config } = configuration;
  const argv = [...options.argv], env = { ...options.env };
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  signal.throwIfAborted();
  if (configuration.isOverridden || config.get('update.auto') !== true) return false;
  const artifact = (ports.admit ?? resolveInstalledDaemonUpdateArtifact)(configuration, { signal });
  if (!artifact?.suite || !artifact.execPath || !artifact.assertCurrent || !artifact.currentReader) return false;
  const { execPath, version, currentReader } = artifact;
  artifact.assertCurrent();
  const selected = retainSuiteUpdateConfiguration(config);
  if (!installedSuiteNeedsRepair({ execPath, platform, arch, version, webuiDirectory: selected.webuiDirectory })) return false;
  // This marker is only a fail-closed loop bound, never permission to skip a
  // needed repair or to publish data with an incompatible installed peer.
  if (env[DAEMON_STARTUP_REPAIRED_FROM] === version) throw new Error('The repaired suite still cannot start safely. Reinstall the complete released suite; existing data is preserved.');
  const releasesUrl = String(config.get('update.releasesUrl') ?? '').trim();
  if (!releasesUrl) throw new Error('The installed suite requires repair but no release feed is configured. Reinstall the complete released suite.');
  const workspace = config.retainConfiguredWorkspace();
  const io = captureUpdateFileIo(realUpdateFileIo);
  const sources = retainNativeUpdateSources([config.getConfigPath(), config.getProjectConfigPath(), config.getSharedTierPath(), config.getDaemonTierPath()]
    .filter((path): path is string => path !== null && path !== undefined), io);
  const get = config.get;
  const current = () => {
    signal.throwIfAborted(); workspace.assertCurrent(); sources(); selected.assertCurrent();
    if (config.get !== get || config.get('update.auto') !== true || String(config.get('update.releasesUrl') ?? '').trim() !== releasesUrl) throw new Error('Startup update policy changed');
  };
  current();
  print(`Repairing the installed GoodVibes suite at v${version} before opening saved data.`);
  const result = await applySuiteUpdate({ execPath, platform, arch, version,
    downloadBaseUrl: defaultDownloadBaseUrl(releasesUrl, `v${version}`),
    fetchImpl: ports.fetchImpl ?? createNetworkFetch(globalThis.fetch, config), webuiDirectory: selected.webuiDirectory,
    currentReader, signal, assertCurrent: current, beforeCommit: () => { current(); currentReader.assertCurrent(); } });
  current(); assertSuiteUpdateCurrent(result);
  // The old native image/receipt is intentionally retired by its own completed
  // publication. Only that publication's original outputs authorize relaunch.
  print(`The complete v${result.version} suite is installed. Restarting before saved data is opened.`);
  assertSuiteUpdateCurrent(result);
  const status = await (ports.restart ?? restartOntoUpdatedBinaryAsync)({ execPath, argv, env, fromVersion: version, signal }, DAEMON_STARTUP_REPAIRED_FROM);
  if (status !== 0) throw new Error('The repaired daemon did not complete successfully; the original image will not open saved data.');
  return true;
}
