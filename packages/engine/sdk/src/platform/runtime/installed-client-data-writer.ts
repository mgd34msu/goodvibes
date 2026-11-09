/** A compiled terminal admits its own selected installation synchronously,
 * before CLI setup/awaits. This capability only restricts later readers; it
 * grants neither data access nor execution. Source and package-managed modules
 * never acquire an installation publisher from a pathname or environment hint. */
import { lstatSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { assertNativeReaderCompatible, nativeReaderCapabilities, createNativeDataWriteOwner, type NativeDataWriteOwner } from './native-reader-compatibility.js';
import { retainDaemonNativeFiles } from './daemon-native-cohort.js';
import { captureUpdateFileIo, realUpdateFileIo } from './update-file-io.js';

export interface InstalledClientDataOptions {
  readonly moduleUrl: string;
  readonly execPath: string;
  /** Exact baked version, never a nearby package.json or requested version. */
  readonly compiledVersion: string;
  readonly platform: string;
}
/** The compiler's actual virtual filesystem root, not a substring in an
 * ordinary checkout/package directory. The shipped targets use file URLs. */
export function isCompiledBunModuleUrl(moduleUrl: string): boolean {
  try {
    const parsed = new URL(moduleUrl);
    return parsed.protocol === 'file:' && parsed.hostname === '' && decodeURIComponent(parsed.pathname).startsWith('/$bunfs/');
  } catch { return false; }
}
export function admitInstalledClientDataWriter(options: InstalledClientDataOptions): NativeDataWriteOwner | undefined {
  if (!isCompiledBunModuleUrl(options.moduleUrl)) return undefined;
  const execPath = options.execPath, version = options.compiledVersion;
  if (!isAbsolute(execPath) || resolve(execPath) !== execPath) throw new Error('Installed data publisher requires an absolute original executable');
  const io = captureUpdateFileIo(realUpdateFileIo), original = io.observe?.(execPath);
  const file = lstatSync(execPath, { bigint: true });
  if (!original || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || (file.mode & 0o111n) === 0n) throw new Error('Installed data publisher image is unavailable');
  if (options.platform === 'linux') {
    const loaded = statSync('/proc/self/exe', { bigint: true });
    if (original.ownerIdentity !== `${loaded.dev}:${loaded.ino}`) throw new Error('OS-loaded terminal differs from its selected installed executable');
  }
  // Darwin has no loaded-inode API in Node/Bun. Its proof is the actual bundled
  // entry's synchronous initial physical selection, retained before any await.
  // Linux additionally proves that selection is the OS's loaded image above.
  const paths = [execPath, ...['.bun', '.bun.json', '.bun.LICENSE.md'].map(suffix => execPath + suffix).filter(path => io.exists(path))];
  const targets = paths.map(path => ({ label: 'installed terminal member', path, assetName: '', executable: path === execPath || path.endsWith('.bun') }));
  const retained = retainDaemonNativeFiles(targets, io);
  const assertCurrent = () => {
    retained();
    for (const path of paths) for (const suffix of ['.update-transaction', '.update-download', '.update-previous', '.rollback-exchange']) {
      if (io.exists(path + suffix)) throw new Error('Installed terminal has an unfinished publication transaction');
    }
  };
  // Construction is read-only. Unfinished swaps withhold publication when
  // declare() runs; metadata/help and explicit recovery remain reachable.
  return createNativeDataWriteOwner(Object.freeze({ execPath, version, assertCurrent }));
}

/** Metadata-only CLI; invoke before configuration/provider/runtime setup. */
export function installedReaderCommand(argv: readonly string[], compiledVersion: string): string | undefined {
  if (argv[0] !== 'check-install-reader') return undefined;
  if (argv.length !== 2) throw new Error('Usage: check-install-reader --describe|<installed-executable>');
  const readers = nativeReaderCapabilities(compiledVersion);
  if (argv[1] === '--describe') return JSON.stringify(readers);
  const selected = argv[1];
  if (!selected) throw new Error('Installed executable is required');
  assertNativeReaderCompatible(selected, compiledVersion, captureUpdateFileIo(realUpdateFileIo), readers);
  return JSON.stringify({ schema: 'goodvibes.install.reader-check', schemaVersion: 1, readerVersion: compiledVersion });
}
