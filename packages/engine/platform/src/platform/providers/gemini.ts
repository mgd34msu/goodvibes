import { ProviderAttemptDeniedError, revalidateProviderAttempt } from './attempt-guard.js';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderModelSource,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.js';
import { budgetTokensForLevel } from './reasoning-effort.js';
import { resolveEffortForRequest } from './reasoning-effort-families.js';
import { reasoningRejectionHint } from './reasoning-rejection-hint.js';
import {
  fetchGeminiModelIds,
  runLiveModelRefresh,
  type LiveModelDiscoveryResult,
  type ProviderModelRefreshOptions,
} from './live-model-discovery.js';

import { createGeminiResponseIdentityAccumulator } from './gemini-response-identity.js';
import { mapGeminiStopReason } from './stop-reason-maps.js';
import { parseRateLimitHeaders } from './rate-limit-headers.js';
import { ProviderError } from '../types/errors.js';
import { withRetry, type RetryConfig } from '../utils/retry.js';
import { trackDeliveredOutput } from './stream-delivery.js';
import { logger } from '../utils/logger.js';
import { fetchWithTimeout, instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { instrumentedLlmCall } from '../runtime/llm-observability.js';
import {
  toGeminiFunctionDeclarations,
  toGeminiContents,
  fromGeminiParts,
} from './tool-formats.js';
import type { GeminiPart } from './tool-formats.js';
import type { CacheHitTracker } from './cache-strategy.js';
import { summarizeError, toProviderError } from '../utils/error-display.js';
import { SseLineBuffer } from './sse-line-buffer.js';
import { createHash } from 'node:crypto';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_CACHE_TTL_SECONDS = 3600;
/** Cache resources kept at once: enough for a main agent and a few sub-agents with their own prompts. */
const GEMINI_CACHED_CONTENT_LIMIT = 4;
/** Inputs remembered as seen once, waiting for a second use. */
const GEMINI_SEEN_INPUT_LIMIT = 16;
const GEMINI_BELOW_CACHE_MINIMUM = /min_total_token_count|too small/i;
/** Tool call thought signatures kept per provider before the oldest go; far more than any live tool-use loops hold at once. */
const MAX_THOUGHT_SIGNATURES = 4096;
const NOOP_CACHE_HIT_TRACKER: Pick<CacheHitTracker, 'recordTurn'> = {
  recordTurn: () => {},
};

/**
 * Dated fallback model list, used when no API key is configured (so a live
 * ListModels call isn't possible) and as the offline baseline when a live
 * call fails with no prior cache. Docs-verified (no Gemini API key was
 * available in the environment to live-verify) against ai.google.dev model
 * pages on 2026-07-12; update this list (and the date below) whenever it is
 * re-verified against a live key or current docs.
 */
export const GEMINI_DATED_STATIC_MODELS: readonly string[] = [
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-pro-latest',
  'gemini-3-pro',
  'gemini-3.1-pro-preview',
  'gemini-3-flash',
  'gemini-2.0-flash',
];
export const GEMINI_DATED_STATIC_MODELS_AS_OF = '2026-07-12';

interface GeminiCandidate {
  content: { parts: GeminiPart[]; role: string };
  finishReason: string;
}

interface GeminiResponseBody {
  candidates?: GeminiCandidate[] | undefined;
  /** Set when Gemini refused the prompt itself; such a response carries no candidates. */
  promptFeedback?: { blockReason?: string | undefined; blockReasonMessage?: string | undefined } | undefined;
  usageMetadata?: {
    promptTokenCount?: number | undefined;
    candidatesTokenCount?: number | undefined;
    cachedContentTokenCount?: number | undefined;
  };
}

/**
 * Build Gemini's `thinking_config`, choosing the one field this model's
 * generation accepts.
 *
 * Gemini 3-series takes `thinking_level` (a named level); Gemini 2.5-series
 * takes `thinking_budget` (a token count). Returns undefined when the model
 * exposes no reasoning control, or when the requested depth resolved to
 * nothing to send.
 */
function buildGeminiThinkingConfig(
  model: string,
  params: Pick<ChatRequest, 'reasoningEffort' | 'reasoningEffortSpec'>,
): { config: Record<string, unknown> | undefined; level: string | undefined } {
  const { value, spec } = resolveEffortForRequest(params.reasoningEffort, {
    provider: 'google', modelId: model,
    ...(params.reasoningEffortSpec ? { spec: params.reasoningEffortSpec } : {}),
  });
  // A `fallback`-sourced spec means nothing recognises this model, so there is
  // no evidence it accepts a thinking config at all. Google serves
  // non-thinking models on the same endpoint, so silence beats a guess.
  if (value === undefined || spec.source === 'fallback') {
    return { config: undefined, level: undefined };
  }

  if (spec.kind === 'budget_tokens') {
    return { config: { thinking_budget: budgetTokensForLevel(value, spec) }, level: value };
  }
  if (spec.kind === 'effort') {
    // 'none' is Gemini's own documented way to turn thinking off on the
    // 3-series, so it goes on the wire as a level rather than being dropped.
    return { config: { thinking_level: value }, level: value };
  }
  if (spec.kind === 'toggle') {
    return { config: { thinking_level: value === 'none' ? 'none' : 'high' }, level: value };
  }
  return { config: undefined, level: undefined };
}

/**
 * GeminiProvider, calls the Gemini generateContent API directly via fetch.
 * Tools are `functionDeclarations` inside a `tools` array.
 * Tool calls come as `functionCall` parts; results as `functionResponse` parts.
 * Uses streamGenerateContent for real-time token delivery when onDelta is provided.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly adapterKind = 'gemini' as const;
  readonly credentialAuthority = 'resolver' as const;
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };
  /**
   * Thought signatures by tool call id. One provider serves every agent that
   * uses Gemini, so signatures are keyed by the call they came with, never by
   * function name, and one agent's turn never drops another's. The oldest go
   * once the map holds MAX_THOUGHT_SIGNATURES.
   */
  private thoughtSignatures = new Map<string, string>();

  /**
   * Populated synchronously with the dated-static baseline at construction
   * (never empty), then replaced by `refreshModels()` with the live
   * ListModels result. See `modelSource`.
   */
  private _models: string[] = [...GEMINI_DATED_STATIC_MODELS];
  get models(): string[] {
    return this._models;
  }

  private readonly apiKey: string;
  private readonly embeddingModel = 'gemini-embedding-001';
  private readonly cacheHitTracker: Pick<CacheHitTracker, 'recordTurn'>;
  private readonly modelsCachePath: string | undefined;

  /**
   * Server cache resources by the digest of their exact input (system prompt,
   * tools and model), oldest first. A few agents with different prompts each
   * keep theirs; the oldest is deleted on the server when a new one would
   * exceed the bound, and every one is deleted by `dispose()`.
   */
  private readonly cachedContents = new Map<string, { readonly name: string; readonly expiresAt: number }>();
  /** Inputs seen once and not cached: Gemini's implicit caching covers a single use. */
  private readonly seenOnce = new Set<string>();
  /** One bounded rejection hint, rather than retaining a history of large prompts. */
  private uncacheableKey: string | null = null;
  /** Creations in flight, so parallel requests with one input create one resource. */
  private readonly cacheCreations = new Map<string, Promise<string | null>>();

  constructor(
    apiKey: string,
    cacheHitTracker: Pick<CacheHitTracker, 'recordTurn'> = NOOP_CACHE_HIT_TRACKER,
    modelsCachePath?: string,
    private readonly retryConfig?: Partial<RetryConfig>,
  ) {
    this.apiKey = apiKey;
    this.cacheHitTracker = cacheHitTracker;
    this.modelsCachePath = modelsCachePath;
  }

  /**
   * Re-check Gemini's live model list. Called at boot (background, respects
   * the on-disk TTL cache) and on-demand for a picker-open re-check or an
   * explicit user refresh (`force: true`, bypasses the TTL cache). Always
   * resolves, falls back to the on-disk cache, then to the dated-static
   * list, and reports the honest reason when live discovery fails rather
   * than silently keeping stale data with no explanation.
   */
  async refreshModels(force = false, options: ProviderModelRefreshOptions = {}): Promise<LiveModelDiscoveryResult> {
    const result = await runLiveModelRefresh({
      providerName: this.name,
      recordTo: options.recordTo,
      borrowFrom: options.borrowFrom,
      cachePath: this.modelsCachePath,
      datedStaticModels: GEMINI_DATED_STATIC_MODELS,
      datedStaticAsOf: GEMINI_DATED_STATIC_MODELS_AS_OF,
      isConfigured: Boolean(this.apiKey),
      fetchLive: () => fetchGeminiModelIds(this.apiKey),
      force,
    });
    this._models = [...result.models];
    return result;
  }

  private async ensureCachedContent(
    systemPrompt: string | undefined,
    tools: import('./interface.js').ChatRequest['tools'],
    model: string,
    beforeAttempt?: ChatRequest['beforeAttempt'],
  ): Promise<string | null> {
    // Skip if no system prompt and no tools
    if (!systemPrompt && (!tools || tools.length === 0)) return null;

    const toolsJson = JSON.stringify(tools ?? []);
    // Small requests never need a cache identity or retained rejection entry.
    const estimatedChars = (systemPrompt?.length ?? 0) + toolsJson.length;
    if (estimatedChars / 3 < 28_000) return null;

    // One digest of the exact input: the maps hold 64 characters per input, not the prompt.
    const key = createHash('sha256').update(model).update('\0').update(systemPrompt ?? '').update('\0').update(toolsJson).digest('hex');
    if (key === this.uncacheableKey) return null;

    const cached = this.cachedContents.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      this.cachedContents.delete(key);
      this.cachedContents.set(key, cached);
      return cached.name;
    }
    // An expiring resource is retired by its server TTL; it is only forgotten here.
    if (cached) this.cachedContents.delete(key);

    // Parallel requests with the same input share one creation; a follower whose
    // leader failed sends its request uncached.
    const inFlight = this.cacheCreations.get(key);
    if (inFlight) return inFlight.catch(() => null);

    // The first use of an input is left to implicit caching; a billed resource is
    // created only for an input that comes back.
    if (!cached && !this.seenOnce.has(key)) {
      this.seenOnce.add(key);
      if (this.seenOnce.size > GEMINI_SEEN_INPUT_LIMIT) this.seenOnce.delete(this.seenOnce.values().next().value!);
      return null;
    }
    this.seenOnce.delete(key);

    const creation = this.createCachedContent(key, estimatedChars, systemPrompt, tools, model, beforeAttempt);
    this.cacheCreations.set(key, creation);
    const settled = () => { if (this.cacheCreations.get(key) === creation) this.cacheCreations.delete(key); };
    void creation.then(settled, settled);
    return creation;
  }

  /** Remember a created resource; past the bound, the oldest is deleted on the server. */
  private rememberCachedContent(key: string, name: string, expiresAt: number): void {
    this.cachedContents.set(key, { name, expiresAt });
    while (this.cachedContents.size > GEMINI_CACHED_CONTENT_LIMIT) {
      const [oldestKey, oldest] = this.cachedContents.entries().next().value!;
      this.cachedContents.delete(oldestKey);
      void this.deleteCachedContent(oldest.name);
    }
  }

  private async deleteCachedContent(name: string): Promise<void> {
    try {
      const res = await fetchWithTimeout(`${GEMINI_API_BASE}/${name}`, {
        method: 'DELETE',
        headers: { 'x-goog-api-key': this.apiKey },
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok && res.status !== 404) logger.warn('[Gemini] Cache deletion failed', { name, status: res.status });
    } catch (err) {
      logger.warn('[Gemini] Cache deletion error', { name, error: summarizeError(err) });
    }
  }

  /** Delete every cache resource this provider created; call when the provider is replaced or the process ends. */
  async dispose(): Promise<void> {
    const names = [...this.cachedContents.values()].map((entry) => entry.name);
    this.cachedContents.clear();
    this.seenOnce.clear();
    await Promise.all(names.map((name) => this.deleteCachedContent(name)));
  }

  private async createCachedContent(
    key: string,
    estimatedChars: number,
    systemPrompt: string | undefined,
    tools: import('./interface.js').ChatRequest['tools'],
    model: string,
    beforeAttempt?: ChatRequest['beforeAttempt'],
  ): Promise<string | null> {
    let rejection: { status: number; text: string };
    try {
      const cacheBody: Record<string, unknown> = {
        model: `models/${model}`,
        ttl: `${GEMINI_CACHE_TTL_SECONDS}s`,
      };

      if (systemPrompt) {
        cacheBody['systemInstruction'] = { parts: [{ text: systemPrompt }] };
      }

      if (tools && tools.length > 0) {
        cacheBody['tools'] = [{ functionDeclarations: toGeminiFunctionDeclarations(tools) }];
      }

      if (beforeAttempt) await revalidateProviderAttempt(beforeAttempt);
      const res = await fetchWithTimeout(`${GEMINI_API_BASE}/cachedContents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(cacheBody),
      });

      if (res.ok) {
        const data = await res.json() as { name: string; expireTime: string };
        this.rememberCachedContent(key, data.name, new Date(data.expireTime).getTime());

        logger.info(`[Gemini] Created cache: ${data.name} (expires ${data.expireTime})`);
        return data.name;
      }
      rejection = { status: res.status, text: await res.text().catch(() => '') };
    } catch (err) {
      if (err instanceof ProviderAttemptDeniedError) throw err;
      logger.warn('[Gemini] Cache creation error', { error: summarizeError(err) });
      return null;
    }

    // Only a 400 (INVALID_ARGUMENT) rejects the content itself; Gemini names the
    // minimum (`min_total_token_count`, "too small") when the prompt is under it.
    // Any other status leaves the prompt cacheable so a later request tries again.
    const { status, text } = rejection;
    const belowMinimum = status === 400 && GEMINI_BELOW_CACHE_MINIMUM.test(text);
    if (belowMinimum) {
      this.uncacheableKey = estimatedChars <= 1024 * 1024 ? key : null;
      logger.debug('[Gemini] Content below cache minimum', { status, error: text.slice(0, 200) });
    } else {
      logger.warn('[Gemini] Cache creation failed', { status, error: text.slice(0, 200) });
    }
    return null;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const { messages, tools, model, maxTokens, signal, systemPrompt, onRetry } = params;
    const { onDelta, canRetry } = trackDeliveredOutput(params.onDelta);

    return (await instrumentedLlmCall(() => withRetry(async () => {
      // Gemini thinking models require each call's signature on both sides of the round-trip.
      const { contents, systemInstruction } = toGeminiContents(messages, systemPrompt, (callId) => this.thoughtSignatures.get(callId));

      const body: Record<string, unknown> = { contents };

      const cachedName = await this.ensureCachedContent(systemPrompt, tools, model, params.beforeAttempt);

      if (cachedName) {
        // Cached content already contains systemInstruction and tools, do NOT resend them
        body['cachedContent'] = cachedName;
      } else {
        if (systemInstruction) {
          body['systemInstruction'] = systemInstruction;
        }

        if (tools && tools.length > 0) {
          body['tools'] = [{
            functionDeclarations: toGeminiFunctionDeclarations(tools),
          }];
          // A request on cached content cannot carry a tool config; there the caller drops any call.
          if (params.toolChoice === 'none') body['toolConfig'] = { functionCallingConfig: { mode: 'NONE' } };
        }
      }

      if (maxTokens) {
        body['generationConfig'] = { maxOutputTokens: maxTokens };
      }

      // Gemini 3-series models take a named `thinking_level`; Gemini 2.5-series
      // take a numeric `thinking_budget`. Google's thinking docs are explicit
      // that a request specifying both is rejected, so the resolved spec picks
      // exactly one and the other is never sent.
      const thinking = buildGeminiThinkingConfig(model, params);
      if (thinking.config) {
        body['generationConfig'] = {
          ...(body['generationConfig'] as Record<string, unknown> ?? {}),
          thinking_config: thinking.config,
        };
      }

      // Always use streaming endpoint; parse NDJSON chunks
      const url = `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse`;

      if (params.beforeAttempt) await revalidateProviderAttempt(params.beforeAttempt);
      let res: Response;
      try {
        res = await instrumentedFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
          ...(signal !== undefined ? { signal } : {}),
        } as RequestInit);
      } catch (err: unknown) {
        throw toProviderError(err, {
          provider: this.name,
          operation: 'chat',
          phase: 'request',
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        const effortHint = reasoningRejectionHint(res.status, text, thinking.level);
        const retryAfterMs = parseRateLimitHeaders(res.headers)?.retryAfterMs;
        throw new ProviderError(`Gemini API error ${res.status}: ${text}${effortHint}`, {
          statusCode: res.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          provider: this.name,
          operation: 'chat',
          phase: 'request',
        });
      }

      const rateLimit = parseRateLimitHeaders(res.headers) ?? undefined;

      // Attempt-local: never retain identity from a failed partial stream or another call.
      const responseIdentity = createGeminiResponseIdentityAccumulator({
        provider: this.name, adapterKind: this.adapterKind, model,
      });

      // Accumulate state from streaming chunks
      const allParts: GeminiPart[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let lastFinishReason = '';
      // Written by processSseLine and read after the stream ends.
      const refusal: { block?: { reason: string; message?: string | undefined } } = {};
      let streamedText = '';

      const reader = res.body?.getReader();
      if (!reader) {
        throw new ProviderError('Gemini chat returned no response body.', {
          statusCode: 502,
          provider: this.name,
          operation: 'chat',
          phase: 'response',
        });
      }

      const sseBuffer = new SseLineBuffer();

      const processSseLine = (line: string): void => {
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') return;

        let chunk: GeminiResponseBody;
        try {
          chunk = JSON.parse(data) as GeminiResponseBody;
        } catch {
          responseIdentity.markUnparsedDataChunk();
          logger.warn('Gemini SSE: failed to parse JSON chunk', {
            chunkPreview: data.slice(0, 200),
            chunkLength: data.length,
          });
          return;
        }

        // Observe every parsed chunk, including metadata-only chunks and the final flush.
        responseIdentity.observe(chunk);
        const blockReason = chunk.promptFeedback?.blockReason;
        if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
          refusal.block = { reason: blockReason, message: chunk.promptFeedback?.blockReasonMessage };
        }
        const candidate = chunk.candidates?.[0];
        if (candidate) {
          const parts = candidate.content?.parts ?? [];
          for (const part of parts) {
            allParts.push(part);
            if (part.text && onDelta) {
              streamedText += part.text;
              onDelta({ content: part.text });
            }
            if (part.functionCall) {
              if (onDelta) {
                onDelta({ toolCalls: [{ index: 0, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) }] });
              }
            }
          }
          if (candidate.finishReason) {
            lastFinishReason = candidate.finishReason;
          }
        }

        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
          cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount ?? cacheReadTokens;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          for (const line of sseBuffer.feed(value)) processSseLine(line);
        }
        // Drain any bytes left after the last newline: a server that closes the
        // connection right after a final `data:` line with no trailing newline
        // would otherwise drop that last chunk (usageMetadata / finishReason).
        // flush() returns [] for newline-terminated streams, so this is a no-op
        // for compliant servers.
        for (const line of sseBuffer.flush()) processSseLine(line);
      } finally {
        reader.releaseLock();
      }

      // A refused prompt is Gemini's answer, not a cut connection: the same
      // prompt is refused again, so it is final and names the reason.
      const promptBlock = refusal.block;
      if (promptBlock && !lastFinishReason) {
        throw new ProviderError(
          `Gemini refused the prompt (${promptBlock.reason})${promptBlock.message ? `: ${promptBlock.message}` : '.'}`,
          {
            statusCode: 400,
            category: 'bad_request',
            guidance: 'Gemini blocks a prompt it reads as unsafe or prohibited. Rephrase the request or remove the flagged content, or switch to another model.',
            providerCode: promptBlock.reason,
            provider: this.name,
            operation: 'chat',
            phase: 'response',
          },
        );
      }

      // Gemini closes every candidate with a finishReason; a stream that ends
      // without one was cut and its text is a truncated answer. Retryable only
      // while nothing was shown (canRetry).
      if (!lastFinishReason) {
        throw new ProviderError('Gemini stream ended without a finish reason; the answer may be truncated.', {
          statusCode: 502,
          provider: this.name,
          operation: 'chat',
          phase: 'stream',
        });
      }

      // Use streamed text directly if available (avoids re-parsing duplicated text parts)
      const { text: parsedText, toolCalls, signatures } = fromGeminiParts(allParts);
      for (const [callId, signature] of signatures) {
        this.thoughtSignatures.set(callId, signature);
        if (this.thoughtSignatures.size > MAX_THOUGHT_SIGNATURES) this.thoughtSignatures.delete(this.thoughtSignatures.keys().next().value!);
      }
      // Prefer streamedText for content; fall back to parsed if no streaming happened
      const text = streamedText || parsedText;

      let stopReason: ChatStopReason = toolCalls.length > 0
        ? 'tool_call'
        : mapGeminiStopReason(lastFinishReason);

      this.cacheHitTracker.recordTurn({
        inputTokens,
        cacheReadTokens,
      });

      return {
        content: text,
        responseIdentity: responseIdentity.snapshot(),
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
          // cacheWriteTokens is omitted: Gemini does not charge separately for cache writes
        },
        stopReason,
        ...(lastFinishReason ? { providerStopReason: lastFinishReason } : {}),
        ...(rateLimit ? { rateLimit } : {}),
      };
    }, { ...this.retryConfig, ...(signal ? { signal } : {}), ...(params.beforeAttempt ? { beforeAttempt: params.beforeAttempt } : {}), ...(params.maxRetries !== undefined ? { maxRetries: params.maxRetries } : {}), canRetry }, onRetry), { provider: 'gemini', model: model })).result;
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    const model = request.model ?? this.embeddingModel;
    const body: Record<string, unknown> = {
      content: { parts: [{ text: request.text }] },
    };
    if (request.dimensions) {
      body['embedContentConfig'] = { outputDimensionality: request.dimensions };
    }

    let res: Response;
    try {
      res = await instrumentedFetch(`${GEMINI_API_BASE}/models/${model}:embedContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      } as RequestInit);
    } catch (error: unknown) {
      throw toProviderError(error, {
        provider: this.name,
        operation: 'embed',
        phase: 'request',
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      throw new ProviderError(`Gemini embeddings API error ${res.status}: ${text}`, {
        statusCode: res.status,
        provider: this.name,
        operation: 'embed',
        phase: 'request',
      });
    }

    const data = await res.json() as { embedding?: { values?: number[] } };
    const values = data.embedding?.values ?? [];
    return {
      vector: Float32Array.from(values),
      dimensions: values.length,
      modelId: model,
      metadata: {
        usage: request.usage,
        provider: this.name,
      },
    };
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes, summarizeProviderAuth } = await import('./runtime-metadata.js');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: 'gemini',
      apiKeyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
      serviceNames: ['gemini'],
    }, deps);
    const auth = summarizeProviderAuth({
      configured: Boolean(this.apiKey),
      detail: this.apiKey ? 'Gemini API key available' : 'Gemini API key is not configured',
    }, authRoutes);
    return {
      auth: {
        mode: 'api-key',
        configured: auth.configured,
        detail: auth.detail,
        envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
        routes: authRoutes,
      },
      models: {
        models: this.models,
        embeddingModel: this.embeddingModel,
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        notes: ['Embeddings use Gemini embedContent with reduced output dimensionality when requested.'],
      },
      policy: {
        local: false,
        streamProtocol: 'gemini-sse',
        // Gemini 3-series takes thinking_level, 2.5-series takes
        // thinking_budget, and older generations take neither.
        reasoningMode: 'per-model-thinking-level-or-budget',
        cacheStrategy: 'gemini-cached-content',
      },
    };
  }
}
