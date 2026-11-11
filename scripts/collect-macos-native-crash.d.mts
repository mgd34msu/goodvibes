export interface MacosCrashSummary {
  exception: { type?: string; signal?: string };
  termination: { namespace?: string; code?: number; indicator?: string };
  frames: Array<{ image: string; symbol?: string }>;
}
export interface MacosCrashWindow { startedAtMs: number; nowMs?: number; daemonPath?: string }
export function summarizeMacosCrash(raw: string, window: MacosCrashWindow): MacosCrashSummary;
export function collectMacosCrashes(input: MacosCrashWindow & { directory: string; uid?: number }): {
  schema: 1;
  status: 'unavailable' | 'reports-found' | 'no-matching-reports';
  reports: MacosCrashSummary[];
};
