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
export function assertHostedContext(input: HostedContext): void;
export function runAcceptanceSteps(host: AcceptanceSteps): Promise<void>;
export function runOwnedCommand(command: string, args: readonly string[], options?: SpawnOptionsWithoutStdio & {
  signal?: AbortSignal; timeoutMs?: number;
}): Promise<{ code: number; stdout: string }>;
export function acceptPublishedSuite(input: { tag: string; source: string; target: string; signal?: AbortSignal }): Promise<void>;
export function readPublishedReaders(input: { tag: string; source: string; target: string; assets: ReadonlySet<string> },
  load: (name: string) => Promise<{ target: string; sourceCommit: string; headCommit: string; version?: string;
    readers: { version: string }; files: readonly { path: string }[] }>): Promise<Map<string, unknown>>;
