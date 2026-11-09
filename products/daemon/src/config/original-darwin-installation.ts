/** Private original pre-await capture; imports only narrow filesystem/location helpers. */
import { isAbsolute, resolve } from 'node:path';
import { isCompiledBunModuleUrl, detectInstallKind, captureUpdateFileIo, realUpdateFileIo, resolveDarwinDaemonTargets, retainNativeUpdateSources } from '@goodvibes-jev/engine/sdk/platform/runtime/compiled-native-startup';
import type { DarwinDaemonInstallation } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import type { DaemonSqliteAdmission } from '../cli/native-sqlite-runtime.js';
import { COMPILED_VERSION } from '../version.js';
/** Original synchronous bundled-entry observation, not a late pathname guess. */
export interface OriginalDarwinDaemonInstallation { readonly execPath: string; readonly version: string; assertCurrent(): void }
const darwinOriginals = new WeakMap<OriginalDarwinDaemonInstallation, { readonly sqlite: DaemonSqliteAdmission; readonly targets: NonNullable<ReturnType<typeof resolveDarwinDaemonTargets>>; readonly io: ReturnType<typeof captureUpdateFileIo>; installation?: DarwinDaemonInstallation }>();
let earlyDarwinInstallation: OriginalDarwinDaemonInstallation | undefined;
export function captureOriginalDarwinDaemonInstallation(sqlite: DaemonSqliteAdmission | undefined, options: {
  readonly execPath?: string; readonly platform?: string; readonly arch?: string; readonly version?: string; readonly bundled?: boolean;
} = {}): OriginalDarwinDaemonInstallation | undefined {
  const { execPath = process.execPath, platform = process.platform, arch = process.arch, version = COMPILED_VERSION,
    bundled = isCompiledBunModuleUrl(import.meta.url) } = options;
  if (platform !== 'darwin' || !bundled || detectInstallKind(execPath) !== 'binary') return undefined;
  if (!isAbsolute(execPath) || resolve(execPath) !== execPath || !sqlite || sqlite.execPath !== execPath || sqlite.owner.daemonVersion !== version) throw new Error('Original compiled Darwin SQLite owner is unavailable');
  sqlite.assertCurrent();
  const targets = resolveDarwinDaemonTargets(execPath, arch); if (!targets) throw new Error('Darwin daemon target is unsupported');
  const io = captureUpdateFileIo(realUpdateFileIo), retained = retainNativeUpdateSources(targets.flatMap(target => [target.path, target.path + '.previous']), io);
  const current = () => { sqlite.assertCurrent(); retained(); sqlite.assertCurrent(); };
  current(); const selected = Object.freeze({ execPath, version, assertCurrent: current });
  darwinOriginals.set(selected, { sqlite, targets, io }); return selected;
}
/** Called exactly by the native entry before its first service import/await. */
export function initializeOriginalDarwinDaemonInstallation(sqlite: DaemonSqliteAdmission | undefined): void {
  if (earlyDarwinInstallation) { earlyDarwinInstallation.assertCurrent(); return; }
  earlyDarwinInstallation = captureOriginalDarwinDaemonInstallation(sqlite);
}

export const originalDarwinSelection = () => earlyDarwinInstallation;
export const originalDarwinProof = (selected: OriginalDarwinDaemonInstallation) => darwinOriginals.get(selected);
