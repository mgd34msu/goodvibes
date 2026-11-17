import { documentedMaxOutput } from './anthropic-output-caps.js';
import { revalidateProviderAttempt } from './attempt-guard.js';
import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import type {
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  LLMProvider,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.js';
import { applyAnthropicReasoning } from './anthropic-stream.js';
import type { AnthropicContentBlock } from './tool-formats.js';
import { mapAnthropicStopReason } from './stop-reason-maps.js';
import {
  normalizeAnthropicModel,
  toAnthropicMessages,
  toAnthropicTools,
} from './tool-formats.js';
import { assembleAnthropicContentBlocks, oneHourCacheWriteTokens, withOneHourCacheWrites } from './anthropic-sse-assembler.js';
import { resolveCompletedStopReason, withProviderStopReason } from './provider-stop-reason.js';
import { ProviderError } from '../types/errors.js';
import { withRetry } from '../utils/retry.js';
import { trackDeliveredOutput } from './stream-delivery.js';
import { buildStandardProviderAuthRoutes, summarizeProviderAuth } from './runtime-metadata.js';
import { toProviderError } from '../utils/error-display.js';
import { parseRateLimitHeaders } from './rate-limit-headers.js';


type AnthropicStreamCapableClient = {
  messages: {
    stream: unknown;
  };
};

type AnthropicMessageStream = AsyncIterable<MessageStreamEvent> & {
  finalMessage(): Promise<{
    content: unknown;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number | null | undefined;
      cache_creation_input_tokens?: number | null | undefined;
      cache_creation?: unknown;
    };
  }>;
  /**
   * The raw HTTP `Response`, populated once the stream connects (well before
   * `finalMessage()` resolves, the SDK's `_connected(response)` fires as soon
   * as headers arrive). Verified against the installed
   * `@anthropic-ai/sdk` `lib/MessageStream.d.ts`: `get response(): Response |
   * null | undefined`. Both AmazonBedrockProvider (`@anthropic-ai/bedrock-sdk`,
   * whose `messages` resource is literally `@anthropic-ai/sdk`'s `Resources.
   * Messages` re-exported, see its `client.d.ts`) and AnthropicVertexProvider
   * (`AnthropicVertexClient extends BaseAnthropic` from the same SDK, using the
   * same `Resources.Messages`) return this exact class from `.stream()`, so one
   * read site here covers both.
   */
  readonly response?: Response | null | undefined;
};

export interface AnthropicMessagesProviderAuthConfig {
  readonly mode: 'api-key' | 'anonymous';
  readonly configured: boolean;
  readonly detail: string;
  readonly envVars?: readonly string[] | undefined;
  readonly secretKeys?: readonly string[] | undefined;
  readonly serviceNames?: readonly string[] | undefined;
  readonly allowAnonymous?: boolean | undefined;
  readonly anonymousConfigured?: boolean | undefined;
  readonly anonymousDetail?: string | undefined;
}

export interface AnthropicMessagesProviderOptions {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
  /**
   * Build the vendor client for one request.
   *
   * A promise is allowed because both Bedrock providers and the Vertex
   * provider now resolve their vendor package (`@anthropic-ai/bedrock-sdk`,
   * `@anthropic-ai/sdk`) through a dynamic import at this point rather than a
   * static import at module init, see utils/optional-dependency.ts. The one
   * caller below already runs inside an async retry body, so awaiting here
   * changes no public signature, and a sync factory (every test double, for
   * instance) still satisfies the type unchanged.
   */
  readonly createClient: () => AnthropicStreamCapableClient | Promise<AnthropicStreamCapableClient>;
  /**
   * How the provider authenticates. A function is read on every
   * `describeRuntime` call, for providers whose credentials come from the live
   * environment: a value frozen at construction would keep reporting the
   * credentials that existed at boot after they are set or removed.
   */
  readonly auth: AnthropicMessagesProviderAuthConfig | (() => AnthropicMessagesProviderAuthConfig);
  readonly streamProtocol: string;
  readonly notes?: readonly string[] | undefined;
}

export class AnthropicMessagesProvider implements LLMProvider {
  readonly name: string;
  readonly adapterKind = 'anthropic-sdk' as const;
  readonly credentialAuthority = 'resolver' as const;
  readonly models: string[];

  constructor(private readonly options: AnthropicMessagesProviderOptions) {
    this.name = options.name;
    this.models = [...options.models];
  }

  /** The configured default when the current list has it, otherwise the list's first model. */
  get defaultModel(): string {
    return this.models.includes(this.options.defaultModel) ? this.options.defaultModel : (this.models[0] ?? this.options.defaultModel);
  }

  /** The id sent on the wire for a model the list shows; a provider whose ids differ maps it here. */
  protected wireModelId(model: string): string {
    return model;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const { onDelta, canRetry } = trackDeliveredOutput(params.onDelta);
    return withRetry(async () => {
      const resolvedModel = normalizeAnthropicModel(params.model ?? this.defaultModel);
      const body: Record<string, unknown> = {
        model: this.wireModelId(resolvedModel),
        max_tokens: params.maxTokens ?? documentedMaxOutput(resolvedModel),
        messages: toAnthropicMessages(params.messages),
        stream: true,
      };

      if (params.systemPrompt) {
        body['system'] = params.systemPrompt;
      }

      if (params.tools && params.tools.length > 0) {
        body['tools'] = toAnthropicTools(params.tools);
      }

      applyAnthropicReasoning(
        body,
        { provider: this.name, model: params.model, reasoningEffort: params.reasoningEffort, ...(params.reasoningEffortSpec ? { reasoningEffortSpec: params.reasoningEffortSpec } : {}) },
        Infinity,
      );

      const toolBlocks = new Map<number, { id: string; name: string; args: string }>();
      let responseText = '';
      let rawStopReason: string | undefined;
      let stopReason: ChatStopReason = 'unknown';

      if (params.beforeAttempt) await revalidateProviderAttempt(params.beforeAttempt);
      // Built only once nothing before the request can still refuse it: a client
      // starts its credential lookup on construction, so one built ahead of a
      // denied attempt would leave that lookup running with nobody awaiting it.
      const client = await this.options.createClient();
      // Client setup can be asynchronous (a credential lookup), so the guard is
      // asked again immediately before the request goes out.
      if (params.beforeAttempt) await revalidateProviderAttempt(params.beforeAttempt);
      try {
        const streamFactory = client.messages.stream as (
          body: Record<string, unknown>,
          options?: { signal?: AbortSignal; maxRetries?: number },
        ) => AnthropicMessageStream;
        // withRetry is the one retry owner; the SDK's own retries would multiply the requests it reports.
        const stream = streamFactory.call(client.messages, body, { ...(params.signal ? { signal: params.signal } : {}), maxRetries: 0 });
        for await (const event of stream as AsyncIterable<MessageStreamEvent>) {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            const idx = event.index ?? 0;
            toolBlocks.set(idx, {
              id: event.content_block.id ?? '',
              name: event.content_block.name ?? '',
              args: '',
            });
            onDelta?.({
              toolCalls: [{ index: idx, id: event.content_block.id, name: event.content_block.name }],
            });
          } else if (event.type === 'content_block_delta') {
            const idx = event.index ?? 0;
            if (event.delta.type === 'text_delta' && event.delta.text) {
              responseText += event.delta.text;
              onDelta?.({ content: event.delta.text });
            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              onDelta?.({ reasoning: event.delta.thinking });
            } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
              const block = toolBlocks.get(idx);
              if (block) block.args += event.delta.partial_json;
              onDelta?.({
                toolCalls: [{ index: idx, arguments: event.delta.partial_json }],
              });
            }
          } else if (event.type === 'message_delta') {
            if (event.delta.stop_reason) {
              rawStopReason = event.delta.stop_reason;
              stopReason = mapAnthropicStopReason(rawStopReason);
            }
          }
        }

        const finalMessage = await stream.finalMessage();
        const parsed = assembleAnthropicContentBlocks(
          toolBlocks,
          responseText,
          this.name,
          finalMessage.content as AnthropicContentBlock[],
        );
        // By the time finalMessage() resolves, the stream has long since
        // connected, so `.response` is populated whenever the transport gave the
        // SDK a Response object at all (a Bedrock/Vertex proxy that returns
        // something other than a genuine Response would leave it absent).
        const rateLimit = stream.response ? (parseRateLimitHeaders(stream.response.headers) ?? undefined) : undefined;

        return {
          content: parsed.text,
          toolCalls: parsed.toolCalls,
          usage: {
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
            ...(finalMessage.usage.cache_read_input_tokens != null ? { cacheReadTokens: finalMessage.usage.cache_read_input_tokens } : {}),
            ...(finalMessage.usage.cache_creation_input_tokens != null ? { cacheWriteTokens: finalMessage.usage.cache_creation_input_tokens } : {}),
            ...withOneHourCacheWrites(oneHourCacheWriteTokens(finalMessage.usage)),
          },
          stopReason: resolveCompletedStopReason(stopReason, parsed.text),
          ...withProviderStopReason(rawStopReason),
          ...(rateLimit ? { rateLimit } : {}),
        };
      } catch (error) {
        throw toProviderError(error, {
          provider: this.name,
          operation: 'chat',
          phase: 'stream',
        });
      }
    }, { ...(params.signal ? { signal: params.signal } : {}), ...(params.beforeAttempt ? { beforeAttempt: params.beforeAttempt } : {}), canRetry }, params.onRetry);
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const config = typeof this.options.auth === 'function' ? this.options.auth() : this.options.auth;
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.options.name,
      apiKeyEnvVars: config.envVars,
      secretKeys: config.secretKeys,
      serviceNames: config.serviceNames,
      allowAnonymous: config.allowAnonymous,
      anonymousConfigured: config.anonymousConfigured,
      anonymousDetail: config.anonymousDetail,
    }, deps);
    const auth = summarizeProviderAuth({
      configured: config.configured,
      detail: config.detail,
    }, authRoutes);
    return {
      auth: {
        mode: config.mode,
        configured: auth.configured,
        detail: auth.detail,
        ...(config.envVars ? { envVars: config.envVars } : {}),
        routes: authRoutes,
      },
      models: {
        defaultModel: this.defaultModel,
        models: this.models,
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        // No cache_control blocks are sent on this path, so it does not claim caching.
        promptCaching: false,
        ...(this.options.notes ? { notes: this.options.notes } : {}),
      },
      policy: {
        local: false,
        streamProtocol: this.options.streamProtocol,
        // Per model, not per provider: current generations take
        // output_config.effort, Claude 4.5 and earlier take a thinking budget,
        // and the levels each accepts come from the resolved spec.
        reasoningMode: 'per-model-effort-or-thinking-budget',
      },
    };
  }
}
