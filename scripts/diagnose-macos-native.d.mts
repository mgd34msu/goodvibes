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
    | 'exit-intent' | 'startup-phase' | 'startup-repair' | 'script-observed' | 'source-index'
    | 'retained-file-recheck' | 'retained-path-recheck' | 'owner-retired' | 'service-stop-requested'
    | 'service-stop-checkpoint' | 'service-stop-result' | 'service-stop-failed';
  attempt?: 'version' | 'default';
  pause?: number;
  /** Actual owned child PID, for process/crash correlation and bounded cleanup. */
  pid?: number;
  frames?: NativeDiagnosticFrame[];
  exitCode?: number | null;
  signal?: string | null;
  startupPhase?: string;
  termination?: 'observed-exit' | 'observation-window' | 'cancelled' | 'inspector-failure';
  checkpoint?: 'before-version' | 'after-version' | 'after-service-stop' | 'after-default'
    | 'ownership' | 'bootout' | 'home-after-bootout' | 'print' | 'retirement' | 'retired';
  changed?: Array<'home-type' | 'payload-type' | 'selected-path' | `home-${'dev' | 'ino' | 'uid'}`
    | `${'retained' | 'selected'}-${'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs' | 'mode' | 'uid' | 'gid'}`>;
  scriptKind?: 'compiled-path' | 'compiled-file-url' | 'unrecognized-virtual' | 'unrecognized-file-virtual' | 'builtin' | 'other';
  sourceLength?: number;
  indexed?: boolean;
  errorName?: 'Error' | 'AssertionError' | 'TypeError' | 'SyntaxError' | 'RangeError' | 'AggregateError' | 'AbortError' | 'TimeoutError';
  errorCode?: 'ERR_ASSERTION' | 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EACCES' | 'EPERM' | 'EBADF' | 'EIO' | 'EINVAL'
    | 'ECONNREFUSED' | 'ECONNRESET' | 'ETIMEDOUT' | 'ABORT_ERR' | 'ERR_ACCEPTANCE_READINESS_TIMEOUT' | 'unknown';
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
