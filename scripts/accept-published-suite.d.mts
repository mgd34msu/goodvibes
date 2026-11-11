import type { SpawnOptionsWithoutStdio } from 'node:child_process';
export interface HostedContext {
  env: NodeJS.ProcessEnv; platform: string; arch: string; home: string; accountHome: string;
  uid: number; tag: string; source: string; target: string;
}
export interface AcceptanceSteps {
  admit(): Promise<void>; install(): Promise<void>; verifyInstalled(): Promise<void>; verifyDefaults(): Promise<void>;
  disableUpdates(): Promise<void>; restartAndVerifyOptOut(): Promise<void>; verifyOptOut(): Promise<void>;
  uninstall(): Promise<void>; verifyPreserved(): Promise<void>;
  diagnoseFailure?(): Promise<void>;
}
export interface HistoricalUpgradeSteps {
  admit(): Promise<void>; installPrevious(): Promise<void>; verifyPrevious(): Promise<void>;
  seedPreviousData(): Promise<void>; startPreviousService(): Promise<void>; awaitAutomaticUpgrade(): Promise<void>;
  verifyUpgradedData(): Promise<void>; verifyRollbackRefusal(): Promise<void>;
  uninstall(): Promise<void>; verifyPreserved(): Promise<void>;
}
export function runHistoricalUpgradeSteps(host: HistoricalUpgradeSteps): Promise<void>;
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
export interface AcceptanceFailureRecord {
  stage: string; check?: string; command?: string; exitCode?: number; exitSignal?: NodeJS.Signals; diagnostics?: readonly string[];
  nativeDaemonFailure?: NativeDaemonFailure;
  error: { name: string; code?: string }; lastProbeError?: { name: string; code?: string };
}
export function acceptanceFailureRecord(evidence: {
  stage: string; check?: string; command?: string; exitCode?: number; exitSignal?: NodeJS.Signals; diagnostics?: readonly string[]; nativeDaemonFailure?: NativeDaemonFailure;
}, error: unknown): AcceptanceFailureRecord;
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
}): Promise<{ code: number; stdout: string; exitSignal?: NodeJS.Signals; diagnostics?: string[]; nativeDaemonFailure?: NativeDaemonFailure }>;
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
}
export function acceptPublishedSuite(input: { tag: string; source: string; target: string; scenario?: 'fresh' | 'upgrade-v3.1.1'; signal?: AbortSignal; delivery?: AcceptanceDelivery }): Promise<void>;
export function readPublishedReaders(input: { tag: string; source: string; target: string; assets: ReadonlySet<string> },
  load: (name: string) => Promise<{ target: string; sourceCommit: string; headCommit: string; version?: string;
    readers: { version: string }; files: readonly { path: string }[] }>): Promise<Map<string, unknown>>;
