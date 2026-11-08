import type { ChildProcess } from 'node:child_process';

export function signalNativeProcessGroup(child: ChildProcess, signal?: NodeJS.Signals): void;
export function assertNativeProcessGroupDrained(child: ChildProcess): void;
export function boundedNativeProcessClose<T>(stopped: Promise<T>, milliseconds: number, message: string): Promise<T>;
export function drainNativeProcessGroup(child: ChildProcess, stopped: Promise<unknown>): Promise<void>;
