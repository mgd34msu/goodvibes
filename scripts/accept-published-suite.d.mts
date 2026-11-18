import type { SpawnOptionsWithoutStdio } from 'node:child_process';
export type AcceptanceFetch = (url: string, options: RequestInit) => Promise<Response>;
/** The release repository named by scripts/install.sh. */
export const repository: string;
export function consumeAcceptanceMetadataFetch(env?: NodeJS.ProcessEnv, fetchImpl?: AcceptanceFetch): {
  authentication: 'read-only-ci-token' | 'anonymous'; fetch: AcceptanceFetch;
};
export interface AccountContext {
  env: NodeJS.ProcessEnv; platform: string; arch: string; home: string; accountHome: string;
  uid: number; tag: string; source: string; target: string;
  /** The caller declares this account disposable (--disposable-account); not needed on a GitHub-hosted runner. */
  disposableAccount?: boolean;
}
export interface AcceptanceSteps {
  admit(): Promise<void>; install(): Promise<void>; verifyInstalled(): Promise<void>; verifyDefaults(): Promise<void>;
  disableUpdates(): Promise<void>; restartAndVerifyOptOut(): Promise<void>; verifyOptOut(): Promise<void>;
  uninstall(): Promise<void>; verifyPreserved(): Promise<void>;
}
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
export function assertDisposableAccount(input: AccountContext): void;
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
  /** Service definition file names present when the service was last checked. */
  serviceDefinitions?: readonly ServiceDefinitionName[];
  /** What the current installer said about the daemon's service on its last run. */
  serviceSetup?: InstallerServiceSetup;
}
/** The daemon's own definition file (named in daemon-service-default.ts), or any other definition that starts the installed daemon. */
export type ServiceDefinitionName = `${string}.service` | `${string}.plist` | 'other-definition';
export type InstallerServiceSetup = 'installed' | 'installed-not-running' | 'not-reported' | 'no-manager' | 'existing-definition'
  | 'skipped' | 'not-attempted' | `install-service-exit-${number}`;
export function installerServiceSetup(stdout: string): InstallerServiceSetup;
export function acceptanceFailureRecord(evidence: {
  stage: string; check?: string; command?: string; exitCode?: number; exitSignal?: NodeJS.Signals; diagnostics?: readonly string[];
  httpStatus?: number;
  observedRelease?: 'previous' | 'target' | 'other';
  nativeDaemonFailure?: NativeDaemonFailure; nativeStartupFailure?: NativeStartupFailure;
  serviceDefinitions?: readonly string[]; serviceSetup?: string;
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
  installerSource?: string; installerSourcePath?: string;
  admit(input: { tag: string; source: string; target: string; root: string; signal?: AbortSignal }): Promise<{
    readers: Map<string, unknown>; installer: string; published: { url: string; bytes: Uint8Array };
  }>;
  preparePrevious(input: {
    invoke(command: string, args: readonly string[]): Promise<string>;
    daemon: string; setting(key: string): Promise<unknown>;
  }): Promise<void>;
  assertCurrent(): void;
  finish?(): Promise<void>;
}
export function acceptPublishedSuite(input: { tag: string; source: string; target: string;
  scenario?: 'fresh' | 'upgrade-previous';
  previousTag?: string; previousSource?: string; signal?: AbortSignal; delivery?: AcceptanceDelivery;
  /** `recheck` re-verifies an already published release; see readPublicAcceptanceDelivery. */
  mode?: 'release' | 'recheck';
  /** Run outside a GitHub-hosted runner, in an account that may be thrown away. */
  disposableAccount?: boolean }): Promise<void>;
export function readPublishedReaders(input: { tag: string; source: string; target: string; assets: ReadonlySet<string>; onCheck?(check: string): void },
  load: (name: string) => Promise<PublishedReader>): Promise<Map<string, unknown>>;
export function readPublicAcceptanceDelivery(input: {
  tag: string; source: string; target: string; signal?: AbortSignal;
  checkpoint(check: string): void; onHttpStatus(status: number): void; mode?: 'release' | 'recheck';
}, fetchImpl?: (url: string, options: RequestInit) => Promise<Response>): Promise<{ readers: Map<string, unknown>;
  published: { bytes: Buffer; url: string }; immutable: { bytes: Buffer; url: string }; mode: 'release' | 'recheck' }>;
export function readPreviousReleaseCohort(input: {
  tag: string; source: string; target: string; signal?: AbortSignal;
  checkpoint(check: string): void; onHttpStatus(status: number): void;
}, fetchImpl?: (url: string, options: RequestInit) => Promise<Response>): Promise<{ readers: Map<string, unknown>; installer: Buffer }>;
