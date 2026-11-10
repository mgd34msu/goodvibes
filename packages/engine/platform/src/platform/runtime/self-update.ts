import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { withVerifiedUpdateStage, type VerifiedUpdateStage, type VerifiedUpdateMember } from './verified-update-stage.js';
export { verifiedUpdateStageMembers } from './verified-update-stage.js';
export type { VerifiedUpdateStage, VerifiedUpdateMember } from './verified-update-stage.js';
export { applySuiteUpdate, assertSuiteUpdateCurrent, rollbackSuiteUpdate, configuredSuiteWebuiDirectory, retainSuiteUpdateConfiguration, installedSuiteNeedsRepair, suiteUpdateRequiresRecovery, SuiteUpdateRecoveryError, SuiteUpdatePreparationError } from './suite-update.js';
export type { SuiteUpdateOptions, SuiteUpdateResult, SuiteRollbackOptions, SuiteUpdateConfigurationSource } from './suite-update.js';
export { resolveSuiteUpdatePlan } from './suite-update-plan.js';
export type { SuiteUpdatePlan, SuiteProgram } from './suite-update-plan.js';
export { createInstalledReaderCohort } from './native-reader-cohort.js';
export { isCompiledBunModuleUrl } from '../utils/bun-module.js';
export { parseClientReaderArtifact, clientReaderAsset, clientReaderPayloadPaths, clientReaderMemberPath, clientReaderMemberAsset, assertClientReaderPayload } from './client-reader-artifact.js';
export { resolveDarwinDaemonTargets, inspectDarwinDaemonInstallation } from './darwin-daemon-installation.js';
export type { DarwinDaemonInstallation, DarwinDaemonSqliteOwner } from './darwin-daemon-installation.js';
export { resolveDaemonUpdateTargets, inspectDaemonUpdateInstallation } from './daemon-update-installation.js';
export type { ClientReaderArtifact, ClientReaderPackage, ClientReaderTarget } from './client-reader-artifact.js';
export { assertStagedClientReaderCompatible } from './client-reader-update.js';
export { admitInstalledClientDataWriter, installedReaderCommand } from './installed-client-data-writer.js';
export type { InstalledClientDataOptions } from './installed-client-data-writer.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
/**
 * Verified binary updates with owned staging and compensating cohort renames.
 * Individual same-filesystem renames are atomic; the cohort and the brief gap
 * between parking and replacing a live file are NOT filesystem-wide atomic.
 * Failed commits restore their prior state or retain an explicit recovery fence.
 * Process crashes require inspection of the retained transaction files; this is
 * not a power-loss durable journal or a guarantee against unrelated writers.
 */
import { createHash, randomUUID } from 'node:crypto';
import { captureUpdateFileIo, createOwnedNativeUpdateFile, retainNativeUpdateDirectory, hasNativeUpdateObservations, realUpdateFileIo, type OwnedNativeUpdateFile, type NativeUpdateDirectoryOwner, type UpdateFileIo } from './update-file-io.js';
export { captureUpdateFileIo, realUpdateFileIo, retainNativeUpdateDirectory, type NativeUpdateDirectoryOwner, type UpdateFileIo } from './update-file-io.js';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { compareSemanticVersions, parseSemanticVersion } from './semantic-version.js';
import { assertDaemonNativePayloadPins, createDaemonNativeRenameGuard, inspectDaemonNativeInstallation, parseDaemonCiArtifact, resolveDaemonNativeTargets, retainDaemonNativeFiles, type DaemonNativeTarget, type DaemonNativeRenameGuard, type DaemonPreviousReader, type DaemonInstallationReceipt, type DaemonCiArtifact } from './daemon-native-cohort.js';
import { assertNativeReaderCompatible, NATIVE_READER_REQUIREMENT_FILE, NATIVE_PREVIOUS_READER_RECEIPT_FORMAT, parseNativeReaderCapabilities, type NativeReaderCapabilities } from './native-reader-compatibility.js';
export { DAEMON_NATIVE_TARGETS, DAEMON_INSTALLATION_RECEIPT, assertDaemonNativePayloadBytes, assertDaemonNativePayloadPins, inspectDaemonNativeInstallation,
  parseDaemonCiArtifact, parseDaemonInstallationReceipt, resolveDaemonInstallationReaders, resolveDaemonNativePayloads, resolveDaemonNativeTargets, retainDaemonNativeFiles,
  type DaemonNativeTarget, type DaemonNativePayload, type DaemonArtifactSource, type DaemonCiArtifact, type DaemonInstallationReceipt, type DaemonPreviousReader } from './daemon-native-cohort.js';
export { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities, parseNativeReaderCapabilities, NativeDataCompatibilityError, NATIVE_READER_REQUIREMENT_FILE } from './native-reader-compatibility.js';
export type { NativeDataFormat, NativeDataWriteOwner, AdmittedNativeDataPublisher, NativeReaderCapabilities } from './native-reader-compatibility.js';

/**
 * The cadence half of the same mechanism, re-exported here so every consumer
 * reaches "when to look" and "what to do when something is found" through one
 * module instead of two competing update stories. See update-schedule.ts.
 */
export {
  BOOT_SETTLE_CHECK_DELAY_MS,
  DEFAULT_UPDATE_BUSY_RETRY_MS,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  PeriodicUpdateLoop,
  type PeriodicCheckOutcome,
  type PeriodicUpdateLoopOptions,
} from './update-schedule.js';

// ---------------------------------------------------------------------------
// Version + release-tag logic
// ---------------------------------------------------------------------------

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/** SemVer precedence, retaining the historical short-core `1.2` == `1.2.0` form. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (raw: string) => {
    const normalized = normalizeVersion(raw);
    const padded = normalized.replace(/^(\d+(?:\.\d+)?)(?=[-+]|$)/, (core) => core + (core.includes('.') ? '.0' : '.0.0'));
    const parsed = parseSemanticVersion(padded);
    if (!parsed) throw new Error(`invalid update version: ${raw}`);
    return parsed;
  };
  return compareSemanticVersions(parse(a), parse(b));
}

/** Extract only a valid SemVer tag from a releases/tag path, never a login page. */
export function parseReleaseTagFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  try {
    const url = new URL(location, 'https://release.invalid');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const match = /\/releases\/tag\/([^/]+)\/?$/.exec(url.pathname);
    const tag = match?.[1];
    return tag && parseSemanticVersion(normalizeVersion(tag)) ? tag : null;
  } catch {
    return null;
  }
}

/** Minimal fetch shape; injected implementations must not make filesystem changes. */
export interface UpdateFetchLike {
  (url: string, init?: { method?: string; redirect?: 'manual' | 'follow' | 'error'; signal?: AbortSignal }): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly url: string;
    readonly headers: { get(name: string): string | null };
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export interface UpdateRequestOptions {
  readonly signal?: AbortSignal;
  /** Whole operation budget, including response bodies. Defaults to two minutes. */
  readonly timeoutMs?: number;
}
export const DEFAULT_UPDATE_TIMEOUT_MS = 120_000;

/** Bound even injected fetch/body implementations that ignore AbortSignal. */
export async function withUpdateBudget<T>(options: UpdateRequestOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('update timeoutMs must be positive and finite');
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason ?? new Error('update cancelled'));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`update timed out after ${Math.ceil(timeoutMs)}ms`)), timeoutMs);
  let rejectAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    // Release a native transport/body left unread after a rejected response,
    // and stop any adapter that is still completing after losing the race.
    controller.abort(new Error('update request scope ended'));
  }
}

/** Validate a manual latest redirect against the caller's exact origin/repository. */
export async function resolveLatestReleaseTag(
  fetchImpl: UpdateFetchLike,
  releasesLatestUrl: string,
  options: UpdateRequestOptions = {},
): Promise<string> {
  const latest = new URL(releasesLatestUrl);
  if (!['https:', 'http:'].includes(latest.protocol) || latest.username || latest.password || latest.search || latest.hash
    || !latest.pathname.endsWith('/releases/latest')) throw new Error('invalid releases/latest URL');
  return await withUpdateBudget(options, async (signal) => {
    const response = await fetchImpl(releasesLatestUrl, { method: 'HEAD', redirect: 'manual', signal });
    signal.throwIfAborted();
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location || response.url !== releasesLatestUrl) {
      throw new Error(`could not resolve the latest release tag from ${releasesLatestUrl} (expected manual release redirect; status ${response.status})`);
    }
    const redirected = new URL(location, latest);
    const tag = parseReleaseTagFromLocation(redirected.href);
    const prefix = latest.pathname.slice(0, -'latest'.length) + 'tag/';
    if (!tag || redirected.origin !== latest.origin || redirected.pathname !== `${prefix}${tag}`) {
      throw new Error('could not resolve the latest release tag: untrusted or malformed release redirect');
    }
    return tag;
  });
}

// ---------------------------------------------------------------------------
// Release-artifact naming + checksum verification
// ---------------------------------------------------------------------------

export const CHECKSUM_MANIFEST_NAME = 'SHA256SUMS.txt';

export interface ReleaseArtifactNames {
  readonly app: string;
  readonly daemon: string;
}

/** Release-asset platform tag as used in artifact filenames ("linux" | "macos"). */
const PLATFORM_TAGS: Record<string, string> = {
  linux: 'linux',
  darwin: 'macos',
};

export function resolveArtifactNames(platform: string, arch: string): ReleaseArtifactNames | null {
  const platformTag = PLATFORM_TAGS[platform];
  if (!platformTag || (arch !== 'x64' && arch !== 'arm64')) {
    return null;
  }
  const suffix = `${platformTag}-${arch}`;
  return {
    app: `goodvibes-${suffix}`,
    daemon: `goodvibes-daemon-${suffix}`,
  };
}

export interface SqliteVecAsset {
  /** Release asset filename, e.g. `sqlite-vec-linux-x64.so`. */
  readonly assetName: string;
  /** Directory name the loader resolves, e.g. `sqlite-vec-linux-x64`. */
  readonly dirName: string;
  /** File the loader opens inside that directory, e.g. `vec0.so`. */
  readonly fileName: string;
}

/**
 * Names the sqlite-vec native addon for a platform/arch. Unlike the binaries
 * (whose release tag maps darwin to "macos"), the addon keeps the Node-style
 * platform tag because that is exactly what the extension loader resolves at
 * `<execDir>/lib/sqlite-vec-<platform>-<arch>/vec0.<suffix>`.
 */
export function resolveSqliteVecAsset(platform: string, arch: string): SqliteVecAsset | null {
  if ((platform !== 'linux' && platform !== 'darwin') || (arch !== 'x64' && arch !== 'arm64')) {
    return null;
  }
  const suffix = platform === 'darwin' ? 'dylib' : 'so';
  const dirName = `sqlite-vec-${platform}-${arch}`;
  return {
    assetName: `${dirName}.${suffix}`,
    dirName,
    fileName: `vec0.${suffix}`,
  };
}

export function sha256(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function parseChecksumFile(contents: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    const name = match[2]!;
    const digest = match[1]!.toLowerCase();
    if (checksums.has(name) && checksums.get(name) !== digest) throw new Error(`conflicting checksum entries for ${name}`);
    checksums.set(name, digest);
  }
  return checksums;
}

/** Require a manifest pin before fetching or hashing an artifact. */
export function requireChecksum(
  artifactName: string,
  expected: string | undefined,
  manifestName: string = CHECKSUM_MANIFEST_NAME,
): string {
  if (expected === undefined) {
    throw new Error(`no checksum entry for ${artifactName} in ${manifestName}, refusing to install an unverified binary`);
  }
  return expected;
}

/**
 * Verify a downloaded artifact's checksum against the parsed manifest.
 * An artifact with no entry in the manifest is a hard failure, identical
 * in severity to a mismatching entry, never treated as "unverifiable, so
 * skip the check". Throws naming the artifact and the manifest.
 */
export function verifyChecksum(
  artifactName: string,
  actual: string,
  expected: string | undefined,
  manifestName: string = CHECKSUM_MANIFEST_NAME,
): void {
  requireChecksum(artifactName, expected, manifestName);
  if (expected !== actual) {
    throw new Error(`checksum mismatch for ${artifactName}: expected ${expected}, got ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Owned staging, reversible cohort commit, and kept-previous rollback
// ---------------------------------------------------------------------------

export const PREVIOUS_FILE_SUFFIX = '.previous';

export interface UpdateTarget {
  readonly label: string;
  /** Absolute, normalized install path. */
  readonly path: string;
  readonly assetName: string;
  readonly executable: boolean;
}

export interface UpdateTransactionReceipt {
  readonly operation: 'update' | 'rollback';
  readonly phase: 'claim' | 'stage' | 'admission' | 'commit' | 'cleanup';
  /** True only if the complete requested cohort reached its new state. */
  readonly committed: boolean;
  readonly recoveryRequired: boolean;
  readonly targets: readonly string[];
  /** Owned paths retained for inspection; never automatically overwrite these. */
  readonly recoveryPaths: readonly string[];
  readonly recoveryErrors: readonly string[];
}

export class UpdateTransactionError extends Error {
  constructor(readonly receipt: UpdateTransactionReceipt, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${receipt.operation} ${receipt.phase} failed: ${detail}; `
      + (receipt.committed ? 'cohort committed' : 'cohort not committed')
      + (receipt.recoveryRequired ? '; recovery required, blind retry is fenced' : '; prior state restored'), { cause });
    this.name = 'UpdateTransactionError';
  }
}

interface TransactionPaths {
  readonly target: string;
  readonly previous: string;
  readonly stage: string;
  readonly saved: string;
  readonly exchange: string;
  readonly claim: string;
}
function assertSynchronousCurrent(current: (() => void) | undefined): void {
  let result: unknown;
  try { result = current?.(); } catch (error) { drainOwned(error); throw error; }
  if (result !== undefined) {
    drainOwned(result);
    throw new Error('update current restriction must complete synchronously without returning a value');
  }
}

function transactionPaths(target: string): TransactionPaths {
  return { target, previous: `${target}.previous`, stage: `${target}.update-download`,
    saved: `${target}.update-previous`, exchange: `${target}.rollback-exchange`, claim: `${target}.update-transaction` };
}

/** Reject duplicate, aliased lexical, ancestor, and reserved-slot target overlap. */
function validateTargets(targets: readonly { readonly path: string }[]): TransactionPaths[] {
  const paths = targets.map(({ path }) => {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`update target must be an absolute normalized path: ${path}`);
    return transactionPaths(path);
  });
  const claimed: string[] = [];
  for (const path of paths) {
    for (const value of Object.values(path)) {
      if (claimed.some((other) => other === value || other.startsWith(value + sep) || value.startsWith(other + sep))) {
        throw new Error(`overlapping update target namespace: ${value}`);
      }
      claimed.push(value);
    }
  }
  return paths;
}

/**
 * Synchronous after staging: no await can admit a second operation between
 * renames. Exclusive per-target claim files also fence cooperating processes.
 * Claims left by a crash or incomplete undo require inspection, never replay.
 */
/** Borrowed logical adapters still prove their original successful exclusive
 * creation through their own observations/bytes. This does not confer native
 * filesystem provenance or a verified native staging receipt. */
function createLogicalUpdateFile(path: string, bytes: Buffer, mode: number, io: UpdateFileIo): OwnedNativeUpdateFile {
  if (!io.writeExclusive || !io.remove) throw new Error('Exclusive update I/O is unavailable');
  const expectedBytes = Buffer.from(bytes);
  io.writeExclusive(path, bytes);
  let selected = path, observed = io.observe?.(path);
  const body = () => { if (io.readFile && !io.readFile(selected).equals(expectedBytes)) throw new Error('Update source bytes changed'); };
  body(); const originalOwner = observed?.ownerIdentity;
  io.chmod(path, mode);
  if (io.observe) { const after = io.observe(path); if (!after || after.ownerIdentity !== originalOwner) throw new Error('Update creation source changed'); observed = after; }
  const assertAt = (path: string) => {
    if (path !== selected || !io.exists(path)) throw new Error('Update source is unavailable');
    if (io.observe) { const current = io.observe(path); if (!current || !observed || current.identity !== observed.identity || current.ownerIdentity !== observed.ownerIdentity || current.mode !== observed.mode) throw new Error('Update original source changed'); }
    body();
  };
  return { assertAt, renamed(from, to) {
    if (from !== selected || io.exists(from)) throw new Error('Update rename source changed'); selected = to;
    if (io.observe) { const after = io.observe(to); if (!after || after.ownerIdentity !== originalOwner) throw new Error('Update rename ownership changed'); observed = after; }
    assertAt(to);
  }, removeAt(path) { assertAt(path); io.remove!(path); }, close() {} };
}
function acquireUpdateReaderLease(execPath: string, io: UpdateFileIo, physical: () => void): () => void {
  const path = join(dirname(execPath), NATIVE_READER_REQUIREMENT_FILE + '.lock'); physical();
  if (hasNativeUpdateObservations(io, io.readFile, io.observe)) {
    const release = tryAcquireCrossProcessLock(path, { assertCurrent: physical });
    if (!release) throw new Error('Another native reader requirement publication is active');
    return release;
  }
  const bytes = Buffer.from(JSON.stringify({ pid: process.pid, token: randomUUID().replace(/-/g, '').slice(0, 16), acquiredAt: Date.now() }));
  const lease = createLogicalUpdateFile(path, bytes, 0o600, io); let released = false;
  return () => { if (released) return; released = true; physical(); lease.removeAt(path); lease.close(); };
}

function transact(
  operation: 'update' | 'rollback',
  paths: readonly TransactionPaths[],
  io: UpdateFileIo,
  stage: (write: (path: string, bytes: Buffer, mode: number) => void) => void,
  beforeCommit: (() => void) | undefined,
  commit: (rename: (from: string, to: string) => void) => void,
  restrictions: { readonly current?: () => void; readonly directory?: NativeUpdateDirectoryOwner; readonly readerExecPath?: string; readonly prepareNativeGuard?: () => DaemonNativeRenameGuard; readonly retainPublication?: ((assertCurrent: () => void) => void) | undefined } = {},
): void {
  if (paths.length === 0) return;
  if (!io.writeExclusive || !io.remove) throw new Error('update I/O adapter must support writeExclusive and remove; refusing mutation');
  const claims: string[] = [], staged: string[] = [];
  const created = new Map<string, OwnedNativeUpdateFile>();
  const creators = new Set<OwnedNativeUpdateFile>(), activeClaims = new Set<string>();
  const journal: Array<{ from: string; to: string }> = [];
  let phase: UpdateTransactionReceipt['phase'] = 'claim', committed = false, blockedClaim = false, blockedStage = false;
  let nativeGuard: DaemonNativeRenameGuard | undefined, readerLease: (() => void) | undefined;
  const nativeIo = hasNativeUpdateObservations(io, io.readFile, io.observe);
  const physical = () => restrictions.directory?.assertCurrent();
  const assertClaims = () => { for (const claim of activeClaims) { const owner = created.get(claim); if (!owner) throw new Error('Native update claim is unavailable'); owner.assertAt(claim); } };
  const current = () => { physical(); assertClaims(); assertSynchronousCurrent(restrictions.current); physical(); assertClaims(); };
  const claimData = Buffer.from(JSON.stringify({ operation, targets: paths, instruction: 'Interrupted transaction: inspect retained files before removing any fence. Do not blindly retry.' }));
  const create = (path: string, bytes: Buffer, mode: number) => {
    current();
    const owner = nativeIo ? createOwnedNativeUpdateFile(path, bytes, mode, physical) : createLogicalUpdateFile(path, bytes, mode, io);
    created.set(path, owner); creators.add(owner); return owner;
  };
  const move = (from: string, to: string, recovering: boolean) => {
    if (recovering) { physical(); assertClaims(); } else current();
    nativeGuard?.beforeRename(from, to, recovering);
    const owner = created.get(from); owner?.assertAt(from);
    if (io.exists(to)) throw new Error(`transaction destination is occupied: ${to}`);
    io.rename(from, to); if (!recovering) journal.push({ from, to });
    if (owner) { owner.renamed(from, to); created.delete(from); created.set(to, owner); }
    nativeGuard?.afterRename(from, to, recovering); physical();
  };
  const removeCreated = (path: string) => {
    physical();
    const owner = created.get(path);
    if (owner) { owner.removeAt(path); created.delete(path); activeClaims.delete(path); }
    else if (io.exists(path)) throw new Error('Update cleanup source is foreign or unconfirmed');
  };
  const removeBackup = (path: string) => {
    physical(); if (!io.exists(path)) return;
    nativeGuard?.beforeRemove(path); io.remove!(path); nativeGuard?.afterRemove(path); physical();
  };
  try {
    for (const path of [...paths].sort((a, b) => a.target.localeCompare(b.target))) {
      current();
      if (restrictions.directory) restrictions.directory.ensure(dirname(path.target)); else io.mkdir(dirname(path.target));
      current();
      try { create(path.claim, claimData, 0o600); }
      catch (error) { blockedClaim = true; try { physical(); blockedClaim = io.exists(path.claim); } catch { /* Unknown creation retains its fence. */ } throw error; }
      claims.push(path.claim); activeClaims.add(path.claim); current();
    }
    for (const path of paths) for (const slot of [path.stage, path.saved, path.exchange]) {
      physical(); if (io.exists(slot)) throw new Error(`unresolved update recovery file: ${slot}`);
    }
    phase = 'stage';
    stage((path, bytes, mode) => {
      try { create(path, bytes, mode); staged.push(path); current(); }
      catch (error) { if (!created.has(path)) { blockedStage = true; try { physical(); blockedStage = io.exists(path); } catch { /* Unknown stage is retained. */ } } throw error; }
    });
    phase = 'admission';
    nativeGuard = restrictions.prepareNativeGuard?.();
    if (restrictions.readerExecPath) readerLease = acquireUpdateReaderLease(restrictions.readerExecPath, io, physical);
    let admission: unknown;
    try { admission = beforeCommit?.(); } catch (error) { drainOwned(error); throw error; }
    if (admission !== undefined) { drainOwned(admission); throw new Error('beforeCommit must complete synchronously without returning a value'); }
    current();
    phase = 'commit'; commit((from, to) => move(from, to, false)); committed = true;
    phase = 'cleanup';
    for (const path of paths) removeBackup(path.saved);
    for (const path of staged) removeCreated(path);
    if (restrictions.retainPublication) {
      if (!nativeGuard) throw new Error('Native publication observation is unavailable');
      nativeGuard.assertCurrent();
      let retained: unknown;
      try { retained = restrictions.retainPublication(nativeGuard.assertCurrent.bind(nativeGuard)); }
      catch (error) { drainOwned(error); throw error; }
      if (retained !== undefined) { drainOwned(retained); throw new Error('Publication observation must complete synchronously'); }
      nativeGuard.assertCurrent();
    }
    for (const claim of claims) removeCreated(claim);
    readerLease?.(); readerLease = undefined;
  } catch (cause) {
    const recoveryErrors: string[] = [];
    const attempt = (action: () => void) => { try { action(); } catch (error) { recoveryErrors.push(error instanceof Error ? error.message : String(error)); } };
    if (!committed) for (const { from, to } of [...journal].reverse()) attempt(() => move(to, from, true));
    if (recoveryErrors.length === 0 && !committed) for (const path of staged) attempt(() => removeCreated(path));
    const staleSlot = phase === 'claim' && claims.length === paths.length;
    const needsFence = committed || recoveryErrors.length > 0 || staleSlot || blockedStage;
    if (!needsFence) for (const claim of claims) attempt(() => removeCreated(claim));
    if (needsFence) for (const claim of claims) attempt(() => { physical(); if (!io.exists(claim)) { create(claim, claimData, 0o600); activeClaims.add(claim); } });
    const recoveryRequired = needsFence || recoveryErrors.length > 0 || blockedClaim;
    const recoveryPaths: string[] = [];
    for (const path of paths) for (const slot of Object.values(path)) {
      try { physical(); if (io.exists(slot)) recoveryPaths.push(slot); } catch { recoveryPaths.push(slot); }
    }
    throw new UpdateTransactionError({ operation, phase, committed, recoveryRequired,
      targets: paths.map(path => path.target), recoveryPaths: recoveryRequired ? recoveryPaths : [], recoveryErrors }, cause);
  } finally {
    try { readerLease?.(); } catch { /* The transaction receipt already retains physical ambiguity. */ }
    for (const owner of creators) try { owner.close(); } catch { /* Never close a different reused descriptor. */ }
  }
}

interface StagedUpdate {
  readonly target: UpdateTarget;
  readonly buffer: Buffer;
}

function installVerifiedBuffers(
  verified: readonly StagedUpdate[], io: UpdateFileIo, _platform: NodeJS.Platform, beforeCommit?: () => void,
  restrictions: { readonly current?: () => void; readonly directory?: NativeUpdateDirectoryOwner; readonly readerExecPath?: string; readonly prepareNativeGuard?: () => DaemonNativeRenameGuard; readonly retainPublication?: ((assertCurrent: () => void) => void) | undefined } = {},
): void {
  const paths = validateTargets(verified.map(({ target }) => target));
  transact('update', paths, io, (write) => {
    for (let index = 0; index < verified.length; index += 1) {
      const { target, buffer } = verified[index]!;
      const path = paths[index]!;
      write(path.stage, buffer, target.executable ? 0o755 : 0o644);
    }
  }, beforeCommit, (rename) => {
    for (const path of paths) {
      if (io.exists(path.target)) {
        if (io.exists(path.previous)) rename(path.previous, path.saved);
        rename(path.target, path.previous);
      }
      rename(path.stage, path.target);
    }
  }, restrictions);
}

/**
 * Legacy public name. Stages beside the target and compensates failed renames;
 * parking then installing is NOT a gapless atomic replacement.
 */
export function swapFileAtomically(
  targetPath: string,
  buffer: Buffer,
  options: { executable: boolean; io?: UpdateFileIo; platform?: NodeJS.Platform },
): void {
  installVerifiedBuffers([{ target: { label: targetPath, path: targetPath, assetName: '', executable: options.executable }, buffer: Buffer.from(buffer) }],
    options.io ?? realUpdateFileIo, options.platform ?? process.platform);
}

export interface DaemonCurrentReader {
  readonly readers: NativeReaderCapabilities;
  readonly assertCurrent: () => void;
}

export interface ApplyVerifiedUpdateOptions extends UpdateRequestOptions {
  readonly fetchImpl: UpdateFetchLike;
  readonly downloadBaseUrl: string;
  readonly targets: readonly UpdateTarget[];
  readonly io?: UpdateFileIo;
  readonly platform?: NodeJS.Platform;
  /** Final synchronous admission/cancellation check AFTER all staging, BEFORE live renames. This is not a work-admission lease. */
  readonly beforeCommit?: (stage: VerifiedUpdateStage) => void;
  /** Native daemon publication requires its complete payload and source-receipt cohort. */
  readonly daemonNative?: { readonly execPath: string; readonly platform: string; readonly arch: string; readonly version: string; readonly allowLegacyBinary?: boolean;
    /** Explicit host-owned extra suite members. The complete fixed daemon
     * cohort still comes first and retains its original receipt semantics. */
    readonly additionalTargets?: readonly UpdateTarget[];
    /** Actual outgoing program's compiled readers and original installation
     * owner. Host-only input; candidate version strings establish no support. */
    readonly currentReader?: DaemonCurrentReader };
  /** Offline first-install companion. All five payloads still require their
   * independently expected source pins. The updater itself derives the sixth
   * fixed receipt after payload admission; it has no synthetic release pin. */
  readonly generatedDaemonReceipt?: { readonly artifact: DaemonCiArtifact; readonly version: string };
  /** Preserve physical ownership for an already admitted complete native cohort. */
  readonly native?: boolean;
  /** Explicit installation root for the shared saved-data reader lease. */
  readonly readerExecPath?: string;
  /** Synchronous native publication observation while the original claims are
   * held. Failure retains a committed recovery receipt; it is not a UI notification. */
  readonly retainPublication?: ((assertCurrent: () => void) => void) | undefined;
  /** Construction-owned effect lifetime, checked before each forward native filesystem mutation. */
  readonly assertCurrent?: () => void;
}

/** Download and verify the entire cohort before staging; stage it all before commit. */
export async function applyVerifiedUpdate(options: ApplyVerifiedUpdateOptions): Promise<void> {
  // TypeScript readonly is not runtime ownership. Capture every effect-bearing
  // value before the first await, including adapter methods and each member.
  options = { ...options, io: captureUpdateFileIo(options.io ?? realUpdateFileIo),
    targets: options.targets.map((target) => ({ ...target })), ...(options.daemonNative ? { daemonNative: { ...options.daemonNative,
      ...(options.daemonNative.additionalTargets ? { additionalTargets: options.daemonNative.additionalTargets.map(target => ({ ...target })) } : {}) } } : {}) };
  validateTargets(options.targets);
  let generatedReceipt: { readonly artifact: DaemonCiArtifact; readonly version: string; readonly target: UpdateTarget } | undefined;
  if (options.generatedDaemonReceipt) {
    if (!options.native || options.daemonNative) throw new Error('Generated daemon receipt requires one offline native cohort');
    const candidate = options.generatedDaemonReceipt;
    const artifact = parseDaemonCiArtifact(structuredClone(candidate.artifact), candidate.artifact.target);
    const version = normalizeVersion(candidate.version), executable = options.targets[0];
    const expected = executable && resolveDaemonNativeTargets(executable.path, 'linux', artifact.target.slice('linux-'.length));
    if (!parseSemanticVersion(version) || !expected || options.targets.length !== expected.length || expected.some((target, index) => {
      const actual = options.targets[index];
      return !actual || actual.path !== target.path || actual.label !== target.label || actual.executable !== target.executable;
    }) || artifact.schema === 2 && artifact.readers.version !== version) throw new Error('Generated daemon receipt target or version is invalid');
    generatedReceipt = { artifact, version, target: options.targets[options.targets.length - 1]! };
  }
  const native = options.daemonNative;
  const readerExecPath = options.readerExecPath ?? native?.execPath ?? (options.native ? options.targets[0]?.path : undefined);
  if (readerExecPath && (!isAbsolute(readerExecPath) || resolve(readerExecPath) !== readerExecPath)) throw new Error('Native reader executable must be absolute and normalized');
  const capturedIo = options.io ?? realUpdateFileIo;
  const directory = readerExecPath && hasNativeUpdateObservations(capturedIo, capturedIo.readFile, capturedIo.observe)
    ? retainNativeUpdateDirectory(dirname(readerExecPath), options.targets.map(target => dirname(target.path))) : undefined;
  const verifiedMembers = new Map<string, VerifiedUpdateMember>();
  let assertStagedCurrent: (() => void) | undefined;
  let nativeStage = false;
  let nativeReaders: NativeReaderCapabilities | undefined;
  let previousReader: DaemonPreviousReader | undefined;
  const readerOwner = native?.currentReader;
  const readerGuard = readerOwner?.assertCurrent.bind(readerOwner);
  const currentReaders = readerOwner ? parseNativeReaderCapabilities(readerOwner.readers) : undefined;
  let assertNativeCurrent: (() => void) | undefined;
  let daemonTargets: readonly UpdateTarget[] = [];
  if (native) {
    const expected = resolveDaemonNativeTargets(native.execPath, native.platform, native.arch);
    if (!expected || JSON.stringify(options.targets) !== JSON.stringify([...expected, ...(native.additionalTargets ?? [])]) || !parseSemanticVersion(normalizeVersion(native.version))) throw new Error('Native daemon update target identity is invalid');
    daemonTargets = expected;
    const io = options.io ?? realUpdateFileIo;
    if (native.allowLegacyBinary && (!io.observe || !io.readFile || !io.observe(native.execPath))) throw new Error('Legacy daemon binary is not retained');
    // Preserve original ownership before the first await. Genuine native I/O
    // retains physical facts only; borrowed adapters still retain exact bytes.
    assertNativeCurrent = retainDaemonNativeFiles(expected, io);
    if (currentReaders) { assertSynchronousCurrent(readerGuard); assertNativeCurrent(); }
  }
  const admitInstalledNative = (): void => {
    if (!native) return;
    const io = options.io ?? realUpdateFileIo, expected = daemonTargets;
    assertNativeCurrent?.();
    if (currentReaders) assertSynchronousCurrent(readerGuard);
    let installed: DaemonInstallationReceipt | null = null;
    if (native.allowLegacyBinary) {
      if (!io.observe || !io.readFile || !io.observe(native.execPath)) throw new Error('Legacy daemon binary is not retained');
      if (io.exists(expected[expected.length - 1]!.path)) installed = inspectDaemonNativeInstallation(native.execPath, native.platform, native.arch, '', io);
    } else {
      installed = inspectDaemonNativeInstallation(native.execPath, native.platform, native.arch, '', io);
      if (!installed) throw new Error('No complete owned native daemon installation is available');
    }
    if (currentReaders) {
      if (!installed || installed.version !== currentReaders.version) throw new Error('Outgoing native reader does not own the installed version');
      if (installed.artifact.schema === 1) previousReader = { version: installed.version,
        artifact: { ...installed.artifact, schema: 2, readers: currentReaders } };
      assertSynchronousCurrent(readerGuard);
    }
    assertNativeCurrent?.();
  };
  for (const target of options.targets) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.assetName)) throw new Error(`invalid update asset filename: ${target.assetName}`);
  }
  const deadline = performance.now() + (options.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS);
  const verified = await withUpdateBudget(options, async (signal) => {
    const manifestUrl = `${options.downloadBaseUrl}/${CHECKSUM_MANIFEST_NAME}`;
    const manifestResponse = await options.fetchImpl(manifestUrl, { signal });
    signal.throwIfAborted();
    if (!manifestResponse.ok) throw new Error(`download failed (${manifestResponse.status}) for ${manifestUrl}`);
    const checksumText = await manifestResponse.text();
    const checksums = parseChecksumFile(checksumText);
    signal.throwIfAborted();
    const readerAsset = native ? daemonTargets[daemonTargets.length - 1]!.assetName.replace(/\.ci-artifact\.json$/, '.reader-ci-artifact.json') : undefined;
    const readerPin = readerAsset === undefined ? undefined : checksums.get(readerAsset);
    if (readerAsset !== undefined) {
      const entries = checksumText.split(/\r?\n/).filter(line => line.trim().split(/\s+/).some(token => token === readerAsset || token === '*' + readerAsset));
      if ((readerPin !== undefined || entries.length !== 0) && (readerPin === undefined || entries.length !== 1)) throw new Error('Native daemon reader artifact checksum is missing or ambiguous');
    }
    // A missing later member makes the whole cohort unverifiable. Require all
    // pins before downloading or hashing even its otherwise valid first member.
    const payloadTargets = generatedReceipt ? options.targets.slice(0, -1) : options.targets;
    const pinnedTargets = payloadTargets.map(target => ({
      target, expected: requireChecksum(target.assetName, checksums.get(target.assetName)),
    }));
    admitInstalledNative(); signal.throwIfAborted();
    const verified: StagedUpdate[] = [];
    for (const { target, expected } of pinnedTargets) {
      const url = `${options.downloadBaseUrl}/${target.assetName}`;
      const response = await options.fetchImpl(url, { signal });
      signal.throwIfAborted();
      if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
      const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
      signal.throwIfAborted();
      const pin = sha256(buffer);
      verifyChecksum(target.assetName, pin, expected);
      verifiedMembers.set(target.path, { path: target.path, assetName: target.assetName, sha256: pin, size: buffer.length, mode: target.executable ? 0o755 : 0o644 });
      verified.push({ target, buffer });
    }
    if (generatedReceipt) {
      const { artifact, version, target } = generatedReceipt;
      const payloads = verified.map(member => {
        const pin = verifiedMembers.get(member.target.path); if (!pin) throw new Error('Native daemon verified source member is missing');
        return { pin, bytes: member.buffer };
      });
      assertDaemonNativePayloadPins(artifact, payloads.map(member => member.pin), payloads[3]?.bytes);
      // This local transformation shares the same claims/compensation and exact
      // stage-byte checks as every native member. It was never downloaded and
      // has no independently expected checksum to compute or verify.
      verified.push({ target, buffer: Buffer.from(JSON.stringify({ schema: 1,
        packageName: '@goodvibes-jev/daemon', version, artifact }, null, 2) + '\n') });
    }
    if (native) {
      const descriptorIndex = verified.findIndex(member => member.target.path === daemonTargets[daemonTargets.length - 1]?.path);
      const descriptor = verified[descriptorIndex];
      if (!descriptor) throw new Error('Native daemon source manifest is missing');
      const target: DaemonNativeTarget = native.arch === 'x64' ? 'linux-x64' : 'linux-arm64';
      let artifact = parseDaemonCiArtifact(JSON.parse(descriptor.buffer.toString('utf8')), target);
      if (readerAsset !== undefined && readerPin !== undefined) {
        const response = await options.fetchImpl(`${options.downloadBaseUrl}/${readerAsset}`, { signal });
        signal.throwIfAborted();
        if (!response.ok) throw new Error('Native daemon reader artifact download failed');
        const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer())); signal.throwIfAborted();
        verifyChecksum(readerAsset, sha256(bytes), readerPin);
        const candidate = parseDaemonCiArtifact(JSON.parse(bytes.toString('utf8')), target);
        if (candidate.schema !== 2 || candidate.sourceCommit !== artifact.sourceCommit || candidate.sourceTree !== artifact.sourceTree
          || candidate.headCommit !== artifact.headCommit || candidate.target !== artifact.target
          || candidate.files.some((file, index) => {
            const original = artifact.files[index];
            return !original || file.path !== original.path || file.sha256 !== original.sha256 || file.mode !== original.mode || file.size !== original.size;
          }) || (artifact.schema === 2 && JSON.stringify(artifact.readers) !== JSON.stringify(candidate.readers))) throw new Error('Native daemon reader artifact does not match the verified payload cohort');
        artifact = candidate;
      }
      if (artifact.schema === 2 && artifact.readers.version !== normalizeVersion(native.version)) throw new Error('Native daemon reader version differs from the requested release');
      nativeReaders = artifact.readers;
      if (previousReader && !nativeReaders?.formats.includes(NATIVE_PREVIOUS_READER_RECEIPT_FORMAT)) throw new Error('Native daemon candidate cannot preserve previous-reader receipt evidence');
      const payloads = daemonTargets.slice(0, -1).map(target => {
        const pin = verifiedMembers.get(target.path), member = verified.find(member => member.target.path === target.path);
        if (!pin || !member) throw new Error('Native daemon verified source member is missing');
        return { pin, bytes: member.buffer };
      });
      assertDaemonNativePayloadPins(artifact, payloads.map(member => member.pin), payloads[3]?.bytes);
      // The installed receipt is a native transformation, not the downloaded
      // source artifact's bytes. Do not expose its former release pin as proof.
      verifiedMembers.delete(descriptor.target.path);
      verified[descriptorIndex] = { target: descriptor.target, buffer: Buffer.from(JSON.stringify({ schema: 1,
        packageName: '@goodvibes-jev/daemon', version: normalizeVersion(native.version), artifact,
        ...(previousReader === undefined ? {} : { previousReader }) }, null, 2) + '\n') };
    }
    signal.throwIfAborted();
    return verified;
  });
  const assertCurrent = () => {
    directory?.assertCurrent();
    options.signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('update timed out before commit');
    assertSynchronousCurrent(options.assertCurrent);
    directory?.assertCurrent();
  };
  assertCurrent();
  // The race above owns only read-only asynchronous preparation. A cancellation
  // during synchronous staging must never mask a transaction recovery receipt.
  installVerifiedBuffers(verified, options.io ?? realUpdateFileIo, options.platform ?? process.platform, () => {
    assertCurrent();
    assertNativeCurrent?.();
    assertSynchronousCurrent(readerGuard);
    const result = options.beforeCommit ? withVerifiedUpdateStage([...verifiedMembers.values()], nativeStage,
      () => { assertCurrent(); assertStagedCurrent?.(); }, stage => options.beforeCommit!(stage)) : undefined;
    if (result !== undefined) {
      drainOwned(result);
      throw new Error('beforeCommit must complete synchronously without returning a value');
    }
    assertCurrent();
    assertNativeCurrent?.();
    if (native) assertNativeReaderCompatible(native.execPath, native.version, options.io ?? realUpdateFileIo, nativeReaders);
  }, { current: assertCurrent, ...(options.retainPublication ? { retainPublication: options.retainPublication } : {}), ...(directory ? { directory } : {}), ...(readerExecPath ? { readerExecPath } : {}), ...(native || options.native ? { prepareNativeGuard: () => {
    const io = options.io ?? realUpdateFileIo;
    if (!io.readFile || !io.observe) throw new Error('Native daemon staged owner is unavailable');
    for (const member of verified) {
      const path = member.target.path + '.update-download', stat = io.observe(path);
      if (!stat || stat.mode !== (member.target.executable ? 0o755 : 0o644) || !io.readFile(path).equals(member.buffer)) throw new Error('Native daemon staging differs from its verified payload');
    }
    const guard = createDaemonNativeRenameGuard(options.targets, io);
    assertStagedCurrent = guard.assertCurrent.bind(guard);
    nativeStage = hasNativeUpdateObservations(io, io.readFile, io.observe);
    return guard;
  } } : {}) });
}

export interface RollbackTarget {
  readonly label: string;
  readonly path: string;
}

export interface RollbackResult {
  readonly restored: readonly RollbackTarget[];
  readonly skipped: readonly RollbackTarget[];
}

/** Exchange a kept cohort with reverse compensation; optional synchronous admission runs under all claims before any live rename. */
export function rollbackKeptPrevious(
  targets: readonly RollbackTarget[], io: UpdateFileIo = realUpdateFileIo,
  beforeCommit?: () => void,
  options: { readonly requireComplete?: boolean; readonly assertCurrent?: () => void; readonly native?: boolean; readonly readerExecPath?: string } = {},
): RollbackResult {
  targets = targets.map(target => ({ ...target }));
  io = captureUpdateFileIo(io);
  const paths = validateTargets(targets);
  const readerExecPath = options.readerExecPath ?? (options.native ? targets[0]?.path : undefined);
  if (readerExecPath && (!isAbsolute(readerExecPath) || resolve(readerExecPath) !== readerExecPath)) throw new Error('Native reader executable must be absolute and normalized');
  const directory = readerExecPath && hasNativeUpdateObservations(io, io.readFile, io.observe)
    ? retainNativeUpdateDirectory(dirname(readerExecPath), targets.map(target => dirname(target.path))) : undefined;
  const restored: RollbackTarget[] = [];
  const skipped: RollbackTarget[] = [];
  transact('rollback', paths, io, () => {}, () => {
    if (options.requireComplete && paths.some(path => !io.exists(path.previous))) throw new Error('Previous native cohort is incomplete; refusing partial rollback');
    let result: unknown;
    try { result = beforeCommit?.(); } catch (error) { drainOwned(error); throw error; }
    if (result !== undefined) {
      drainOwned(result);
      throw new Error('beforeCommit must complete synchronously without returning a value');
    }
  }, (rename) => {
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index]!;
      const target = targets[index]!;
      if (!io.exists(path.previous)) { skipped.push(target); continue; }
      if (io.exists(path.target)) {
        rename(path.target, path.exchange);
        rename(path.previous, path.target);
        rename(path.exchange, path.previous);
      } else {
        rename(path.previous, path.target);
      }
      restored.push(target);
    }
  }, { ...(options.assertCurrent ? { current: options.assertCurrent } : {}), ...(directory ? { directory } : {}), ...(readerExecPath ? { readerExecPath } : {}), ...(options.native ? {
    prepareNativeGuard: () => createDaemonNativeRenameGuard(targets.map(target => ({ ...target, executable: false, assetName: '' })), io),
  } : {}) });
  return { restored, skipped };
}
