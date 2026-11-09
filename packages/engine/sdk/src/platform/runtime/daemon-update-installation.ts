/** Maintenance view over the two actual native daemon release layouts.
 * Linux retains its published installation receipt protocol; Darwin uses the
 * complete fixed reader artifact. Neither backend executes an older program.
 */
import { inspectDaemonNativeInstallation, resolveDaemonInstallationReaders, resolveDaemonNativeTargets } from './daemon-native-cohort.js';
import { inspectDarwinDaemonInstallation, resolveDarwinDaemonTargets } from './darwin-daemon-installation.js';
import type { NativeReaderCapabilities } from './native-reader-compatibility.js';
import type { UpdateFileIo } from './update-file-io.js';
import type { UpdateTarget } from './self-update.js';

export function resolveDaemonUpdateTargets(execPath: string, platform: string, arch: string): readonly UpdateTarget[] | null {
  return platform === 'darwin' ? resolveDarwinDaemonTargets(execPath, arch) : resolveDaemonNativeTargets(execPath, platform, arch);
}
export interface DaemonUpdateInstallation {
  readonly version: string;
  readonly readers: NativeReaderCapabilities | undefined;
}
export function inspectDaemonUpdateInstallation(execPath: string, platform: string, arch: string, suffix: '' | '.previous', io: UpdateFileIo,
  options: { readonly integrity?: boolean } = {}): DaemonUpdateInstallation | null {
  if (platform === 'darwin') {
    const installation = inspectDarwinDaemonInstallation(execPath, arch, suffix, io, options);
    return installation ? { version: installation.version, readers: installation.readers } : null;
  }
  const installation = inspectDaemonNativeInstallation(execPath, platform, arch, suffix, io, options);
  if (!installation) return null;
  const companion = suffix === '.previous' && installation.artifact.schema === 1
    ? inspectDaemonNativeInstallation(execPath, platform, arch, '', io, { integrity: false }) : null;
  return { version: installation.version, readers: resolveDaemonInstallationReaders(installation, companion) };
}
