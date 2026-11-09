/**
 * Resolve this executable's update-artifact identity without activating updates.
 * Install-kind is a path heuristic, not authentication of a compiled artifact.
 * The CLI/host must separately opt in to the facade's update lifecycle.
 */
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';
import type { GoodVibesHomeOwnership } from '@goodvibes-jev/engine/sdk/platform/config';
import type { DaemonUpdateArtifact } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { captureUpdateFileIo, isCompiledBunModuleUrl, DAEMON_NATIVE_TARGETS, inspectDaemonNativeInstallation, nativeReaderCapabilities, realUpdateFileIo,
  createNativeDataWriteOwner, createInstalledReaderCohort, type NativeDataWriteOwner,
  inspectDarwinDaemonInstallation,
  resolveDaemonNativePayloads, resolveDaemonNativeTargets, retainDaemonNativeFiles } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { detectInstallKind } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { COMPILED_VERSION, VERSION } from '../version.js';

export { captureOriginalDarwinDaemonInstallation, initializeOriginalDarwinDaemonInstallation } from './original-darwin-installation.js';
export type { OriginalDarwinDaemonInstallation } from './original-darwin-installation.js';
import { originalDarwinSelection, originalDarwinProof, type OriginalDarwinDaemonInstallation } from './original-darwin-installation.js';
const darwinWriters = new WeakMap<OriginalDarwinDaemonInstallation, NativeDataWriteOwner>();

export interface ResolveDaemonUpdateArtifactOptions {
  /** The executable to identify; defaults to process.execPath. */
  readonly execPath?: string;
  /** Injectable so tests can pin a fixture version. */
  readonly version?: string;
}

/** Returns no artifact for source or package-managed installs. */
export function resolveDaemonUpdateArtifact(
  options: ResolveDaemonUpdateArtifactOptions = {},
): DaemonUpdateArtifact | undefined {
  const execPath = options.execPath ?? process.execPath;
  if (detectInstallKind(execPath) !== 'binary') return undefined;
  return { version: options.version ?? VERSION, execPath };
}

export interface ResolveInstalledDaemonUpdateArtifactOptions extends ResolveDaemonUpdateArtifactOptions {
  readonly platform?: string;
  readonly arch?: string;
  /** Construction seam only; the real caller uses this module's compiled location. */
  readonly bundled?: boolean;
  /** Construction seam for inert native fixtures. Production reads the OS's
   * loaded executable, not the potentially replaced path in process.execPath. */
  readonly runningExecutableIdentity?: () => string;
  readonly signal?: AbortSignal;
  readonly darwinInstallation?: OriginalDarwinDaemonInstallation;
}

/** Only a compiled daemon owning a complete native installation can self-manage. */
export function resolveInstalledDaemonUpdateArtifact(
  ownership: Pick<GoodVibesHomeOwnership, 'isOverridden'>,
  options: ResolveInstalledDaemonUpdateArtifactOptions = {},
): DaemonUpdateArtifact | undefined {
  const { execPath = process.execPath, version = COMPILED_VERSION, platform = process.platform, arch = process.arch,
    bundled = isCompiledBunModuleUrl(import.meta.url), signal } = options;
  if (ownership.isOverridden || !bundled || detectInstallKind(execPath) !== 'binary') return undefined;
  signal?.throwIfAborted();
  if (!isAbsolute(execPath) || resolve(execPath) !== execPath) throw new Error('Native daemon executable must have an absolute normalized path');
  if (platform === 'darwin') {
    const selected = options.darwinInstallation ?? originalDarwinSelection(), proof = selected && originalDarwinProof(selected);
    if (!selected || !proof || selected.execPath !== execPath || selected.version !== version || proof.sqlite.owner.target !== `darwin-${arch}`) throw new Error('Original compiled Darwin daemon selection is unavailable');
    selected.assertCurrent();
    const installation = proof.installation ?? inspectDarwinDaemonInstallation(execPath, arch, '', proof.io, {
      expectedSqliteOwner: proof.sqlite.owner, assertCompiledSqliteCurrent: proof.sqlite.assertCurrent,
    });
    if (!installation || installation.version !== version || !installation.compiledSqliteVerified) throw new Error('Running Darwin daemon does not own a complete verified installation');
    selected.assertCurrent(); installation.assertCurrent();
    const actualReaders = nativeReaderCapabilities(version);
    if (installation.readers.formats.length !== actualReaders.formats.length || actualReaders.formats.some(format => !installation.readers.formats.includes(format))) throw new Error('Darwin daemon reader profile differs from its actual compiled readers');
    proof.installation = installation;
    const original = () => { signal?.throwIfAborted(); selected.assertCurrent(); installation.assertCurrent(); };
    const assertCurrent = () => {
      original();
      for (const member of proof.targets) for (const suffix of ['.update-transaction', '.update-download', '.update-previous', '.rollback-exchange']) {
        if (proof.io.exists(member.path + suffix)) throw new Error('Darwin daemon installation has an unfinished transaction');
      }
      original();
    };
    assertCurrent();
    return Object.freeze({ version, execPath, suite: true as const, assertCurrent, assertStarting: assertCurrent,
      currentReader: Object.freeze({ readers: actualReaders, assertCurrent: original }) });
  }
  const targets = resolveDaemonNativeTargets(execPath, platform, arch);
  if (!targets) return undefined;
  const io = captureUpdateFileIo(realUpdateFileIo);
  const runningImage = options.runningExecutableIdentity?.() ?? (() => {
    const stat = statSync('/proc/self/exe', { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  })();
  if (io.observe?.(execPath)?.ownerIdentity !== runningImage) throw new Error('Running daemon image differs from the installed executable');
  // Transient slots are not a settled installation, including foreign-target slots.
  const paths = [...targets.map(target => target.path), ...DAEMON_NATIVE_TARGETS.flatMap(target =>
    (resolveDaemonNativePayloads('linux', target.slice('linux-'.length)) ?? []).map(payload => join(dirname(execPath), payload.relativePath)))];
  const assertIdle = () => {
    for (const path of paths) for (const suffix of ['.update-transaction', '.update-download', '.update-previous', '.rollback-exchange']) {
      if (io.exists(path + suffix)) throw new Error('Native daemon installation has an unfinished transaction');
    }
  };
  assertIdle();
  const assertInstallationCurrent = retainDaemonNativeFiles(targets, io);
  const receipt = inspectDaemonNativeInstallation(execPath, platform, arch, '', io, { integrity: false });
  if (!receipt || receipt.version !== version) throw new Error('Running daemon does not own the installed native version');
  const assertRetained = () => { signal?.throwIfAborted(); assertInstallationCurrent(); assertIdle(); };
  let verifiedCurrent = false;
  const assertCurrent = () => {
    assertRetained();
    if (!verifiedCurrent) {
      inspectDaemonNativeInstallation(execPath, platform, arch, '', io);
      assertRetained();
      verifiedCurrent = true;
    }
  };
  let assertStarting = assertCurrent;
  let healthyCurrent = true;
  try { assertCurrent(); }
  catch (error) {
    healthyCurrent = false;
    // A damaged current build can only reach the existing native crash-loop
    // recovery owner; normal startup still has to pass assertCurrent.
    assertRetained();
    if (!inspectDaemonNativeInstallation(execPath, platform, arch, '.previous', io)) throw error;
    assertRetained();
    assertStarting = assertRetained;
  }
  assertStarting();
  const currentReader = Object.freeze({ readers: nativeReaderCapabilities(version), assertCurrent: () => {
    signal?.throwIfAborted();
    if (!healthyCurrent) throw new Error('Damaged current daemon cannot issue reader evidence');
    // The canonical updater owns its transaction slots by the time it asks
    // again. Retain the original healthy files without treating its own claims
    // as an unrelated unfinished installation. Publication still owns all slots.
    assertInstallationCurrent();
  } });
  return Object.freeze({ version, execPath, suite: true as const, currentReader, assertStarting, assertCurrent });
}

/** Config/migration publication uses the same original complete Darwin owner as
 * serving. Lazy construction keeps metadata-only CI commands independent of an
 * installed reader sidecar that this very build is about to emit. */
export function createOriginalDarwinDaemonDataWriter(selected: OriginalDarwinDaemonInstallation | undefined = originalDarwinSelection()): NativeDataWriteOwner | undefined {
  if (!selected) return undefined;
  const proof = originalDarwinProof(selected); if (!proof) throw new Error('Original Darwin data publisher is unavailable');
  selected.assertCurrent(); const saved = darwinWriters.get(selected); if (saved) return saved;
  const arch = proof.sqlite.owner.target.slice('darwin-'.length);
  const artifact = resolveInstalledDaemonUpdateArtifact({ isOverridden: false }, { execPath: selected.execPath, version: selected.version,
    platform: 'darwin', arch, bundled: true, darwinInstallation: selected });
  if (!artifact?.assertCurrent) throw new Error('Original complete Darwin data publisher is unavailable');
  const writer = createNativeDataWriteOwner({ execPath: selected.execPath, version: selected.version, assertCurrent: artifact.assertCurrent,
    readerCohort: createInstalledReaderCohort({ execPath: selected.execPath, version: selected.version, platform: 'darwin', arch }) });
  darwinWriters.set(selected, writer); return writer;
}
