/** Download all selected products and directory assets before one admitted
 * suite replacement. Individual renames are reversible, not crash-atomic.
 * Actual products use this implementation instead of maintaining parallel
 * per-product downloaders.
 */
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyVerifiedUpdate, CHECKSUM_MANIFEST_NAME, DEFAULT_UPDATE_TIMEOUT_MS, parseChecksumFile, rollbackKeptPrevious, sha256, UpdateTransactionError,
  verifyChecksum, withUpdateBudget, type DaemonCurrentReader, type UpdateFetchLike, type UpdateRequestOptions } from './self-update.js';
import { assertStagedClientReaderCompatible } from './client-reader-update.js';
import { captureUpdateFileIo, hasNativeUpdateObservations, realUpdateFileIo, type UpdateFileIo } from './update-file-io.js';
import { NativeDirectoryUpdateError, prepareNativeDirectoryRollback, prepareNativeUpdateDirectory, retainNativeUpdateTree, type NativeUpdateDirectory } from './update-directories.js';
import { resolveSuiteUpdatePlan, type SuiteProgram, type SuiteUpdatePlan } from './suite-update-plan.js';
import { inspectDaemonNativeInstallation, resolveDaemonInstallationReaders, resolveDaemonNativeTargets } from './daemon-native-cohort.js';
import { assertNativeReaderCompatible, nativeReaderCapabilities } from './native-reader-compatibility.js';
import { parseClientReaderArtifact } from './client-reader-artifact.js';

export interface SuiteUpdateOptions extends UpdateRequestOptions {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly version: string;
  readonly downloadBaseUrl: string;
  readonly fetchImpl: UpdateFetchLike;
  readonly webuiDirectory?: string | undefined;
  readonly io?: UpdateFileIo;
  readonly currentReader?: DaemonCurrentReader | undefined;
  /** The invoking product's actual lifecycle/admission restriction. */
  readonly assertCurrent?: (() => void) | undefined;
  readonly beforeCommit?: (() => void) | undefined;
}
export interface SuiteUpdateResult {
  readonly version: string;
  readonly programs: readonly SuiteProgram[];
  readonly files: readonly { readonly label: string; readonly path: string }[];
  readonly directoryPaths: readonly string[];
  /** Earlier unlabelled backups are retained instead of deleted by filename. */
  readonly preservedPaths: readonly string[];
}
export class SuiteUpdateRecoveryError extends Error {
  override readonly name = 'SuiteUpdateRecoveryError';
  readonly recoveryRequired = true;
  constructor(readonly paths: readonly string[], readonly problems: readonly unknown[], cause: unknown, readonly committed = false) {
    super('The suite update requires recovery. Inspect its retained files and transaction claims before retrying.', { cause });
  }
}
export class SuiteUpdatePreparationError extends Error {
  override readonly name = 'SuiteUpdatePreparationError';
  readonly recoveryRequired = false;
  constructor(readonly preservedPaths: readonly string[], cause: unknown) {
    super(`The suite update did not replace the installation. Discarded staging was preserved at: ${preservedPaths.join(', ')}`, { cause });
  }
}
/** Unknown committed/partially restored files must not be followed by ordinary
 * product startup or another unattended update attempt. */
export function suiteUpdateRequiresRecovery(error: unknown): boolean {
  return error instanceof SuiteUpdateRecoveryError || error instanceof UpdateTransactionError && (error.receipt.committed || error.receipt.recoveryRequired);
}

/** Repair selection only. Metadata/version/presence does not admit a reader
 * or replace candidate integrity verification. Avoid rehashing every installed
 * program during each update check; native startup owns its image admission. */
export function installedSuiteNeedsRepair(options: {
  readonly execPath: string; readonly platform: string; readonly arch: string; readonly version: string;
  readonly webuiDirectory?: string | undefined; readonly io?: UpdateFileIo;
}): boolean {
  const io = captureUpdateFileIo(options.io ?? realUpdateFileIo);
  if (!hasNativeUpdateObservations(io, io.readFile, io.observe)) return false;
  try {
    const plan = resolveSuiteUpdatePlan({ ...options, io }), formats = nativeReaderCapabilities(plan.version).formats;
    for (const file of plan.files) if (io.observe?.(file.path)?.mode !== (file.executable ? 0o755 : 0o644)) return true;
    for (const program of plan.programs) {
      const profile = program.readerKind === 'linux-daemon' ? join(plan.root, 'daemon-installation.json') : program.path + '.readers.json';
      const stat = lstatSync(profile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return true;
      const readers = program.readerKind === 'linux-daemon'
        ? inspectDaemonNativeInstallation(program.path, options.platform, options.arch, '', io, { integrity: false })?.artifact.readers
        : (() => {
          const artifact = parseClientReaderArtifact(JSON.parse(readFileSync(profile, 'utf8')));
          if (artifact.packageName !== program.packageName || artifact.target !== plan.target || artifact.target.startsWith('linux-') && artifact.files.length !== 4) return undefined;
          return artifact.readers;
        })();
      if (!readers || readers.version !== plan.version || formats.some(format => !readers.formats.includes(format))) return true;
    }
    for (const directory of plan.directories) {
      const marker = join(directory.path, '.goodvibes-release.json'), stat = lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return true;
      const value: unknown = JSON.parse(readFileSync(marker, 'utf8'));
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== plan.version) return true;
      for (const file of directory.requiredFiles) if (!lstatSync(join(directory.path, file)).isFile()) return true;
    }
    plan.assertCurrent(); return false;
  } catch { return true; }
}
/** Same precedence as the daemon's actual static-bundle serving posture. */
export function configuredSuiteWebuiDirectory(config: { get(key: string): unknown }): string | undefined {
  for (const key of ['controlPlane.webui.bundleDir', 'web.staticAssetsDir']) {
    const value = config.get(key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
function synchronous(operation: (() => void) | undefined): void {
  const value: unknown = operation?.();
  if (value !== undefined) { drainOwned(value); throw new Error('Suite update admission must complete synchronously'); }
}
function nativeDaemon(plan: SuiteUpdatePlan) {
  return plan.programs.find(program => program.readerKind === 'linux-daemon');
}

export async function applySuiteUpdate(options: SuiteUpdateOptions): Promise<SuiteUpdateResult> {
  // Capture host methods and effect-bearing choices before any network await.
  options = { ...options, io: captureUpdateFileIo(options.io ?? realUpdateFileIo) };
  const io = options.io!, deadline = performance.now() + (options.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS);
  const current = () => {
    options.signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('Suite update deadline exceeded');
    synchronous(options.assertCurrent);
  };
  current();
  const plan = resolveSuiteUpdatePlan(options), daemon = nativeDaemon(plan);
  const directories = plan.directories.map(selection => ({ selection, original: retainNativeUpdateTree(selection.path) }));
  const selected = () => { current(); plan.assertCurrent(); for (const directory of directories) directory.original.assertCurrent(); };
  const remaining = () => { current(); return Math.max(Number.EPSILON, deadline - performance.now()); };
  const prepared: NativeUpdateDirectory[] = [];
  let committed = false;
  try {
    selected();
    const manifest = await withUpdateBudget({ ...(options.signal ? { signal: options.signal } : {}), timeoutMs: remaining() }, async signal => {
      const response = await options.fetchImpl(`${options.downloadBaseUrl}/${CHECKSUM_MANIFEST_NAME}`, { signal });
      signal.throwIfAborted(); selected();
      if (!response.ok) throw new Error('Suite release checksum manifest download failed');
      const text = await response.text(); signal.throwIfAborted(); selected();
      const checksums = parseChecksumFile(text);
      // A current suite release is complete. Missing members never downgrade
      // to a binary-only update or a source build on the user's machine.
      for (const file of plan.files) if (!checksums.has(file.assetName)) throw new Error(`Suite release is missing ${file.assetName}`);
      const archives: { readonly selection: typeof plan.directories[number]; readonly bytes: Buffer }[] = [];
      for (const { selection } of directories) {
        const expected = checksums.get(selection.assetName);
        if (!expected) throw new Error(`Suite release is missing ${selection.assetName}`);
        const response = await options.fetchImpl(`${options.downloadBaseUrl}/${selection.assetName}`, { signal });
        signal.throwIfAborted(); selected();
        if (!response.ok) throw new Error(`Suite directory asset download failed: ${selection.assetName}`);
        const bytes = Buffer.from(await response.arrayBuffer()); signal.throwIfAborted(); selected();
        // One published archive integrity check at download, never a runtime
        // directory identity or a repeated per-file checksum scan.
        verifyChecksum(selection.assetName, sha256(bytes), expected);
        archives.push({ selection, bytes });
      }
      return { text, archives };
    });
    selected();
    for (const [index, archive] of manifest.archives.entries()) {
      selected();
      prepared.push(prepareNativeUpdateDirectory(archive.selection.path, archive.bytes, {
        stripComponents: 1, expectedRoot: archive.selection.archiveRoot, requiredFiles: archive.selection.requiredFiles, assertCurrent: current,
        retainedTarget: directories[index]!.original, sourceVersion: plan.version,
      }));
    }
    selected();
    const fetchImpl: UpdateFetchLike = (url, init) => url === `${options.downloadBaseUrl}/${CHECKSUM_MANIFEST_NAME}`
      ? Promise.resolve(new Response(manifest.text)) : options.fetchImpl(url, init);
    const daemonTargets = daemon ? resolveDaemonNativeTargets(daemon.path, options.platform, options.arch) ?? [] : [];
    const daemonPaths = new Set(daemonTargets.map(file => file.path));
    await applyVerifiedUpdate({ fetchImpl, downloadBaseUrl: options.downloadBaseUrl, targets: plan.files, io,
      platform: options.platform, native: true, readerExecPath: options.execPath,
      ...(options.signal ? { signal: options.signal } : {}), timeoutMs: remaining(), assertCurrent: current,
      ...(daemon ? { daemonNative: { execPath: daemon.path, platform: options.platform, arch: options.arch, version: plan.version,
        additionalTargets: plan.files.filter(file => !daemonPaths.has(file.path)),
        ...(options.currentReader ? { currentReader: options.currentReader } : {}) } } : {}),
      beforeCommit(stage) {
        selected();
        for (const program of plan.programs) if (program.readerKind === 'client') {
          assertStagedClientReaderCompatible(program.path, program.path + '.update-download', io, plan.version, program.assetName, stage, true);
        }
        synchronous(options.beforeCommit); selected();
        for (const directory of prepared) directory.assertCurrent();
        for (const directory of prepared) directory.commit();
      },
    });
    committed = true;
    const preservedPaths: string[] = [];
    for (const directory of prepared) preservedPaths.push(...directory.finish().preservedPaths);
    return Object.freeze({ version: plan.version, programs: Object.freeze(plan.programs.map(program => program.name)),
      files: Object.freeze(plan.files.map(file => Object.freeze({ label: file.label, path: file.path }))),
      directoryPaths: Object.freeze(plan.directories.map(directory => directory.path)), preservedPaths: Object.freeze(preservedPaths) });
  } catch (error) {
    const uncertain = committed || error instanceof UpdateTransactionError && (error.receipt.committed || error.receipt.recoveryRequired)
      || error instanceof NativeDirectoryUpdateError && error.recoveryRequired;
    if (uncertain) {
      // Leave directory ownership fences intact alongside the actual core
      // transaction receipt. No speculative rollback against unknown bytes.
      for (const directory of prepared) directory.preserve();
      throw new SuiteUpdateRecoveryError(plan.directories.map(directory => directory.path), [], error,
        committed || error instanceof UpdateTransactionError && error.receipt.committed);
    }
    const problems: unknown[] = [], preservedPaths: string[] = [];
    for (const directory of [...prepared].reverse()) {
      try { directory.restore(); preservedPaths.push(...directory.dispose().preservedPaths); } catch (failure) { problems.push(failure); }
    }
    if (problems.length) throw new SuiteUpdateRecoveryError(plan.directories.map(directory => directory.path), problems, error);
    if (preservedPaths.length) throw new SuiteUpdatePreparationError(Object.freeze(preservedPaths), error);
    throw error;
  }
}

export interface SuiteRollbackOptions {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly webuiDirectory?: string | undefined;
  readonly io?: UpdateFileIo;
  readonly assertCurrent?: (() => void) | undefined;
  readonly beforeCommit?: (() => void) | undefined;
}

/** Restore the complete selected suite together, including its directory
 * assets. Missing or disagreeing previous products refuse before any rename.
 * The original saved release pins are checked once during rollback admission.
 */
export function rollbackSuiteUpdate(options: SuiteRollbackOptions): SuiteUpdateResult {
  const io = captureUpdateFileIo(options.io ?? realUpdateFileIo);
  if (!io.readFile || !io.observe) throw new Error('Suite rollback requires retained native file observations');
  const plan = resolveSuiteUpdatePlan({ ...options, io, version: options.currentVersion });
  const directories: NativeUpdateDirectory[] = [];
  let committed = false, previousVersion: string | undefined;
  try {
    synchronous(options.assertCurrent); plan.assertCurrent();
    for (const selection of plan.directories) directories.push(prepareNativeDirectoryRollback(selection.path, { assertCurrent: options.assertCurrent }));
    const result = rollbackKeptPrevious(plan.files, io, () => {
      synchronous(options.assertCurrent); plan.assertCurrent();
      for (const program of plan.programs) {
        let version: string;
        if (program.readerKind === 'linux-daemon') {
          const previous = inspectDaemonNativeInstallation(program.path, options.platform, options.arch, '.previous', io);
          const installed = inspectDaemonNativeInstallation(program.path, options.platform, options.arch, '', io, { integrity: false });
          if (!previous || !installed) throw new Error('The complete previous daemon is unavailable');
          version = previous.version;
          assertNativeReaderCompatible(program.path, version, io, resolveDaemonInstallationReaders(previous, installed));
        } else {
          const metadata = io.readFile!(program.path + '.readers.json.previous');
          if (metadata.byteLength > 128 * 1024) throw new Error('Previous suite reader metadata is invalid');
          const artifact = parseClientReaderArtifact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)));
          if (artifact.packageName !== program.packageName || artifact.target !== plan.target) throw new Error('Previous suite reader identifies a different product');
          version = artifact.version;
          assertStagedClientReaderCompatible(program.path, program.path + '.previous', io, version, program.assetName, undefined, true);
        }
        if (previousVersion !== undefined && version !== previousVersion) throw new Error('Previous suite products have different release versions; refusing a mixed rollback');
        previousVersion = version;
      }
      if (!previousVersion || directories.some(directory => directory.previousVersion !== previousVersion)) {
        throw new Error('Previous suite directory assets do not confirm the same release as its programs');
      }
      synchronous(options.beforeCommit); plan.assertCurrent();
      for (const directory of directories) directory.assertCurrent();
      for (const directory of directories) directory.commit();
    }, { requireComplete: true, native: true, readerExecPath: options.execPath, ...(options.assertCurrent ? { assertCurrent: options.assertCurrent } : {}) });
    if (!result.restored.length || !previousVersion) throw new Error('The suite rollback did not restore a complete release');
    committed = true;
    const preservedPaths = directories.flatMap(directory => [...directory.finish().preservedPaths]);
    return Object.freeze({ version: previousVersion, programs: Object.freeze(plan.programs.map(program => program.name)),
      files: Object.freeze(plan.files.map(file => Object.freeze({ label: file.label, path: file.path }))),
      directoryPaths: Object.freeze(plan.directories.map(directory => directory.path)), preservedPaths: Object.freeze(preservedPaths) });
  } catch (error) {
    if (committed || error instanceof UpdateTransactionError && (error.receipt.committed || error.receipt.recoveryRequired)
      || error instanceof NativeDirectoryUpdateError && error.recoveryRequired) {
      for (const directory of directories) directory.preserve();
      throw new SuiteUpdateRecoveryError(plan.directories.map(directory => directory.path), [], error,
        committed || error instanceof UpdateTransactionError && error.receipt.committed);
    }
    const problems: unknown[] = [], preservedPaths: string[] = [];
    for (const directory of [...directories].reverse()) {
      try { directory.restore(); preservedPaths.push(...directory.dispose().preservedPaths); } catch (failure) { problems.push(failure); }
    }
    if (problems.length) throw new SuiteUpdateRecoveryError(plan.directories.map(directory => directory.path), problems, error);
    if (preservedPaths.length) throw new SuiteUpdatePreparationError(Object.freeze(preservedPaths), error);
    throw error;
  }
}

/** Actual host configuration getter, optional only for embedded callers that
 * do not serve an installed WebUI. Never guesses a bundle from old folders. */
export interface SuiteUpdateConfigurationSource { get?(key: string): unknown }
/** Capture effective daemon serving precedence before asynchronous preparation. */
export function retainSuiteUpdateConfiguration(config?: SuiteUpdateConfigurationSource): {
  readonly webuiDirectory: string | undefined;
  assertCurrent(): void;
} {
  const get = config?.get;
  const read = () => configuredSuiteWebuiDirectory({ get: key => get?.call(config, key) });
  const webuiDirectory = read();
  const assertCurrent = () => {
    if (config?.get !== get) throw new Error('Configured WebUI update selection changed');
    const selected = read();
    if (config?.get !== get || selected !== webuiDirectory) throw new Error('Configured WebUI update selection changed');
  };
  assertCurrent(); return Object.freeze({ webuiDirectory, assertCurrent });
}
