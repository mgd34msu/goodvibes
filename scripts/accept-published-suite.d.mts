import type { SpawnOptionsWithoutStdio } from 'node:child_process';
export type AcceptanceFetch = (url: string, options: RequestInit) => Promise<Response>;
export function consumeAcceptanceMetadataFetch(env?: NodeJS.ProcessEnv, fetchImpl?: AcceptanceFetch): {
  authentication: 'read-only-ci-token' | 'anonymous'; fetch: AcceptanceFetch;
};
export interface HostedContext {
  env: NodeJS.ProcessEnv; platform: string; arch: string; home: string; accountHome: string;
  uid: number; tag: string; source: string; target: string;
}
export interface AcceptanceSteps {
  admit(): Promise<void>; install(): Promise<void>; verifyInstalled(): Promise<void>; verifyDefaults(): Promise<void>;
  disableUpdates(): Promise<void>; restartAndVerifyOptOut(): Promise<void>; verifyOptOut(): Promise<void>;
  uninstall(): Promise<void>; verifyPreserved(): Promise<void>;
  diagnoseFailure?(): Promise<void>;
  verifyNativeLifecycle?(): Promise<void>;
}
export interface HistoricalUpgradeSteps {
  admit(): Promise<void>; installPrevious(): Promise<void>; verifyPrevious(): Promise<void>;
  seedPreviousData(): Promise<void>; startPreviousService(): Promise<void>; awaitAutomaticUpgrade(): Promise<void>;
  verifyUpgradedData(): Promise<void>; verifyRollbackRefusal(): Promise<void>;
  uninstall(): Promise<void>; verifyPreserved(): Promise<void>;
}
export function runHistoricalUpgradeSteps(host: HistoricalUpgradeSteps): Promise<void>;
export interface PreviousReleaseUpgradeSteps {
  admit(): Promise<void>; installPrevious(): Promise<void>; verifyPrevious(): Promise<void>;
  seedPreviousData(): Promise<void>; startPreviousService(): Promise<void>; verifyPreviousService(): Promise<void>;
  prepareDelivery(): Promise<void>; awaitAutomaticUpgrade(): Promise<void>; verifyUpgradedData(): Promise<void>;
  verifyCompleteRollback(): Promise<void>; uninstall(): Promise<void>; verifyPreserved(): Promise<void>;
}
export function runPreviousReleaseUpgradeSteps(host: PreviousReleaseUpgradeSteps): Promise<void>;
export function assertPreviousReleaseInputs(input: { tag: string; previousTag?: string; previousSource?: string }): void;
export interface PublishedReader {
  target: string; sourceCommit: string; headCommit: string; version?: string;
  readers: { version: string }; files: readonly { path: string }[];
}
export interface NativeLifecycleHost {
  daemon: string; bin: string; data: string; root: string; signal?: AbortSignal;
  setting(key: string): Promise<unknown>; invoke(command: string, args: readonly string[]): Promise<string>;
  checkpoint(check: string): void; verifyCohort(version: string, readers: Map<string, unknown>): Promise<void>;
  restartService(): Promise<void>; servicePid(): Promise<number>; stopService(): Promise<void>; startService(): Promise<void>;
}
export function verifyCompiledSuiteRollback(input: {
  host: NativeLifecycleHost; target: string; source: string; sourceRoot: string; previousVersion: string; currentVersion: string;
  previousReaders: Map<string, unknown>; webuiDirectory: string; verifyPreserved(): Promise<void>;
}): Promise<{ updatedPid: number; rolledBackPid: number }>;
export interface InstallerMigrationSteps {
  admit(): Promise<void>; installPrevious(): Promise<void>; verifyPrevious(): Promise<void>; seedPreviousData(): Promise<void>;
  disablePreviousUpdates(): Promise<void>; startPreviousService(): Promise<void>; verifyPreviousService(): Promise<void>;
  installCurrent(): Promise<void>; verifyCurrent(): Promise<void>; verifyMigratedData(): Promise<void>; restartAndVerifyMigrated(): Promise<void>;
  uninstall(): Promise<void>; verifyPreserved(): Promise<void>;
}
export function runInstallerMigrationSteps(host: InstallerMigrationSteps): Promise<void>;
export function assertHistoricalRollbackRefusal(input: { bin: string; version: string; webuiDirectory: string; signal?: AbortSignal; sourceRoot?: string },
  verifier?: {
    resolveSuiteUpdatePlan(input: object): { files: readonly { path: string }[]; directories: readonly { path: string }[]; assertCurrent(): void };
    rollbackSuiteUpdate(input: { beforeCommit(): void; assertCurrent(): void }): unknown;
    captureUpdateFileIo(input: object): object; realUpdateFileIo: object;
    retainNativeUpdateSources(paths: readonly string[], io: object): () => void;
    retainNativeUpdateTree(path: string): { assertCurrent(): void };
    UpdateTransactionError: new(...args: never[]) => Error;
  }): Promise<void>;
export function assertHostedContext(input: HostedContext): void;
export function runAcceptanceSteps(host: AcceptanceSteps): Promise<void>;
export type NativeDaemonFailure = 'token-missing' | 'invalid-port' | 'unreachable' | 'auth-refused' | 'route-missing'
  | 'unreadable-reply' | 'cli-command-caught' | 'native-startup-repair' | 'unknown';
export interface NativeStartupFailure {
  stage: 'sqlite' | 'darwin-original';
  code: 'SQLITE_ARCH_UNSUPPORTED' | 'SQLITE_ARCH_MISMATCH' | 'SQLITE_PARENT_TYPE' | 'SQLITE_FILE_MODE' | 'SQLITE_SIZE_BOUND'
    | 'SQLITE_READ_CHANGED' | 'SQLITE_LIFETIME_ASYNC' | 'SQLITE_RUNTIME_UNDECLARED' | 'SQLITE_COMPILED_OWNER' | 'SQLITE_BYTES_MISMATCH'
    | 'SQLITE_PROVENANCE_MISMATCH' | 'SQLITE_ADMISSION_CHANGED' | 'SQLITE_LOADER_REFUSED' | 'SQLITE_SOURCE_CHANGED'
    | 'DARWIN_SQLITE_OWNER' | 'DARWIN_TARGET' | 'DARWIN_IO_OBSERVATIONS' | 'DARWIN_SOURCE_CHANGED'
    | 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EACCES' | 'EPERM' | 'EBADF' | 'EIO' | 'ELOOP' | 'ERR_DLOPEN_FAILED' | 'METADATA_JSON' | 'UNKNOWN';
}
export interface AcceptanceFailureRecord {
  stage: string; check?: string; command?: string; exitCode?: number; exitSignal?: NodeJS.Signals; diagnostics?: readonly string[];
  httpStatus?: number;
  observedRelease?: 'previous' | 'target' | 'other';
  nativeDaemonFailure?: NativeDaemonFailure;
  nativeStartupFailure?: NativeStartupFailure;
  error: { name: string; code?: string }; lastProbeError?: { name: string; code?: string };
}
export function acceptanceFailureRecord(evidence: {
  stage: string; check?: string; command?: string; exitCode?: number; exitSignal?: NodeJS.Signals; diagnostics?: readonly string[];
  httpStatus?: number;
  observedRelease?: 'previous' | 'target' | 'other';
  nativeDaemonFailure?: NativeDaemonFailure; nativeStartupFailure?: NativeStartupFailure;
}, error: unknown): AcceptanceFailureRecord;
export function markAcceptanceCheckpoint(evidence: Parameters<typeof acceptanceFailureRecord>[0], check?: string): void;
export function waitForAcceptanceReadiness(serviceReady: () => Promise<void>, verifyReady: () => Promise<void>,
  options?: { signal?: AbortSignal; timeoutMs?: number; intervalMs?: number }): Promise<void>;
export interface NativeServiceRetirementObservation {
  exitCode: number; signal: NodeJS.Signals | null; state: 'running' | 'notrunning' | 'spawn-scheduled' | 'other';
  pid?: number; runs?: number; lastExitCode?: number;
}
export function waitForNativeServiceRetirement(probe: () => Promise<{ code: number; stdout: string; exitSignal?: NodeJS.Signals }>,
  options?: { signal?: AbortSignal; intervalMs?: number; onObservation?: (record: NativeServiceRetirementObservation) => void }): Promise<void>;
export function finishAcceptance(options: {
  signal?: AbortSignal; finish?: () => Promise<void>; assertCurrent?: () => void; writeReceipt(): void;
}): Promise<void>;
export function runOwnedCommand(command: string, args: readonly string[], options?: SpawnOptionsWithoutStdio & {
  signal?: AbortSignal; timeoutMs?: number; installerSource?: string; installerSourcePath?: string; nativeDaemonDiagnostics?: boolean;
}): Promise<{ code: number; stdout: string; exitSignal?: NodeJS.Signals; diagnostics?: string[]; nativeDaemonFailure?: NativeDaemonFailure; nativeStartupFailure?: NativeStartupFailure }>;
export interface AcceptanceDelivery {
  installerSource?: string; installerSourcePath?: string; rollbackSourceRoot?: string;
  admit(input: { tag: string; source: string; target: string; root: string; signal?: AbortSignal }): Promise<{
    readers: Map<string, unknown>; installer: string; published: { url: string; bytes: Uint8Array };
  }>;
  preparePrevious(input: {
    invoke(command: string, args: readonly string[]): Promise<string>;
    daemon: string; setting(key: string): Promise<unknown>;
  }): Promise<void>;
  assertCurrent(): void;
  finish?(): Promise<void>;
  /** Explicit unpublished Mac fixtures only; ordinary admission is unchanged. */
  verifyNativeLifecycle?(input: NativeLifecycleHost): Promise<void>;
}
export function acceptPublishedSuite(input: { tag: string; source: string; target: string;
  scenario?: 'fresh' | 'upgrade-v3.1.1' | 'installer-migrate-v3.1.1' | 'upgrade-previous';
  previousTag?: string; previousSource?: string; signal?: AbortSignal; delivery?: AcceptanceDelivery }): Promise<void>;
export function readPublishedReaders(input: { tag: string; source: string; target: string; assets: ReadonlySet<string>; onCheck?(check: string): void },
  load: (name: string) => Promise<PublishedReader>): Promise<Map<string, unknown>>;
export function readPublicAcceptanceDelivery(input: {
  tag: string; source: string; target: string; signal?: AbortSignal;
  checkpoint(check: string): void; onHttpStatus(status: number): void;
}, fetchImpl?: (url: string, options: RequestInit) => Promise<Response>): Promise<{ readers: Map<string, unknown>;
  published: { bytes: Buffer; url: string }; immutable: { bytes: Buffer; url: string } }>;
export function readPreviousReleaseCohort(input: {
  tag: string; source: string; target: string; signal?: AbortSignal;
  checkpoint(check: string): void; onHttpStatus(status: number): void;
}, fetchImpl?: (url: string, options: RequestInit) => Promise<Response>): Promise<{ readers: Map<string, unknown>; installer: Buffer }>;
