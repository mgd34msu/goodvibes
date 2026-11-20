import { ProviderAttemptDeniedError, revalidateProviderAttempt } from './attempt-guard.js';
import type OpenAI from 'openai';
import { createOpenAIClient, openAIToFile } from './optional-openai.js';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderBatchAdapter,
  ProviderBatchCreateInput,
  ProviderBatchCreateResult,
  ProviderBatchPollResult,
  ProviderBatchResult,
  ProviderModelSource,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.js';
import {
  diffModelIds,
  fetchOpenAIModelIds,
  runLiveModelRefresh,
  type LiveModelDiscoveryResult,
  type ProviderModelRefreshOptions,
} from './live-model-discovery.js';

import { mapOpenAIStopReason } from './stop-reason-maps.js';
import { ProviderError } from '../types/errors.js';
import { withRetry } from '../utils/retry.js';
import { trackDeliveredOutput } from './stream-delivery.js';
import { instrumentedLlmCall } from '../runtime/llm-observability.js';
import {
  toOpenAITools,
  toOpenAIMessages,
  fromOpenAIToolCalls,
} from './tool-formats.js';
import type { OpenAIToolCall } from './tool-formats.js';
import { accumOpenAIToolCall, finalizeOpenAIToolCalls, applyOpenAIChunkUsage, resolveOpenAIToolCallsAndFallback } from './openai-stream-helpers.js';
import { withProviderStopReason } from './provider-stop-reason.js';
import { isOpenAiSpentQuota, openAiRetryAfterMs, parseRateLimitHeaders } from './rate-limit-headers.js';
import type { CacheHitTracker } from './cache-strategy.js';
import { extractOpenAIStreamTextDelta } from './openai-stream-delta.js';
import { normalizeError, summarizeError, toProviderError } from '../utils/error-display.js';
import { resolveOpenAIClientApiKey } from './openai-compat.js';
import { resolveEffortForRequest, resolveReasoningEffortSpec } from './reasoning-effort-families.js';
import { reasoningEffortLevels } from './reasoning-effort.js';
import { fetchOpenAISubscriptionModelIds, OpenAISubscriptionRoute, subscriptionAccountKey, type OpenAISubscriptionStore } from './openai-codex.js';
import { logger } from '../utils/logger.js';

/** What a failed sign-in's category means, in a fixed sentence. */
const SIGN_IN_FAILURE_WORDS: Readonly<Record<string, string>> = {
  authentication: 'the sign-in was not accepted',
  authorization: 'the sign-in may not use this model',
  permission: 'the sign-in may not use this model',
  billing: 'its plan or credit is used up',
  rate_limit: 'it reached its rate limit',
  timeout: 'the request timed out',
  network: 'the connection failed',
  bad_request: 'the request was refused',
  not_found: 'the model was not found there',
  service: 'the service answered with an error',
  protocol: 'its answer could not be read',
};

/**
 * Why a sign-in failed, as the person and every record of the move may see
 * it: a fixed sentence for the failure's category, the HTTP status, and the
 * provider's short error code when it is one. Never the provider's own words:
 * an upstream body can carry anything, and this reason is put in the
 * transcript, the turn's events and the final error.
 */
export function signInFailureReason(error: unknown): string {
  const normalized = normalizeError(error);
  const words = SIGN_IN_FAILURE_WORDS[normalized.category] ?? 'the request failed';
  const status = normalized.statusCode !== undefined ? ` (HTTP ${normalized.statusCode})` : '';
  const code = normalized.providerCode !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(normalized.providerCode) ? `, code ${normalized.providerCode}` : '';
  return `${words}${status}${code}`;
}

const NOOP_CACHE_HIT_TRACKER: Pick<CacheHitTracker, 'recordTurn'> = {
  recordTurn: () => {},
};

/**
 * The chat-completions `create` signature, named here because the client is
 * now resolved through a promise and cannot be referenced as `typeof
 * this.client...` in a type position. `OpenAI` is imported type-only, so the
 * specifier is erased and never reaches the module graph.
 */
type OpenAIChatCreate = OpenAI['chat']['completions']['create'];

/** The two ways of signing in to OpenAI. Each is a route with its own endpoint and wire format. */
export type OpenAISignInRoute = 'subscription' | 'api-key';

export const OPENAI_SIGN_IN_ROUTE_LABELS: Readonly<Record<OpenAISignInRoute, string>> = {
  subscription: 'ChatGPT subscription',
  'api-key': 'API key',
};

/** Failures that belong to one sign-in, not to the request: the next sign-in may serve the same model. */
function routeFailure(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.category === 'billing') return true;
  const status = error.statusCode;
  if (status === undefined) return error.phase !== 'stream';
  if (status === 401 || status === 403 || status === 404 || status === 408 || status === 409 || status === 429 || status >= 500) return true;
  return status === 400 && refusedModel(error);
}

/** The endpoint refused the model id itself (unknown to it, or not served to this sign-in). */
function refusedModel(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.statusCode !== 404 && error.statusCode !== 400) return false;
  return /model/i.test(error.message) && /(does not exist|not found|model_not_found|not supported|unsupported|unknown|not available|no access)/i.test(error.message);
}

/**
 * OpenAI: one provider, one model list, two ways of signing in.
 *
 * - `subscription`: a ChatGPT plan signed in through Codex (chatgpt.com
 *   backend, Responses wire format), see openai-codex.ts.
 * - `api-key`: the OpenAI API (api.openai.com, Chat Completions), via the
 *   official `openai` npm package.
 *
 * A request goes to the subscription when it is set up, else to the API key.
 * When both are set up and the subscription fails for a reason of its own
 * (sign-in ended, plan limit, model not on the plan, the service failing), the
 * same model is asked again through the API key, and the response says which
 * sign-in answered and why it moved, so the person is told once. Nothing has
 * reached the caller before such a move: a request that already streamed
 * output is never repeated.
 *
 * The model list is the provider's own, read from both endpoints when they
 * answer (GET /v1/models, GET /codex/models), else their last answers on disk,
 * else nothing of its own: the pinned model catalog's OpenAI rows are the list
 * then. It applies to whichever sign-in is used.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly adapterKind = 'openai' as const;
  readonly credentialAuthority = 'resolver' as const;
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };

  /** The provider's own listing (both sign-ins); empty until it answers, when the pinned catalog stands. */
  private _models: string[] = [];
  get models(): string[] {
    return this._models;
  }
  /** What the subscription's own listing says it serves; null while it has not answered. */
  private subscriptionModels: ReadonlySet<string> | null = null;
  /** Models the subscription refused this session (not on the plan): asked through the API key first from then on. */
  private readonly subscriptionRefused = new Set<string>();
  /** The sign-in that answered last, for status surfaces, and the one that answered each model. */
  private lastAnswered: OpenAISignInRoute | null = null;
  private readonly answeredBy = new Map<string, OpenAISignInRoute>();
  /** When the provider's own list was last read from an endpoint (epoch ms), and from where. */
  private listing: { readonly source: 'live' | 'cache' | 'catalog'; readonly listedAt?: number | undefined } = { source: 'catalog' };
  private readonly subscription: OpenAISubscriptionRoute | null;
  /** Called when an endpoint refuses a model as unknown: the lists are read again off the request path. */
  private readonly onUnknownModel: (() => void) | undefined;
  readonly batch: ProviderBatchAdapter & {
    /** The newest batch created since `createdAfterMs` whose metadata holds `key: value`, or null when there is none. */
    findBatchByMetadata(key: string, value: string, createdAfterMs: number): Promise<ProviderBatchPollResult | null>;
  };

  /**
   * The `openai` client, resolved on first use rather than at construction.
   *
   * `openai` is an optionalDependency, and this class used to build its client
   * in the constructor from a static import, which put the specifier on the
   * module graph of everything that reaches the provider registry, the daemon
   * included. One memoised promise per provider instance keeps the single
   * construction this class always did; every method that needs the client
   * already runs inside an async request path, so awaiting it changes no
   * public signature. When the package is absent the await throws an error
   * whose message names it, and each method's existing catch turns that into
   * the provider error the caller already handles.
   */
  private openaiClient: Promise<OpenAI> | undefined;
  private readonly apiKey: string;
  private readonly embeddingModel = 'text-embedding-3-small';
  private readonly cacheHitTracker: Pick<CacheHitTracker, 'recordTurn'>;
  private readonly modelsCachePath: string | undefined;

  constructor(
    apiKey: string,
    cacheHitTracker: Pick<CacheHitTracker, 'recordTurn'> = NOOP_CACHE_HIT_TRACKER,
    modelsCachePath?: string,
    options: {
      /** The ChatGPT subscription sign-in store; absent, the provider has only the API-key route. */
      readonly subscriptionManager?: OpenAISubscriptionStore | undefined;
      readonly onUnknownModel?: (() => void) | undefined;
    } = {},
  ) {
    this.apiKey = apiKey;
    this.cacheHitTracker = cacheHitTracker;
    this.modelsCachePath = modelsCachePath;
    this.subscription = options.subscriptionManager ? new OpenAISubscriptionRoute(options.subscriptionManager) : null;
    this.onUnknownModel = options.onUnknownModel;
    this.batch = {
      kind: 'provider-batch',
      endpoints: ['/v1/chat/completions'],
      createChatBatch: (input) => this.createChatBatch(input),
      retrieveBatch: (providerBatchId) => this.retrieveBatch(providerBatchId),
      cancelBatch: (providerBatchId) => this.cancelBatch(providerBatchId),
      getResults: (providerBatchId) => this.getBatchResults(providerBatchId),
      findBatchByMetadata: (key, value, createdAfterMs) => this.findBatchByMetadata(key, value, createdAfterMs),
    };
  }

  /**
   * The `openai` client for this provider, built once. `isConfigured()`
   * derives from `this.apiKey` (the ORIGINAL value, possibly empty); the
   * client itself needs a non-empty placeholder because openai's constructor
   * throws "Missing credentials..." on a falsy key.
   */
  private client(): Promise<OpenAI> {
    // Embeddings and the Batch API are API-key services: a ChatGPT subscription does not serve them.
    if (!this.apiKeyConfigured() && this.subscriptionConfigured()) {
      return Promise.reject(new ProviderError('This OpenAI request needs an API key (OPENAI_API_KEY, or /secrets): the ChatGPT subscription serves chat only, not embeddings or the Batch API. Nothing was sent.', {
        statusCode: 401, provider: this.name, operation: 'request', phase: 'auth',
      }));
    }
    this.openaiClient ??= createOpenAIClient({ apiKey: resolveOpenAIClientApiKey(this.apiKey) });
    return this.openaiClient;
  }

  /** Whether the API-key route is set up. */
  private apiKeyConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  /** Whether the subscription route is set up. */
  subscriptionConfigured(): boolean {
    return this.subscription?.isConfigured() ?? false;
  }

  /**
   * The sign-ins a request for `modelId` tries, in order: the subscription
   * when it is set up, then the API key. A model the subscription is known
   * not to serve (its own listing, or a refusal this session) goes to the API
   * key first; with no API key it is still asked of the subscription, so the
   * refusal is reported as it is.
   */
  signInRoutes(modelId?: string): OpenAISignInRoute[] {
    const id = modelId ? normalizeOpenAIModelId(modelId) : undefined;
    const subscription = this.subscriptionConfigured();
    const apiKey = this.apiKeyConfigured();
    const notOnPlan = id !== undefined && (this.subscriptionRefused.has(id) || (this.subscriptionModels !== null && !this.subscriptionModels.has(id)));
    const routes: OpenAISignInRoute[] = [];
    if (subscription && !(notOnPlan && apiKey)) routes.push('subscription');
    if (apiKey) routes.push('api-key');
    return routes;
  }

  /**
   * The sign-in serving `modelId` (or the provider, without one): the one
   * that answered it last, else the one the next request tries first. What a
   * request costs follows it: a ChatGPT plan has no per-token price.
   */
  activeSignInRoute(modelId?: string): OpenAISignInRoute | null {
    if (modelId !== undefined) return this.answeredBy.get(normalizeOpenAIModelId(modelId)) ?? this.signInRoutes(modelId)[0] ?? null;
    return this.lastAnswered ?? this.signInRoutes()[0] ?? null;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const routes = this.signInRoutes(params.model);
    if (routes.length === 0) {
      throw new ProviderError('OpenAI is not signed in: no request was sent. Sign in with your ChatGPT subscription (/provider sign-in openai) or set an OpenAI API key (OPENAI_API_KEY, or /secrets).', {
        statusCode: 401,
        provider: this.name,
        operation: 'chat',
        phase: 'auth',
      });
    }
    let movedFrom: { readonly route: OpenAISignInRoute; readonly label: string; readonly reason: string } | undefined;
    for (const [index, route] of routes.entries()) {
      // A route that already handed output to the caller is never asked again elsewhere.
      let delivered = false;
      const onDelta = params.onDelta ? (delta: Parameters<NonNullable<ChatRequest['onDelta']>>[0]) => { delivered = true; params.onDelta!(delta); } : undefined;
      const attempt: ChatRequest = { ...params, ...(onDelta ? { onDelta } : {}) };
      try {
        const response = route === 'subscription'
          ? (await instrumentedLlmCall(() => this.subscription!.chat(attempt), { provider: this.name, model: params.model ?? '' })).result
          : await this.chatWithApiKey(attempt);
        this.lastAnswered = route;
        this.answeredBy.set(normalizeOpenAIModelId(params.model), route);
        return {
          ...response,
          signInRoute: { route, label: OPENAI_SIGN_IN_ROUTE_LABELS[route], ...(movedFrom ? { movedFrom } : {}) },
        };
      } catch (error) {
        if (error instanceof ProviderAttemptDeniedError || params.signal?.aborted) throw error;
        if (refusedModel(error)) {
          if (route === 'subscription') this.subscriptionRefused.add(normalizeOpenAIModelId(params.model));
          // The lists may be behind the provider: read them again, off this request's path.
          this.onUnknownModel?.();
        }
        const next = routes[index + 1];
        if (next === undefined || delivered || !routeFailure(error)) {
          // Every sign-in failed: the error says so, not only the last one's words.
          if (movedFrom && error instanceof ProviderError) {
            throw new ProviderError(`${error.message} (through the ${OPENAI_SIGN_IN_ROUTE_LABELS[route]}, after the ${movedFrom.label} failed: ${movedFrom.reason})`, {
              ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
              ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
              ...(error.category !== 'contract' ? { category: error.category } : {}),
              provider: this.name,
              operation: 'chat',
              ...(error.phase !== undefined ? { phase: error.phase } : {}),
              cause: error,
            });
          }
          throw error;
        }
        movedFrom = { route, label: OPENAI_SIGN_IN_ROUTE_LABELS[route], reason: signInFailureReason(error) };
        logger.info('[openai] sign-in route failed; asking the same model through the next sign-in', {
          model: params.model, from: route, to: next, reason: summarizeError(error),
        });
      }
    }
    // Unreachable: the loop returns or throws on its last route.
    throw new ProviderError('OpenAI request was not sent.', { provider: this.name, operation: 'chat', phase: 'request' });
  }

  private async chatWithApiKey(params: ChatRequest): Promise<ChatResponse> {
    const { messages, tools, model, maxTokens, signal, systemPrompt, onRetry } = params;
    const { onDelta, canRetry } = trackDeliveredOutput(params.onDelta);
    // `reasoning_effort` is a documented top-level parameter of
    // POST /v1/chat/completions (openai@6.46.0 types it as
    // 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'), so the
    // endpoint this adapter already uses can carry the setting. It is resolved
    // against the model's own options first, because OpenAI rejects a level the
    // model does not support rather than coercing it.
    // A `fallback`-sourced spec means neither the live catalog nor the curated
    // family table recognises this model, so there is no evidence it reasons at
    // all. OpenAI serves plenty of non-reasoning models on this same endpoint
    // and rejects `reasoning_effort` on them, so silence beats a guess here.
    const resolvedEffort = resolveEffortForRequest(params.reasoningEffort, {
      provider: this.name, modelId: model,
      ...(params.reasoningEffortSpec ? { spec: params.reasoningEffortSpec } : {}),
    });
    const reasoningEffort = resolvedEffort.spec.source === 'fallback'
      ? undefined
      : resolvedEffort.value;

    return (await instrumentedLlmCall(() => withRetry(async () => {
      let responseText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let rawStopReason: string | undefined;
      let stopReason: ChatStopReason = 'unknown';
      let rawToolCalls: OpenAIToolCall[] = [];
      let rateLimit: ChatResponse['rateLimit'];
      let streamOpened = false;

      const openaiMessages = toOpenAIMessages(messages, systemPrompt);
      const openaiTools = tools && tools.length > 0 ? toOpenAITools(tools) : undefined;

      try {
        // Resolving the client inside the try means an absent `openai` package
        // arrives at the caller as this provider's ordinary chat error, naming
        // the package, rather than as a boot failure.
        const client = await this.client();
        if (params.beforeAttempt) await revalidateProviderAttempt(params.beforeAttempt);
        // .withResponse() surfaces the raw HTTP Response so rate-limit headers
        // are readable on the SUCCESS path (not only 429s).
        const created = await client.chat.completions.create(
          {
            model,
            messages: openaiMessages as Parameters<OpenAIChatCreate>[0]['messages'],
            ...(openaiTools ? { tools: openaiTools as Parameters<OpenAIChatCreate>[0]['tools'] } : {}),
            ...(openaiTools && params.toolChoice === 'none' ? { tool_choice: 'none' as const } : {}),
            // Chat completions takes max_completion_tokens from every current model; the GPT-5 and o-series models refuse max_tokens.
            ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            stream: true,
            stream_options: { include_usage: true },
          } as Parameters<OpenAIChatCreate>[0],
          // withRetry is the one retry owner; the SDK's own retries would multiply the requests it reports.
          { ...(signal !== undefined ? { signal } : {}), maxRetries: 0 },
        ).withResponse() as unknown as {
          data: AsyncIterable<import('openai/resources/chat/completions.js').ChatCompletionChunk> & { controller: AbortController };
          response: Response;
        };
        streamOpened = true;
        const stream = created.data;
        rateLimit = parseRateLimitHeaders(created.response.headers) ?? undefined;

        const accToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          const textDelta = extractOpenAIStreamTextDelta(chunk);
          for (const contentDelta of textDelta.content) {
            responseText += contentDelta;
            if (onDelta) onDelta({ content: contentDelta });
          }
          for (const reasoningDelta of textDelta.reasoning) {
            if (onDelta) onDelta({ reasoning: reasoningDelta });
          }

          // Accumulate streaming tool_calls deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              accumOpenAIToolCall(accToolCalls, tc, onDelta);
            }
          }

          const finishReason = chunk.choices[0]?.finish_reason;
          if (finishReason) {
            rawStopReason = finishReason;
            stopReason = mapOpenAIStopReason(finishReason);
          }

          ({ inputTokens, outputTokens, cacheReadTokens } = applyOpenAIChunkUsage(
            (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage,
            { inputTokens, outputTokens, cacheReadTokens },
          ));
        }

        rawToolCalls = finalizeOpenAIToolCalls(accToolCalls);
      } catch (err: unknown) {
        if (err instanceof ProviderAttemptDeniedError) throw err;
        const { hasStatus } = await import('../utils/retry.js');
        const status = hasStatus(err) ? err.status : undefined;
        const retryAfterMs = openAiRetryAfterMs(err);
        throw toProviderError(err, {
          ...(status !== undefined ? { statusCode: status } : {}),
          ...(status === 429 && isOpenAiSpentQuota(err) ? { category: 'billing' as const } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          provider: this.name,
          operation: 'chat',
          phase: streamOpened ? 'stream' : 'request',
        });
      }

      // OpenAI always closes a completion with a finish_reason; a stream that
      // ends without one was cut, and its text is a truncated answer.
      if (rawStopReason === undefined) {
        throw new ProviderError('OpenAI stream ended without a finish reason; the answer may be truncated.', {
          statusCode: 502,
          provider: this.name,
          operation: 'chat',
          phase: 'stream',
        });
      }

      // Some models may emit tool calls as raw text tokens instead of the
      // OpenAI function-calling wire format. Fall back to text extraction.
      const resolved = resolveOpenAIToolCallsAndFallback(rawToolCalls, responseText, stopReason, rawStopReason);
      const toolCalls = resolved.toolCalls;
      responseText = resolved.responseText;
      stopReason = resolved.stopReason;
      rawStopReason = resolved.rawStopReason;

      this.cacheHitTracker.recordTurn({
        inputTokens,
        cacheReadTokens,
      });

      return {
        content: responseText,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        },
        stopReason,
        ...withProviderStopReason(rawStopReason),
        ...(rateLimit ? { rateLimit } : {}),
      };
    }, { ...(signal ? { signal } : {}), ...(params.beforeAttempt ? { beforeAttempt: params.beforeAttempt } : {}), ...(params.maxRetries !== undefined ? { maxRetries: params.maxRetries } : {}), canRetry }, onRetry), { provider: this.name, model })).result;
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    let response;
    try {
      response = await (await this.client()).embeddings.create(
        {
          model: request.model ?? this.embeddingModel,
          input: request.text,
          ...(request.dimensions ? { dimensions: request.dimensions } : {}),
        },
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (error: unknown) {
      throw toProviderError(error, {
        provider: this.name,
        operation: 'embed',
        phase: 'request',
      });
    }
    const embedding = response.data[0]?.embedding ?? [];
    return {
      vector: Float32Array.from(embedding),
      dimensions: embedding.length,
      modelId: response.model,
      metadata: {
        usage: request.usage,
        provider: this.name,
      },
    };
  }

  /** Signed in either way: a subscription or an API key. */
  isConfigured(): boolean {
    return this.apiKeyConfigured() || this.subscriptionConfigured();
  }

  /** Where the provider's own list came from and when it was read (status surfaces). */
  modelListing(): { readonly source: 'live' | 'cache' | 'catalog'; readonly listedAt?: number | undefined } {
    return this.listing;
  }

  /**
   * Read OpenAI's model lists again: the API's (with an API key) and the
   * subscription's (when signed in), side by side. Run in the background at
   * start-up (an on-disk list younger than a day answers without a request),
   * after a sign-in (the subscription's list is stored per account, so a new
   * account reads its own), on an explicit refresh and on a picker open
   * (`force`), and when an endpoint refuses a model as unknown. Never on a
   * request's path. A sign-in whose endpoint does not answer keeps its last
   * list on disk; with none, the pinned catalog's OpenAI rows stand.
   */
  async refreshModels(force = false, options: ProviderModelRefreshOptions = {}): Promise<LiveModelDiscoveryResult> {
    const subscriptionToken = this.subscription?.storedAccessToken() ?? null;
    const [api, plan] = await Promise.all([
      runLiveModelRefresh({
        providerName: this.name,
        recordTo: options.recordTo,
        borrowFrom: options.borrowFrom,
        cachePath: this.modelsCachePath,
        isConfigured: this.apiKeyConfigured(),
        fetchLive: () => fetchOpenAIModelIds(this.apiKey),
        force,
      }),
      this.subscription ? runLiveModelRefresh({
        providerName: `${this.name}@subscription`,
        recordTo: options.recordTo,
        borrowFrom: options.borrowFrom,
        cachePath: this.modelsCachePath?.replace(/\.json$/, '.subscription.json'),
        cacheKey: subscriptionToken ? subscriptionAccountKey(subscriptionToken) ?? undefined : undefined,
        isConfigured: subscriptionToken !== null,
        fetchLive: async () => {
          const accessToken = await this.subscription!.freshAccessToken();
          if (accessToken === null) throw new Error('the subscription sign-in has ended');
          return fetchOpenAISubscriptionModelIds(accessToken);
        },
        force,
      }) : Promise.resolve(null),
    ]);
    const previous = this._models;
    const models = [...new Set([...api.models, ...(plan?.models ?? [])])];
    this._models = models;
    this.subscriptionModels = plan && plan.source !== 'catalog' && plan.models.length > 0 ? new Set(plan.models) : null;
    const sources = [api.source, plan?.source].filter((source): source is 'live' | 'cache' | 'catalog' => source !== undefined);
    const source = sources.includes('live') ? 'live' : sources.includes('cache') ? 'cache' : 'catalog';
    const listedAt = Math.max(api.listedAt ?? 0, plan?.listedAt ?? 0) || undefined;
    this.listing = { source, ...(listedAt ? { listedAt } : {}) };
    const errors = [api.error ? `API key: ${api.error}` : '', plan?.error ? `subscription: ${plan.error}` : ''].filter(Boolean);
    const { added, removed } = diffModelIds(previous, models);
    return {
      models,
      source,
      added: previous.length === 0 ? [...api.added, ...(plan?.added ?? [])] : added,
      removed: previous.length === 0 ? [...api.removed, ...(plan?.removed ?? [])] : removed,
      ...(listedAt ? { listedAt } : {}),
      ...(errors.length ? { error: errors.join('; ') } : {}),
      ...(api.unclassifiedModels?.length ? { unclassifiedModels: api.unclassifiedModels } : {}),
      ...(api.skippedReason ? { skippedReason: api.skippedReason } : {}),
    };
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes, summarizeProviderAuth } = await import('./runtime-metadata.js');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: 'openai',
      apiKeyEnvVars: ['OPENAI_API_KEY', 'OPENAI_KEY'],
      serviceNames: ['openai'],
      subscriptionProviderId: 'openai',
    }, deps);
    const order = this.signInRoutes();
    const configured = order.length > 0;
    const auth = summarizeProviderAuth({
      configured,
      detail: configured
        ? `Requests use the ${order.map((route) => OPENAI_SIGN_IN_ROUTE_LABELS[route]).join(', then the ')}${order.length > 1 ? ' when the first fails' : ''}.`
        : 'Not signed in: sign in with a ChatGPT subscription (/provider sign-in openai) or set OPENAI_API_KEY.',
    }, authRoutes);
    const active = this.activeSignInRoute();
    return {
      auth: {
        mode: this.subscriptionConfigured() ? 'oauth' : 'api-key',
        configured: auth.configured,
        detail: auth.detail,
        envVars: ['OPENAI_API_KEY', 'OPENAI_KEY'],
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
        batch: {
          supported: true,
          discount: 'Provider-side Batch API pricing is discounted versus live API pricing where OpenAI offers the discount.',
          completionWindow: '24h',
          endpoints: ['/v1/chat/completions'],
          maxRequestsPerProviderBatch: 50_000,
          maxInputBytes: 200 * 1024 * 1024,
          notes: ['Batch requests are asynchronous and non-streaming. Results are correlated by custom_id.'],
        },
        notes: ['Embeddings use the OpenAI embeddings API.'],
      },
      policy: {
        local: false,
        streamProtocol: active === 'subscription' ? 'openai-codex-responses-sse' : 'openai-chat-completions',
        reasoningMode: active === 'subscription' ? 'responses-reasoning' : 'reasoning_effort',
        ...(active === 'subscription' ? { supportedReasoningEfforts: reasoningEffortLevels(resolveReasoningEffortSpec({ provider: this.name, modelId: this.models[0] ?? '' })) } : {}),
        cacheStrategy: active === 'subscription' ? 'subscription-session-cache-key' : 'implicit-openai-cache-observation',
        notes: [
          `Sign-in order: ${order.length ? order.map((route) => OPENAI_SIGN_IN_ROUTE_LABELS[route]).join(' → ') : 'none set up'}.`,
          `Model list: ${this.listing.source === 'catalog' ? 'pinned model catalog (the provider has not listed its models yet)' : `${this.listing.source === 'live' ? 'read from OpenAI' : 'OpenAI\'s last listing on disk'}${this.listing.listedAt ? `, ${new Date(this.listing.listedAt).toISOString()}` : ''}`}.`,
          'OpenAI embedding usage is subject to OpenAI API terms.',
        ],
      },
    };
  }

  private async createChatBatch(input: ProviderBatchCreateInput): Promise<ProviderBatchCreateResult> {
    const lines = input.requests.map((request) => JSON.stringify({
      custom_id: request.customId,
      method: 'POST',
      url: '/v1/chat/completions',
      body: this.toOpenAIBatchChatBody(request.params),
    })).join('\n') + '\n';
    const file = await (await this.client()).files.create({
      file: await openAIToFile(new Blob([lines], { type: 'application/jsonl' }), 'goodvibes-openai-chat-batch.jsonl'),
      purpose: 'batch',
    });
    const metadata = input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined;
    const batch = await (await this.client()).batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: input.completionWindow ?? '24h',
      ...(metadata ? { metadata } : {}),
    });
    return {
      providerBatchId: batch.id,
      status: this.mapOpenAIBatchStatus(batch.status),
      raw: batch,
    };
  }

  private async retrieveBatch(providerBatchId: string): Promise<ProviderBatchPollResult> {
    const batch = await (await this.client()).batches.retrieve(providerBatchId);
    return {
      providerBatchId: batch.id,
      status: this.mapOpenAIBatchStatus(batch.status),
      resultAvailable: typeof batch.output_file_id === 'string' || typeof batch.error_file_id === 'string',
      raw: batch,
    };
  }

  private async cancelBatch(providerBatchId: string): Promise<ProviderBatchPollResult> {
    const batch = await (await this.client()).batches.cancel(providerBatchId);
    return {
      providerBatchId: batch.id,
      status: this.mapOpenAIBatchStatus(batch.status),
      resultAvailable: typeof batch.output_file_id === 'string' || typeof batch.error_file_id === 'string',
      raw: batch,
    };
  }

  private async findBatchByMetadata(key: string, value: string, createdAfterMs: number): Promise<ProviderBatchPollResult | null> {
    // The list is newest first; a minute of slack covers clock skew between this host and the API.
    const floorSeconds = Math.floor(createdAfterMs / 1000) - 60;
    for await (const batch of (await this.client()).batches.list({ limit: 100 })) {
      if (batch.metadata?.[key] === value) {
        return {
          providerBatchId: batch.id,
          status: this.mapOpenAIBatchStatus(batch.status),
          resultAvailable: typeof batch.output_file_id === 'string' || typeof batch.error_file_id === 'string',
          raw: batch,
        };
      }
      if (batch.created_at < floorSeconds) break;
    }
    return null;
  }

  private async getBatchResults(providerBatchId: string): Promise<readonly ProviderBatchResult[]> {
    const batch = await (await this.client()).batches.retrieve(providerBatchId);
    const results: ProviderBatchResult[] = [];
    if (typeof batch.output_file_id === 'string' && batch.output_file_id.length > 0) {
      results.push(...await this.readOpenAIBatchResultFile(batch.output_file_id, false));
    }
    if (typeof batch.error_file_id === 'string' && batch.error_file_id.length > 0) {
      results.push(...await this.readOpenAIBatchResultFile(batch.error_file_id, true));
    }
    return results;
  }

  private toOpenAIBatchChatBody(params: Omit<ChatRequest, 'signal' | 'onDelta'>): Record<string, unknown> {
    const openaiMessages = toOpenAIMessages(params.messages, params.systemPrompt);
    const openaiTools = params.tools && params.tools.length > 0 ? toOpenAITools(params.tools) : undefined;
    return {
      model: params.model,
      messages: openaiMessages,
      ...(openaiTools ? { tools: openaiTools } : {}),
      ...(params.maxTokens ? { max_completion_tokens: params.maxTokens } : {}),
      stream: false,
    };
  }

  private mapOpenAIBatchStatus(status: string): ProviderBatchPollResult['status'] {
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'expired') return 'expired';
    // Still running while cancelling: requests that finished before the cancel are
    // written to the output file once it ends, so a poller must not stop here.
    if (status === 'in_progress' || status === 'finalizing' || status === 'cancelling') return 'running';
    return 'submitted';
  }

  private async readOpenAIBatchResultFile(fileId: string, forceFailed: boolean): Promise<ProviderBatchResult[]> {
    const response = await (await this.client()).files.content(fileId);
    const text = await response.text();
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const results: ProviderBatchResult[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        results.push(this.parseOpenAIBatchResult(parsed, forceFailed));
      } catch (error: unknown) {
        results.push({
          customId: `unparseable:${crypto.randomUUID()}`,
          status: 'failed',
          error: {
            message: `Unable to parse OpenAI batch result line: ${summarizeError(error)}`,
          },
          raw: line,
        });
      }
    }
    return results;
  }

  private parseOpenAIBatchResult(parsed: Record<string, unknown>, forceFailed: boolean): ProviderBatchResult {
    const customId = typeof parsed['custom_id'] === 'string' ? parsed['custom_id'] : `unknown:${crypto.randomUUID()}`;
    const response = toRecord(parsed['response']);
    const statusCode = typeof response['status_code'] === 'number' ? response['status_code'] : 0;
    const body = toRecord(response['body']);
    const error = parsed['error'] ?? body['error'];
    if (forceFailed || statusCode >= 400 || error !== undefined) {
      const errorRecord = toRecord(error);
      return {
        customId,
        status: 'failed',
        error: {
          message: typeof errorRecord['message'] === 'string' ? errorRecord['message'] : `OpenAI batch request failed${statusCode ? ` with status ${statusCode}` : ''}`,
          ...(typeof errorRecord['code'] === 'string' ? { code: errorRecord['code'] } : {}),
          raw: error ?? parsed,
        },
        raw: parsed,
      };
    }
    return {
      customId,
      status: 'succeeded',
      response: this.openAIBatchBodyToChatResponse(body),
      raw: parsed,
    };
  }

  private openAIBatchBodyToChatResponse(body: Record<string, unknown>): ChatResponse {
    const choices = Array.isArray(body['choices']) ? body['choices'] : [];
    const firstChoice = toRecord(choices[0]);
    const message = toRecord(firstChoice['message']);
    const content = message['content'];
    const responseText = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => {
            const record = toRecord(part);
            return typeof record['text'] === 'string' ? record['text'] : '';
          }).join('')
        : '';
    const rawToolCalls = Array.isArray(message['tool_calls'])
      ? message['tool_calls'].map((entry) => toRecord(entry) as unknown as OpenAIToolCall)
      : [];
    const usage = toRecord(body['usage']);
    const promptDetails = toRecord(usage['prompt_tokens_details']);
    const rawFinishReason = typeof firstChoice['finish_reason'] === 'string' ? firstChoice['finish_reason'] : undefined;
    const stopReason = rawFinishReason ? mapOpenAIStopReason(rawFinishReason) : (responseText ? 'completed' : 'unknown');
    return {
      content: responseText,
      toolCalls: rawToolCalls.length > 0 ? fromOpenAIToolCalls(rawToolCalls) : [],
      usage: {
        inputTokens: typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0,
        outputTokens: typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0,
        ...(typeof promptDetails['cached_tokens'] === 'number' && promptDetails['cached_tokens'] > 0
          ? { cacheReadTokens: promptDetails['cached_tokens'] }
          : {}),
      },
      stopReason,
      ...(rawFinishReason ? { providerStopReason: rawFinishReason } : {}),
    };
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** The id OpenAI's endpoints take: a provider-qualified reference loses its prefix. */
function normalizeOpenAIModelId(model: string): string {
  if (model.startsWith('openai:')) return model.slice('openai:'.length);
  if (model.startsWith('openai/')) return model.slice('openai/'.length);
  return model;
}
