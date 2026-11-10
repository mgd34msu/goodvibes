import type { NativeStartupPhase } from '../src/runtime/startup-observation.js';

export const nativeStartupPhases: readonly NativeStartupPhase[];
export interface NativeStartupPhaseObservation {
  readonly phase: NativeStartupPhase;
  readonly delayMs: number;
  readonly requestCount: number;
}
export interface NativeStartupProgressSnapshot {
  readonly elapsedMs: number;
  readonly noProgressMs: number;
  readonly failed: boolean;
  readonly stalled: boolean;
  readonly phases: readonly NativeStartupPhaseObservation[];
}
export interface NativeStartupProgress {
  append(chunk: unknown, requestCount: number): void;
  snapshot(): NativeStartupProgressSnapshot;
}
export function retainNativeStartupProgress(now?: () => number): NativeStartupProgress;
export function assertNativeStartupActive(progress: NativeStartupProgressSnapshot, state: {
  readonly processClosed: boolean;
  readonly requestCount: number;
}): void;
export function hasNativeStartupReadyBanner(output: string, version: string): boolean;
export function assertNativeStartupBanners(input: {
  readonly pid: number | undefined;
  readonly output: string;
  readonly version: string;
  readonly port: number;
}): void;
