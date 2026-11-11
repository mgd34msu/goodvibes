import type { ChildProcess } from 'node:child_process';

export function signalNativeProcessGroup(child: ChildProcess, signal?: NodeJS.Signals): void;
export function assertNativeProcessGroupDrained(child: ChildProcess): void;
export function boundedNativeProcessClose<T>(stopped: Promise<T>, milliseconds: number, message: string): Promise<T>;
export function drainNativeProcessGroup(child: ChildProcess, stopped: Promise<unknown>): Promise<void>;
export interface NativeBuildCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  readonly onStdout?: (chunk: string) => unknown;
  readonly onStderr?: (chunk: string) => unknown;
}
export function runNativeBuildCommand(command: string, args: readonly string[], options?: NativeBuildCommandOptions): Promise<{ exitCode: number; output: string }>;
export function runNativeArchive(members: readonly string[], cwd: string, fd: number, signal?: AbortSignal): Promise<void>;
