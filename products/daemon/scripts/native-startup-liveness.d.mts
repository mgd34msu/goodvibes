export interface NativeStartupPhaseObservation {
  /** A phase token as the daemon printed it; the daemon's list is NATIVE_STARTUP_PHASES. */
  readonly phase: string;
  readonly delayMs: number;
  readonly requestCount: number;
}
export interface NativeStartupProgressSnapshot {
  readonly elapsedMs: number;
  readonly failed: boolean;
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
