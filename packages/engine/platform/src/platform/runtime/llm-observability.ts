/**
 * LLM observability utilities.
 *
 * Provides:
 * - Prompt/response content summarization for redaction-by-default telemetry
 * - instrumentedLlmCall() wrapper that emits LLM_REQUEST_STARTED + enriched LLM_RESPONSE_RECEIVED
 * - includeRawPrompts config awareness
 */
import {
  llmRequestsTotal,
  llmRequestDurationMs,
  llmTokensInput,
  llmTokensOutput,
  llmRequestsStarted,
  platformTracer,
} from './metrics.js';
import { endLlmSpan } from './telemetry/spans/index.js';
import { SpanKind } from './telemetry/types.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

/** Structured prompt summary emitted in telemetry events (default: redacted). */
export interface PromptSummary {
  /** Byte length of the raw content. */
  length: number;
  /** First 100 chars of the raw content (safe preview). */
  first100chars: string;
}

/**
 * Summarize prompt/response content for telemetry emission.
 * When includeRawPrompts is true, returns the raw string.
 * Default (false): returns a PromptSummary with length and first100chars.
 */
export function summarizePromptContent(
  content: string,
  includeRaw: boolean,
): PromptSummary | string {
  if (includeRaw) return content;
  return {
    length: content.length,
    first100chars: content.slice(0, 100),
  };
}

/**
 * Result from an instrumented LLM call.
 * Adds durationMs and retries tracking to the provider response.
 */
export interface InstrumentedLlmResult<T> {
  result: T;
  durationMs: number;
  retries: number;
}

/**
 * Wrap any LLM provider call to track duration, retry count, and
 * record platformMeter instruments (llmRequestsTotal, llmRequestDurationMs,
 * llmTokensInput, llmTokensOutput).
 *
 * Providers wrap their .chat() / .generate() calls with this helper.
 *
 * Usage:
 * ```ts
 * const { result, durationMs, retries } = await instrumentedLlmCall(
 *   async () => await this.chat(params),
 *   { provider: this.name, model: params.model ?? this.defaultModel },
 * );
 * ```
 */
/**
 * Emit LLM_REQUEST_STARTED metric at the llm-observability layer.
 *
 * Records the llmRequestsStarted counter so callers without bus access still
 * get per-provider/model observability. Callers that also hold a RuntimeEventBus
 * should additionally call emitLlmRequestStarted(bus, ctx, data) from emitters/turn.
 */
function recordLlmRequestStartedMetric(opts: { provider?: string | undefined; model?: string | undefined }): void {
  const labels: Record<string, string> = {};
  if (opts.provider) labels.provider = opts.provider;
  if (opts.model) labels.model = opts.model;
  llmRequestsStarted.add(1, labels);
}

export async function instrumentedLlmCall<T>(
  fn: () => Promise<T>,
  opts?: {
    maxRetries?: number | undefined;
    retryDelayMs?: number | undefined;
    /** Provider name for metric labels (e.g. 'anthropic'). */
    provider?: string | undefined;
    /** Model name for metric labels (e.g. 'claude-opus-4-5'). */
    model?: string | undefined;
    /** Extract token usage from a successful result to record histogram instruments. */
    extractTokens?: (result: T) => { inputTokens?: number; outputTokens?: number } | undefined;
    /**
     * Optional callback invoked on entry before the first attempt.
     * Callers that have bus/ctx access can wire emitLlmRequestStarted here.
     */
    onStarted?: (() => void) | undefined;
    /**
     * True for a result that hands the request to another instrumented
     * provider. The call is then neither a success nor a failure here: the
     * receiving provider records the outcome, so counting it again would
     * report one request twice.
     */
    isHandover?: ((result: T) => boolean) | undefined;
  }
): Promise<InstrumentedLlmResult<T>> {
  const maxRetries = opts?.maxRetries ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? 0;
  const startedAt = Date.now();
  // Auto-emit LLM_REQUEST_STARTED metric on entry (no bus required)
  recordLlmRequestStartedMetric({ provider: opts?.provider, model: opts?.model });
  opts?.onStarted?.();
  // The provider-call span, on whatever tracer `telemetry.otelMode` installed.
  // With the mode off this is the no-op span (`spanContext.isValid === false`)
  // and every call below is a no-op, which is why the hot path pays nothing for
  // it; with the mode on the same code records a real CLIENT span and, in
  // remote-export, hands it to the OTLP exporter when it ends.
  const span = platformTracer().startSpan('llm.call', {
    kind: SpanKind.CLIENT,
    attributes: {
      'llm.provider': opts?.provider ?? 'unknown',
      'llm.model': opts?.model ?? 'unknown',
      'llm.streaming': false,
    },
  });
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && retryDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs);
          timer.unref?.();
        });
      }
      continue;
    }
    if (opts?.isHandover?.(result)) {
      endLlmSpan(span, { success: true });
      return { result, durationMs: Date.now() - startedAt, retries: attempt };
    }
    // The provider call has succeeded and been billed. Reading usage out of the
    // response must never turn that into a failure or a second request.
    const durationMs = Date.now() - startedAt;
    let tokens: { inputTokens?: number; outputTokens?: number } | undefined;
    try {
      tokens = opts?.extractTokens?.(result);
    } catch (extractError) {
      logger.warn('LLM token extraction failed; continuing without usage', {
        provider: opts?.provider,
        model: opts?.model,
        error: summarizeError(extractError),
      });
    }
    if (opts?.provider !== undefined || opts?.model !== undefined) {
      const labels: Record<string, string> = {};
      if (opts.provider) labels.provider = opts.provider;
      if (opts.model) labels.model = opts.model;
      llmRequestsTotal.add(1, { ...labels, status: 'success' });
      llmRequestDurationMs.record(durationMs, labels);
      if (tokens?.inputTokens !== undefined && tokens.inputTokens > 0) {
        llmTokensInput.record(tokens.inputTokens, labels);
      }
      if (tokens?.outputTokens !== undefined && tokens.outputTokens > 0) {
        llmTokensOutput.record(tokens.outputTokens, labels);
      }
    }
    endLlmSpan(span, {
      success: true,
      ...(tokens !== undefined
        ? { tokens: { inputTokens: tokens.inputTokens ?? 0, outputTokens: tokens.outputTokens ?? 0 } }
        : {}),
    });
    return { result, durationMs, retries: attempt };
  }

  // Record error metric on final failure
  if (opts?.provider !== undefined || opts?.model !== undefined) {
    const labels: Record<string, string> = {};
    if (opts?.provider) labels.provider = opts.provider;
    if (opts?.model) labels.model = opts.model;
    llmRequestsTotal.add(1, { ...labels, status: 'error' });
    llmRequestDurationMs.record(Date.now() - startedAt, labels);
  }

  endLlmSpan(span, { success: false, error: summarizeError(lastError) });
  throw lastError;
}
