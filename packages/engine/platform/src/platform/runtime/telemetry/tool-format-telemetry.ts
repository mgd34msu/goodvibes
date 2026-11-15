// Per-model tool-format telemetry.
//
// STANDING RULE (measurement, not behavior): this records how often each model
// trips the edit tool's failure modes (no-match, multi-match, external-conflict,
// generic failure, and the whitespace/fuzzy lenient fallbacks) and misses a
// declared exec expectation (exit_code / stdout_contains / stderr_contains), so
// tool-format regressions surface as data. It NEVER changes tool behavior and is
// explicitly NOT a per-model edit-format matrix, nothing here is read back to
// pick an edit strategy. Counters are keyed by model id + failure class and read
// through the runtime metrics snapshot (see metrics.ts's `snapshotMetrics`),
// reachable via the `runtime.metrics.get` operator method, its REST binding
// GET /api/runtime/metrics, or directly by platform consumers importing
// `snapshotMetrics`/`RuntimeMetricsSnapshot` from
// `@goodvibes-jev/engine/platform/platform/runtime/observability`.
import { classifyEditFallbackWarning } from '../../tools/edit/match.js';

/** The failure classes tracked, keyed per model. */
export type ToolFormatFailureClass =
  | 'edit_not_found'
  | 'edit_ambiguous'
  | 'edit_conflict'
  | 'edit_failed'
  | 'edit_fallback_whitespace'
  | 'edit_fallback_fuzzy'
  | 'exec_expectation_exit_code'
  | 'exec_expectation_stdout_contains'
  | 'exec_expectation_stderr_contains';

/** A tool result, in the shape both tool-execution loops already hold. */
export interface ToolFormatResultLike {
  readonly callId?: string | undefined;
  readonly success: boolean;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  readonly warnings?: readonly string[] | undefined;
  /** A failed edit's status, as the edit tool's matcher decided it. */
  readonly hostEvidence?: { readonly editStatus?: string | undefined; readonly reads?: unknown } | undefined;
}

/** A tool call, in the shape both tool-execution loops already hold. */
export interface ToolFormatCallLike {
  readonly id: string;
  readonly name: string;
}

const EDIT_STATUS_TO_CLASS: Record<string, ToolFormatFailureClass> = {
  not_found: 'edit_not_found',
  ambiguous: 'edit_ambiguous',
  conflict: 'edit_conflict',
  failed: 'edit_failed',
};

/** Read the exec `expectation_error` string out of a result (JSON output or error field). */
function readExpectationError(result: ToolFormatResultLike): string | null {
  if (typeof result.output === 'string' && result.output.includes('expectation_error')) {
    try {
      const parsed = JSON.parse(result.output) as { expectation_error?: unknown };
      if (typeof parsed.expectation_error === 'string') return parsed.expectation_error;
    } catch {
      // Not JSON, fall through to the error field.
    }
  }
  if (typeof result.error === 'string' && result.error.includes('expectation')) return result.error;
  return null;
}

/**
 * Classify a single tool outcome into zero or more failure classes. An edit
 * failure maps from the status the edit tool's matcher returned (carried on the
 * result's host evidence, never read back out of its message); a successful edit
 * that used a lenient fallback is classified from its warning. Exec is recorded
 * ONLY for declared-expectation misses (an ordinary non-zero exit is not a
 * format regression), one class per violated expectation.
 */
export function classifyToolFormatOutcome(
  toolName: string,
  result: ToolFormatResultLike,
): ToolFormatFailureClass[] {
  if (toolName === 'edit') {
    if (!result.success) {
      return [EDIT_STATUS_TO_CLASS[result.hostEvidence?.editStatus ?? 'failed'] ?? 'edit_failed'];
    }
    const classes: ToolFormatFailureClass[] = [];
    for (const warning of result.warnings ?? []) {
      const fallback = classifyEditFallbackWarning(warning);
      if (fallback === 'whitespace') classes.push('edit_fallback_whitespace');
      else if (fallback === 'fuzzy-lines') classes.push('edit_fallback_fuzzy');
    }
    return classes;
  }
  if (toolName === 'exec') {
    const expectationError = readExpectationError(result);
    if (!expectationError) return [];
    const classes: ToolFormatFailureClass[] = [];
    if (expectationError.includes('exit_code')) classes.push('exec_expectation_exit_code');
    if (expectationError.includes('stdout_contains')) classes.push('exec_expectation_stdout_contains');
    if (expectationError.includes('stderr_contains')) classes.push('exec_expectation_stderr_contains');
    return classes;
  }
  return [];
}

const KEY_SEP = '\u0000';

/**
 * Process-wide recorder of per-model tool-format failure counts. A singleton,
 * mirroring `platformMeter`: fed at the tool-execution call sites (which know
 * the active model) and read by `snapshotMetrics()`.
 */
export class ToolFormatTelemetry {
  private readonly counts = new Map<string, number>();

  /** Record one occurrence of a failure class for a model. */
  record(model: string, failureClass: ToolFormatFailureClass): void {
    const key = `${model || 'unknown'}${KEY_SEP}${failureClass}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /**
   * Classify and record a batch of tool results for the given model. Results are
   * matched to calls by callId (falling back to positional order when a result
   * carries no callId). Only edit/exec outcomes produce counts.
   */
  observeToolResults(
    model: string,
    calls: readonly ToolFormatCallLike[],
    results: readonly ToolFormatResultLike[],
  ): void {
    const nameByCallId = new Map(calls.map((c) => [c.id, c.name] as const));
    results.forEach((result, index) => {
      const toolName = (result.callId ? nameByCallId.get(result.callId) : undefined)
        ?? calls[index]?.name;
      if (!toolName) return;
      for (const cls of classifyToolFormatOutcome(toolName, result)) {
        this.record(model, cls);
      }
    });
  }

  /**
   * A stable, JSON-serialisable snapshot: `{ [modelId]: { [failureClass]: count } }`
   * plus a flat `total` per class. Empty when nothing has been recorded.
   */
  snapshot(): {
    readonly byModel: Record<string, Record<string, number>>;
    readonly byClass: Record<string, number>;
  } {
    const byModel: Record<string, Record<string, number>> = {};
    const byClass: Record<string, number> = {};
    for (const [key, count] of this.counts) {
      const sep = key.indexOf(KEY_SEP);
      const model = key.slice(0, sep);
      const failureClass = key.slice(sep + 1);
      (byModel[model] ??= {})[failureClass] = count;
      byClass[failureClass] = (byClass[failureClass] ?? 0) + count;
    }
    return { byModel, byClass };
  }

  /** Clear all counts (test isolation). */
  reset(): void {
    this.counts.clear();
  }
}

/** Singleton recorder for the platform (mirrors `platformMeter`). */
export const toolFormatTelemetry = new ToolFormatTelemetry();
