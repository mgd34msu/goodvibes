/** Private original pre-await capture; imports only narrow filesystem/location helpers. */
import { isAbsolute, resolve } from 'node:path';
import { isCompiledBunModuleUrl, detectInstallKind, captureUpdateFileIo, realUpdateFileIo, resolveDarwinDaemonTargets, retainNativeUpdateSources } from '@goodvibes-jev/engine/platform/platform/runtime/compiled-native-startup';
import type { DaemonSqliteAdmission } from '../cli/native-sqlite-runtime.js';
import { COMPILED_VERSION } from '../version.js';
import { nativeStartupRefused } from './installation-refusal.js';
/** Original synchronous bundled-entry observation, not a late pathname guess. */
export interface OriginalDarwinDaemonInstallation { readonly execPath: string; readonly version: string; assertCurrent(): void }
const darwinOriginals = new WeakMap<OriginalDarwinDaemonInstallation, Readonly<{ readonly sqlite: DaemonSqliteAdmission; readonly targets: NonNullable<ReturnType<typeof resolveDarwinDaemonTargets>>; readonly io: ReturnType<typeof captureUpdateFileIo> }>>();
let earlyDarwinInstallation: OriginalDarwinDaemonInstallation | undefined;
// The retained-source check throws an errno for an I/O failure and a plain error
// when a file changed; the second is reported by its code, not its wording.
function sourceCheck<T>(check: () => T): T {
  try { return check(); } catch (error) {
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
    throw nativeStartupRefused('DARWIN_SOURCE_CHANGED', 'Native daemon installation changed during preparation');
  }
}
export function captureOriginalDarwinDaemonInstallation(sqlite: DaemonSqliteAdmission | undefined, options: {
  readonly execPath?: string; readonly platform?: string; readonly arch?: string; readonly version?: string; readonly bundled?: boolean;
} = {}): OriginalDarwinDaemonInstallation | undefined {
  const { execPath = process.execPath, platform = process.platform, arch = process.arch, version = COMPILED_VERSION,
    bundled = isCompiledBunModuleUrl(import.meta.url) } = options;
  if (platform !== 'darwin' || !bundled || detectInstallKind(execPath) !== 'binary') return undefined;
  if (!isAbsolute(execPath) || resolve(execPath) !== execPath || !sqlite || sqlite.execPath !== execPath || sqlite.owner.daemonVersion !== version) throw nativeStartupRefused('DARWIN_SQLITE_OWNER', 'Original compiled Darwin SQLite owner is unavailable');
  sqlite.assertCurrent();
  const targets = resolveDarwinDaemonTargets(execPath, arch); if (!targets) throw nativeStartupRefused('DARWIN_TARGET', 'Darwin daemon target is unsupported');
  const io = captureUpdateFileIo(realUpdateFileIo);
  const retained = sourceCheck(() => retainNativeUpdateSources(targets.flatMap(target => [target.path, target.path + '.previous']), io));
  const current = () => { sqlite.assertCurrent(); sourceCheck(retained); sqlite.assertCurrent(); };
  current(); const selected = Object.freeze({ execPath, version, assertCurrent: current });
  darwinOriginals.set(selected, Object.freeze({ sqlite, targets, io })); return selected;
}
/** Called exactly by the native entry before its first service import/await. */
export function initializeOriginalDarwinDaemonInstallation(sqlite: DaemonSqliteAdmission | undefined): void {
  if (earlyDarwinInstallation) { earlyDarwinInstallation.assertCurrent(); return; }
  earlyDarwinInstallation = captureOriginalDarwinDaemonInstallation(sqlite);
}

export const originalDarwinSelection = () => earlyDarwinInstallation;
export const originalDarwinProof = (selected: OriginalDarwinDaemonInstallation) => darwinOriginals.get(selected);
