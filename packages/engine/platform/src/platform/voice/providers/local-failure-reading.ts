/**
 * What one failed engine run says about the engine:
 * - `model-load-incompatible` and `fatal-crash` stop the engine at once;
 * - `failed` counts toward the consecutive-failure limit;
 * - `cancelled` (a deadline or the caller's abort) counts for nothing.
 */
export type LocalEngineFailureKind = 'model-load-incompatible' | 'fatal-crash' | 'failed' | 'cancelled';

export interface LocalEngineFailure {
  readonly kind: LocalEngineFailureKind;
  readonly signal: string;
  readonly code: number | string | undefined;
}

/** onnxruntime's wording when piper (or another onnx engine) cannot load the pinned model. */
const MODEL_LOAD_MARKERS = /Unsupported model IR version|Load model (?:from )?\S* failed|ONNXRuntimeError\].*(?:INVALID_PROTOBUF|INVALID_GRAPH|NO_MODEL)|failed to load model|invalid model file|bad magic/i;

function ownField(value: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** These are process facts and the engines' own fixed diagnostics, never a model's reading. */
export function structuredLocalEngineFailure(error: unknown): LocalEngineFailure {
  if (error === null || typeof error !== 'object') return { kind: 'failed', signal: '', code: undefined };
  const rawSignal = ownField(error, 'signal');
  const signal = typeof rawSignal === 'string' ? rawSignal : '';
  const rawCode = ownField(error, 'code');
  const code = typeof rawCode === 'number' || typeof rawCode === 'string' ? rawCode : undefined;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'cancelled', signal, code };
  if (ownField(error, 'killed') === true && (signal === 'SIGTERM' || signal === '')) return { kind: 'cancelled', signal, code };
  if (['SIGABRT', 'SIGSEGV', 'SIGILL', 'SIGBUS', 'SIGFPE'].includes(signal)) return { kind: 'fatal-crash', signal, code };
  const stderr = ownField(error, 'stderr');
  if (typeof stderr === 'string' && MODEL_LOAD_MARKERS.test(stderr)) return { kind: 'model-load-incompatible', signal, code };
  return { kind: 'failed', signal, code };
}
