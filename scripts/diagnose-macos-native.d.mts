export interface NativeDiagnosticFrame {
  function: string;
  source: 'compiled' | 'other';
  /** Zero-based generated bundle coordinates, not original TypeScript lines. */
  line: number;
  column: number;
  module?: string;
  moduleOffset?: number;
  staticThrow?: string;
}
export interface NativeDiagnosticRecord {
  phase: 'inspector';
  event: 'started' | 'attached' | 'exception' | 'window-ended' | 'protocol-failed' | 'finished' | 'service-stopped' | 'payload-retained'
    | 'exit-intent' | 'startup-phase' | 'startup-repair';
  attempt?: 'version' | 'default';
  pause?: number;
  /** Actual owned child PID, for process/crash correlation and bounded cleanup. */
  pid?: number;
  frames?: NativeDiagnosticFrame[];
  exitCode?: number | null;
  signal?: string | null;
  startupPhase?: string;
  termination?: 'observed-exit' | 'observation-window' | 'cancelled' | 'inspector-failure';
}
export function compiledDiagnosticFrame(frame: unknown, script: unknown, source: unknown): NativeDiagnosticFrame;
/** Diagnostic tooling only; acceptance uses diagnoseMacosNative owner admission. */
export function inspectCompiledNativeDiagnosticAttempt(daemon: string, home: string, env: NodeJS.ProcessEnv,
  attempt: 'version' | 'default', onSafeEvidence: (record: NativeDiagnosticRecord) => void, signal?: AbortSignal): Promise<void>;
export function diagnoseMacosNative(options: {
  daemon: string;
  home: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stopService(signal?: AbortSignal): Promise<void>;
  onSafeEvidence(record: NativeDiagnosticRecord): void;
}): Promise<void>;
