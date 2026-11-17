import { randomUUID } from 'node:crypto';
import { ProviderAttemptDeniedError, revalidateProviderAttempt } from './attempt-guard.js';
import { withRetry } from '../utils/retry.js';
import { trackDeliveredOutput } from './stream-delivery.js';
import { instrumentedLlmCall } from '../runtime/llm-observability.js';
import { ProviderError } from '../types/errors.js';
import type { ToolCall, ToolDefinition } from '../types/tools.js';
import type { ProviderCapability } from './capabilities.js';
import type {
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ContentPart,
  LLMProvider,
  PartialToolCall,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderMessage,
  ProviderModelSource,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.js';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai-compat.js';
import { LOCAL_SERVER_EFFORT } from './discovered-traits.js';
import { reasoningEffortLevels } from './reasoning-effort.js';
import { toOpenAITools } from './tool-formats.js';
import { isOtherApiFailure, normalizeProviderError } from './provider-error.js';
import { OLLAMA_DONE_REASON_MAP } from './stop-reason-maps.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';

type NativeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type OllamaChatChunk = {
  message?: {
    role?: string | undefined;
    content?: string | undefined;
    thinking?: string | undefined;
    tool_calls?: Array<{
      function?: {
        name?: string | undefined;
        description?: string | undefined;
        arguments?: Record<string, unknown> | undefined;
      };
    }>;
  };
  done?: boolean | undefined;
  error?: unknown;
  done_reason?: string | undefined;
  prompt_eval_count?: number | undefined;
  eval_count?: number | undefined;
};

export interface OllamaProviderOptions extends OpenAICompatOptions {
  nativeFetch?: NativeFetch | undefined;
  compatProvider?: LLMProvider | undefined;
}

export class OllamaProvider implements LLMProvider {
  readonly name: string;
  readonly credentialAuthority = 'anonymous' as const;
  /** The model list is the server's own answer to discovery or its configuration. */
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };
  readonly models: string[];
  readonly capabilities?: Partial<ProviderCapability> | undefined;

  private readonly baseURL: string;
  private readonly defaultModel: string;
  private readonly nativeChatUrl: string;
  private readonly nativeEmbedUrl: string;
  private readonly nativeFetch: NativeFetch;
  private readonly nativeHeaders: Record<string, string>;
  private readonly compatProvider: LLMProvider;
  private readonly embeddingModel = 'embeddinggemma';

  constructor(opts: OllamaProviderOptions) {
    this.nativeHeaders = { ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}), ...opts.defaultHeaders };
    this.name = opts.name;
    this.models = opts.models;
    this.capabilities = opts.capabilities;
    this.baseURL = opts.baseURL;
    this.defaultModel = opts.defaultModel;
    this.nativeChatUrl = deriveOllamaChatUrl(opts.baseURL);
    this.nativeEmbedUrl = deriveOllamaEmbedUrl(opts.baseURL);
    this.nativeFetch = opts.nativeFetch ?? instrumentedFetch;
    this.compatProvider = opts.compatProvider ?? new OpenAICompatProvider(opts);
  }

  isConfigured(): boolean {
    return this.compatProvider.isConfigured?.() ?? true;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const model = params.model || this.defaultModel;

    if (canUseNativeOllamaChat(params.messages)) {
      // A retry after text reached the caller would deliver the answer twice.
      const { onDelta, canRetry } = trackDeliveredOutput(params.onDelta);
      const nativeParams: ChatRequest = onDelta ? { ...params, onDelta } : params;
      // Only the native attempt is retried and recorded here. The compat
      // provider retries and records its own call, so running it inside this
      // wrapper would multiply the attempts and count one logical call twice.
      const native = (await instrumentedLlmCall(
        () => withRetry(async (): Promise<ChatResponse | null> => {
          try {
            return await this.chatViaNativeOllama(nativeParams, model);
          } catch (err: unknown) {
            if (err instanceof ProviderAttemptDeniedError) throw err;
            // Once the stream has produced output the other API would answer from the start again.
            if (err instanceof ProviderError && err.phase === 'stream') throw err;
            // Only a missing endpoint sends the request to the other API; any other failure is the provider's own answer.
            if (!isOtherApiFailure(err)) {
              throw normalizeProviderError(err, this.name, 'chat', 'request');
            }
            return null;
          }
        }, { ...(params.signal ? { signal: params.signal } : {}), ...(params.beforeAttempt ? { beforeAttempt: params.beforeAttempt } : {}), ...(params.maxRetries !== undefined ? { maxRetries: params.maxRetries } : {}), canRetry }, params.onRetry),
        // A null result hands the request to the compat provider, which records it.
        { provider: this.name, model, isHandover: (result) => result === null },
      )).result;
      if (native) return native;
    }

    return this.compatProvider.chat(params);
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    try {
      const response = await this.nativeFetch(this.nativeEmbedUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...this.nativeHeaders,
        },
        body: JSON.stringify({
          model: request.model ?? this.embeddingModel,
          input: request.text,
          ...(request.dimensions ? { dimensions: request.dimensions } : {}),
        }),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      } as RequestInit);

      if (!response.ok) {
        throw await buildHttpError('Ollama native embeddings', response, this.name, 'embed', 'request');
      }

      const body = await response.json() as { embeddings?: number[][]; embedding?: number[]; model?: string };
      const vector = body.embedding ?? body.embeddings?.[0] ?? [];
      return {
        vector: Float32Array.from(vector),
        dimensions: vector.length,
        modelId: body.model ?? request.model ?? this.embeddingModel,
        metadata: {
          usage: request.usage,
          provider: this.name,
        },
      };
    } catch (err: unknown) {
      if (this.compatProvider.embed) {
        return this.compatProvider.embed(request);
      }
      throw normalizeProviderError(err, this.name, 'embed', 'request');
    }
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const local = !/^https?:\/\/ollama\.com\b/i.test(this.baseURL);
    const { buildStandardProviderAuthRoutes, summarizeProviderAuth } = await import('./runtime-metadata.js');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
      secretKeys: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
      serviceNames: ['ollama-cloud'],
      allowAnonymous: local,
      anonymousConfigured: local,
      anonymousDetail: 'Local Ollama endpoints can be used without an API key.',
    }, deps);
    const auth = summarizeProviderAuth({
      configured: local || Boolean(process.env.OLLAMA_API_KEY || process.env.OLLAMA_CLOUD_API_KEY),
      detail: local
        ? 'Local Ollama endpoint does not require an API key'
        : 'Ollama Cloud API key is required',
    }, authRoutes);
    return {
      auth: {
        mode: local ? 'anonymous' : 'api-key',
        configured: auth.configured,
        detail: auth.detail,
        envVars: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
        routes: authRoutes,
      },
      models: {
        models: this.models,
        embeddingModel: this.embeddingModel,
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: false,
        notes: ['Native Ollama embeddings prefer the /api/embed endpoint.'],
      },
      policy: {
        local,
        streamProtocol: 'ollama-ndjson',
        reasoningMode: 'native-think-toggle',
        supportedReasoningEfforts: reasoningEffortLevels(LOCAL_SERVER_EFFORT),
        cacheStrategy: 'provider-managed',
        notes: local ? ['Local-first embedding generation.'] : ['Remote Ollama Cloud usage is subject to service policy.'],
      },
    };
  }

  private async chatViaNativeOllama(
    params: ChatRequest,
    model: string,
  ): Promise<ChatResponse> {
    const messages = toOllamaMessages(params.messages, params.systemPrompt);
    const think = mapOllamaThinking(params.reasoningEffort);
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      ...(params.tools && params.tools.length > 0 ? { tools: toOpenAITools(params.tools) } : {}),
      ...(think !== undefined ? { think } : {}),
      ...(params.maxTokens ? { options: { num_predict: params.maxTokens } } : {}),
    };

    if (params.beforeAttempt) await revalidateProviderAttempt(params.beforeAttempt);
      let response: Response;
    try {
      response = await this.nativeFetch(this.nativeChatUrl, {
        method: 'POST',
        headers: {
          accept: 'application/x-ndjson, application/json',
          'content-type': 'application/json',
          ...this.nativeHeaders,
        },
        body: JSON.stringify(body),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      } as RequestInit);
    } catch (err: unknown) {
      throw normalizeProviderError(err, this.name, 'chat', 'request');
    }

    if (!response.ok) {
      throw await buildHttpError('Ollama native chat', response, this.name, 'chat', 'request');
    }
    if (!response.body) {
      throw new ProviderError('Ollama native chat returned no response body.', {
        statusCode: 502,
        provider: this.name,
        operation: 'chat',
        phase: 'response',
      });
    }

    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let doneReason = '';
    let sawDone = false;
    const finalToolCalls: ToolCall[] = [];
    // Ollama sends no call ids. One minted per response keeps every call of a
    // conversation distinct (results, receipts and history pair by id), where
    // numbering from zero would repeat in each response.
    const responseId = randomUUID().slice(0, 8);

    await consumeNDJSON(response.body, (chunk) => {
      if (chunk.error !== undefined && chunk.error !== null) {
        const detail = typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error);
        throw new ProviderError(`Ollama native chat failed mid-stream: ${detail}`, {
          statusCode: 502,
          provider: this.name,
          operation: 'chat',
          phase: 'stream',
        });
      }
      const message = chunk.message;
      const content = typeof message?.content === 'string' ? message.content : '';
      if (content) {
        responseText += content;
        params.onDelta?.({ content });
      }

      const thinking = typeof message?.thinking === 'string' ? message.thinking : '';
      if (thinking) {
        params.onDelta?.({ reasoning: thinking });
      }

      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        // Each chunk carries the calls it adds; ids continue from the calls
        // already seen so parallel calls streamed in separate chunks stay distinct.
        const normalized = normalizeOllamaToolCalls(message.tool_calls, finalToolCalls.length, responseId);
        normalized.forEach((call) => {
          const index = finalToolCalls.length;
          finalToolCalls.push(call);
          const argumentsText = JSON.stringify(call.arguments);
          const partial: PartialToolCall = {
            index,
            id: call.id,
            name: call.name,
            arguments: argumentsText,
          };
          params.onDelta?.({ toolCalls: [partial] });
        });
      }

      if (chunk.done) {
        sawDone = true;
        doneReason = typeof chunk.done_reason === 'string' ? chunk.done_reason : doneReason;
        inputTokens = typeof chunk.prompt_eval_count === 'number' ? chunk.prompt_eval_count : inputTokens;
        outputTokens = typeof chunk.eval_count === 'number' ? chunk.eval_count : outputTokens;
      }
    });

    if (!sawDone) {
      // A cut connection or an unloaded model ends the stream without the final
      // chunk; reporting that as a finished turn would hide a truncated answer.
      throw new ProviderError('Ollama native chat stream ended before the final chunk; the answer is incomplete.', {
        statusCode: 502,
        provider: this.name,
        operation: 'chat',
        phase: 'stream',
      });
    }

    // An unfamiliar done_reason is reported as unknown, never guessed.
    const stopReason: ChatStopReason = finalToolCalls.length > 0
      ? 'tool_call'
      : OLLAMA_DONE_REASON_MAP[doneReason] ?? (doneReason.trim() ? 'unknown' : 'completed');

    return {
      content: responseText,
      toolCalls: finalToolCalls,
      usage: {
        inputTokens,
        outputTokens,
      },
      stopReason,
      ...(doneReason ? { providerStopReason: doneReason } : {}),
    };
  }
}

function deriveOllamaChatUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  const origin = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
  return `${origin}/api/chat`;
}

function deriveOllamaEmbedUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  const origin = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
  return `${origin}/api/embed`;
}

function canUseNativeOllamaChat(messages: ProviderMessage[]): boolean {
  if (messages.length === 0) return false;
  return !messages.some((message) => (
    message.role === 'tool'
    || (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)
  ));
}

function toOllamaMessages(
  messages: ProviderMessage[],
  systemPrompt: string | undefined,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  if (systemPrompt?.trim()) {
    result.push({ role: 'system', content: systemPrompt.trim() });
  }

  for (const message of messages) {
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        result.push(contentPartsToOllamaMessage('user', message.content));
      } else {
        result.push({ role: 'user', content: message.content });
      }
      continue;
    }

    if (message.role === 'assistant') {
      result.push({ role: 'assistant', content: message.content });
      continue;
    }
  }

  return result;
}

function contentPartsToOllamaMessage(
  role: 'user' | 'assistant',
  parts: ContentPart[],
): Record<string, unknown> {
  const text = parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const images = parts
    .filter((part): part is Extract<ContentPart, { type: 'image' }> => part.type === 'image')
    .map((part) => part.data);

  return {
    role,
    content: text,
    ...(images.length > 0 ? { images } : {}),
  };
}

function normalizeOllamaToolCalls(
  calls: NonNullable<NonNullable<OllamaChatChunk['message']>['tool_calls']>,
  firstIndex: number,
  responseId: string,
): ToolCall[] {
  let next = firstIndex;
  return calls.flatMap((call) => {
    const fn = call.function;
    if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) return [];
    return [{
      id: `ollama_call_${responseId}_${next++}`,
      name: fn.name,
      arguments: fn.arguments && typeof fn.arguments === 'object' ? fn.arguments : {},
    }];
  });
}

function mapOllamaThinking(
  reasoningEffort: ChatRequest['reasoningEffort'],
): boolean | 'low' | 'medium' | 'high' | undefined {
  switch (reasoningEffort) {
    case 'instant':
      return false;
    case 'low':
    case 'medium':
    case 'high':
      return reasoningEffort;
    default:
      return undefined;
  }
}

async function consumeNDJSON(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: OllamaChatChunk) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        onChunk(JSON.parse(trimmed) as OllamaChatChunk);
      }
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      onChunk(JSON.parse(trailing) as OllamaChatChunk);
    }
  } finally {
    // Release the socket when a chunk handler throws or the line is not JSON.
    await reader.cancel().catch(() => undefined);
  }
}

async function buildHttpError(
  prefix: string,
  response: Response,
  provider: string,
  operation: string,
  phase: string,
): Promise<ProviderError> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = toRecord(parsed['error']);
    if (Object.keys(error).length > 0) {
      const code = typeof error['code'] === 'string' ? `${error['code']}: ` : '';
      const message = typeof error['message'] === 'string' ? error['message'] : text;
      return new ProviderError(`${prefix} error ${response.status}: ${code}${message}`, {
        statusCode: response.status,
        provider,
        operation,
        phase,
      });
    }
  } catch {
    // fall through
  }
  return new ProviderError(`${prefix} error ${response.status}: ${text || response.statusText}`, {
    statusCode: response.status,
    provider,
    operation,
    phase,
  });
}


function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
