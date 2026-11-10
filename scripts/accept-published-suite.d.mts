import type { SpawnOptionsWithoutStdio } from 'node:child_process';
export interface HostedContext {
  env: NodeJS.ProcessEnv; platform: string; arch: string; home: string; accountHome: string;
  uid: number; tag: string; source: string; target: string;
}
export interface AcceptanceSteps {
  admit(): Promise<void>; install(): Promise<void>; verifyInstalled(): Promise<void>; verifyDefaults(): Promise<void>;
  disableUpdates(): Promise<void>; restartAndVerifyOptOut(): Promise<void>; verifyOptOut(): Promise<void>;
  uninstall(): Promise<void>; verifyPreserved(): Promise<void>;
}
export interface HistoricalUpgradeSteps {
  admit(): Promise<void>; installPrevious(): Promise<void>; verifyPrevious(): Promise<void>;
  seedPreviousData(): Promise<void>; startPreviousService(): Promise<void>; awaitAutomaticUpgrade(): Promise<void>;
  verifyUpgradedData(): Promise<void>; verifyRollbackRefusal(): Promise<void>;
  uninstall(): Promise<void>; verifyPreserved(): Promise<void>;
}
export function runHistoricalUpgradeSteps(host: HistoricalUpgradeSteps): Promise<void>;
export function assertHistoricalRollbackRefusal(input: { bin: string; version: string; webuiDirectory: string; signal?: AbortSignal },
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
export function runOwnedCommand(command: string, args: readonly string[], options?: SpawnOptionsWithoutStdio & {
  signal?: AbortSignal; timeoutMs?: number;
}): Promise<{ code: number; stdout: string }>;
export function acceptPublishedSuite(input: { tag: string; source: string; target: string; scenario?: 'fresh' | 'upgrade-v3.1.1'; signal?: AbortSignal }): Promise<void>;
export function readPublishedReaders(input: { tag: string; source: string; target: string; assets: ReadonlySet<string> },
  load: (name: string) => Promise<{ target: string; sourceCommit: string; headCommit: string; version?: string;
    readers: { version: string }; files: readonly { path: string }[] }>): Promise<Map<string, unknown>>;
