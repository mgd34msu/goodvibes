import { revalidateProviderAttempt } from './attempt-guard.js';
import type {
  ChatRequest,
  ChatResponse,
  PartialToolCall,
  ProviderMessage,
} from './interface.js';
import type { ToolCall, ToolDefinition } from '../types/tools.js';
import { ProviderError } from '../types/errors.js';
import { withRetry } from '../utils/retry.js';
import { trackDeliveredOutput } from './stream-delivery.js';
import { refreshOpenAISubscriptionAfterRejection, resolveFreshOpenAIAccessToken } from '../config/subscription-auth.js';
import { arch, platform, release } from 'node:os';
import type { SubscriptionManager } from '../config/subscriptions.js';
import { toProviderError } from '../utils/error-display.js';
import { parseRateLimitHeaders } from './rate-limit-headers.js';
import { mapCodexStopReason } from './stop-reason-maps.js';
import { fetchWithTimeout, instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { toolCallArgumentFields } from './tool-formats.js';
import { SseLineBuffer } from './sse-line-buffer.js';

/**
 * The subscription route of the `openai` provider: a ChatGPT plan signed in
 * through Codex, served by chatgpt.com/backend-api in the Responses wire
 * format. It is not a provider of its own; `OpenAIProvider` owns the model
 * list and chooses this route first when the sign-in is set up.
 */
const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
/** Errors name the provider the user chose; the route is said in the message. */
const OPENAI_CODEX_PROVIDER_NAME = 'openai';
const MODEL_LIST_TIMEOUT_MS = 15_000;

/**
 * The models the signed-in plan serves, from the backend's own model list
 * (GET /codex/models, the list Codex clients read). Entries are read by their
 * `slug`, else `id`; the ids are the same as the API's, so no name is mapped.
 */
export async function fetchOpenAISubscriptionModelIds(accessToken: string): Promise<string[]> {
  const accountId = extractAccountId(accessToken);
  const res = await fetchWithTimeout(`${OPENAI_CODEX_BASE_URL}/codex/models`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': accountId,
      originator: 'pi',
      accept: 'application/json',
      'User-Agent': getOpenAICodexUserAgent(),
    },
  }, MODEL_LIST_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) throw new Error(`OpenAI subscription model list returned ${res.status} ${res.statusText}`);
  const body = await res.json() as { models?: unknown; data?: unknown };
  const entries = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];
  const ids = entries.flatMap((entry: unknown) => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (record['visibility'] === 'hide' || record['visibility'] === 'hidden') return [];
    const id = typeof record['slug'] === 'string' ? record['slug'] : typeof record['id'] === 'string' ? record['id'] : null;
    return id ? [id] : [];
  });
  return [...new Set(ids)];
}

/** The ChatGPT account a sign-in belongs to, or null when the token does not say. */
export function subscriptionAccountKey(accessToken: string): string | null {
  try { return extractAccountId(accessToken); } catch { return null; }
}

function getOpenAICodexUserAgent(): string {
  return `pi (${platform()} ${release()}; ${arch()})`;
}

/**
 * Whether the responses surface refused the credential. 401 is the observed
 * form; 403 is included because this codebase already maps provider 403s to
 * the authorization category, and a 403 for a lost entitlement would
 * otherwise skip recovery entirely.
 */
function isAuthRejection(error: unknown): error is ProviderError {
  return error instanceof ProviderError && (error.statusCode === 401 || error.statusCode === 403);
}

function normalizeOpenAIModel(model: string): string {
  if (model.startsWith('openai:')) return model.slice('openai:'.length);
  if (model.startsWith('openai/')) return model.slice('openai/'.length);
  return model;
}

type ResponsesInputItem =
  | { role: 'user'; content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }> }
  | { type: 'message'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations: [] }>; status: 'completed'; id: string }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

function extractAccountId(accessToken: string): string {
  const parts = accessToken.split('.');
  if (parts.length < 2) {
    throw new ProviderError('OpenAI subscription token is not a JWT.', {
      statusCode: 401,
      provider: OPENAI_CODEX_PROVIDER_NAME,
      operation: 'chat',
      phase: 'auth',
    });
  }
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as Record<string, unknown>;
  const auth = payload['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object') {
    throw new ProviderError('OpenAI subscription token does not include account metadata.', {
      statusCode: 401,
      provider: OPENAI_CODEX_PROVIDER_NAME,
      operation: 'chat',
      phase: 'auth',
    });
  }
  const accountId = (auth as Record<string, unknown>)['chatgpt_account_id'];
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new ProviderError('OpenAI subscription token does not include a ChatGPT account id.', {
      statusCode: 401,
      provider: OPENAI_CODEX_PROVIDER_NAME,
      operation: 'chat',
      phase: 'auth',
    });
  }
  return accountId;
}

function buildResponsesTools(tools?: ToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

function buildResponsesInput(messages: ProviderMessage[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  let assistantIndex = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        input.push({
          role: 'user',
          content: message.content.map((part) => (
            part.type === 'text'
              ? { type: 'input_text', text: part.text }
              : { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}`, detail: 'auto' }
          )),
        });
      } else {
        input.push({
          role: 'user',
          content: [{ type: 'input_text', text: message.content }],
        });
      }
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content, annotations: [] }],
          status: 'completed',
          id: `msg_${assistantIndex++}`,
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          id: `fc_${toolCall.id}`,
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        });
      }
      continue;
    }

    input.push({
      type: 'function_call_output',
      call_id: message.callId,
      output: message.content,
    });
  }

  return input;
}

function buildErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed['error'];
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      const code = typeof record['code'] === 'string' ? `${record['code']}: ` : '';
      const message = typeof record['message'] === 'string' ? record['message'] : body;
      return `OpenAI Codex API error ${status}: ${code}${message}`;
    }
  } catch {
    // fall through
  }
  return `OpenAI Codex API error ${status}: ${body}`;
}

/**
 * `sessionId` is the prompt-cache key and `session_id` header. A caller that
 * makes several requests of one conversation passes the same value so the
 * backend can reuse the cached prefix; without it each call gets its own.
 */
export async function chatWithOpenAICodex(
  accessToken: string,
  params: ChatRequest,
  sessionId: string = crypto.randomUUID(),
): Promise<ChatResponse> {
  const { onDelta, canRetry } = trackDeliveredOutput(params.onDelta);
  return withRetry(async () => {
      const accountId = extractAccountId(accessToken);
      const instructions = params.systemPrompt?.trim() || 'You are a helpful assistant.';
      const model = normalizeOpenAIModel(params.model);
      const body = {
        model,
        store: false,
        stream: true,
        instructions,
        input: buildResponsesInput(params.messages),
        text: { verbosity: 'medium' },
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: sessionId,
        tool_choice: params.toolChoice === 'none' ? 'none' : 'auto',
        parallel_tool_calls: true,
        ...(buildResponsesTools(params.tools) ? { tools: buildResponsesTools(params.tools) } : {}),
        ...(params.reasoningEffort && params.reasoningEffort !== 'instant'
          ? { reasoning: { effort: params.reasoningEffort, summary: 'auto' } }
          : {}),
      };

      if (params.beforeAttempt) await revalidateProviderAttempt(params.beforeAttempt);
      let response: Response;
      try {
        response = await instrumentedFetch(`${OPENAI_CODEX_BASE_URL}/codex/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'chatgpt-account-id': accountId,
            originator: 'pi',
            'OpenAI-Beta': 'responses=experimental',
            accept: 'text/event-stream',
            'content-type': 'application/json',
            'User-Agent': getOpenAICodexUserAgent(),
            session_id: sessionId,
          },
          body: JSON.stringify(body),
          ...(params.signal !== undefined ? { signal: params.signal } : {}),
        } as RequestInit);
      } catch (error: unknown) {
        throw toProviderError(error, {
          provider: OPENAI_CODEX_PROVIDER_NAME,
          operation: 'chat',
          phase: 'request',
        });
      }

      if (!response.ok) {
        const errorBody = await response.text();
        const retryAfterMs = parseRateLimitHeaders(response.headers)?.retryAfterMs;
        throw new ProviderError(buildErrorMessage(response.status, errorBody), {
          statusCode: response.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          provider: OPENAI_CODEX_PROVIDER_NAME,
          operation: 'chat',
          phase: 'request',
        });
      }
      if (!response.body) {
        throw new ProviderError('OpenAI Codex API returned no response body.', {
          statusCode: 502,
          provider: OPENAI_CODEX_PROVIDER_NAME,
          operation: 'chat',
          phase: 'response',
        });
      }

      const rateLimit = parseRateLimitHeaders(response.headers) ?? undefined;

      try {
        const sseBuffer = new SseLineBuffer();
        let text = '';
        const toolStarts = new Map<string, PartialToolCall>();
        const toolItemIds = new Map<string, string>();
        const toolArgs = new Map<string, string>();
        const toolCalls = new Map<string, ToolCall>();
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let status = 'in_progress';
        let incompleteReason: string | undefined;

        const handleDataPayload = (payload: string): void => {
          const fragments = payload
            .split(/\r?\ndata:\s+/)
            .map((fragment) => fragment.trim())
            .filter((fragment) => fragment.length > 0 && fragment !== '[DONE]');
          for (const fragment of fragments) {
            handleEvent(JSON.parse(fragment) as Record<string, unknown>);
          }
        };

        const handleEvent = (event: Record<string, unknown>): void => {
          const type = typeof event['type'] === 'string' ? event['type'] : '';
          if (type === 'response.output_item.added') {
            const item = event['item'];
            if (item && typeof item === 'object' && (item as Record<string, unknown>)['type'] === 'function_call') {
              const record = item as Record<string, unknown>;
              const callId = typeof record['call_id'] === 'string' ? record['call_id'] : '';
              const itemId = typeof record['id'] === 'string' ? record['id'] : '';
              if (!callId) return;
              const partial: PartialToolCall = {
                index: toolStarts.size,
                id: callId,
                name: typeof record['name'] === 'string' ? record['name'] : undefined,
              };
              toolStarts.set(callId, partial);
              if (itemId) toolItemIds.set(itemId, callId);
              onDelta?.({ toolCalls: [partial] });
            }
            return;
          }

        if (type === 'response.output_text.delta') {
          const delta = typeof event['delta'] === 'string' ? event['delta'] : '';
          if (!delta) return;
          text += delta;
          onDelta?.({ content: delta });
          return;
        }

        if (type === 'response.function_call_arguments.delta') {
          const itemId = typeof event['item_id'] === 'string' ? event['item_id'] : '';
          const delta = typeof event['delta'] === 'string' ? event['delta'] : '';
          if (!itemId || !delta) return;
          const callId = toolItemIds.get(itemId);
          if (!callId) return;
          const partial = toolStarts.get(callId);
          if (!partial) return;
          const next = `${toolArgs.get(callId) ?? ''}${delta}`;
          toolArgs.set(callId, next);
          onDelta?.({
            toolCalls: [{
              index: partial.index,
              id: callId,
              name: partial.name,
              arguments: delta,
            }],
          });
          return;
        }

        if (type === 'response.output_item.done') {
          const item = event['item'];
          if (!item || typeof item !== 'object') return;
          const record = item as Record<string, unknown>;
          if (record['type'] !== 'function_call') return;
          const callId = typeof record['call_id'] === 'string' ? record['call_id'] : '';
          const name = typeof record['name'] === 'string' ? record['name'] : '';
          const argumentsText = typeof record['arguments'] === 'string'
            ? record['arguments']
            : (toolArgs.get(callId) ?? '{}');
          if (!callId || !name) return;
          toolCalls.set(callId, {
            id: callId,
            name,
            ...toolCallArgumentFields(argumentsText, { provider: OPENAI_CODEX_PROVIDER_NAME, toolName: name, callId }),
          });
          return;
        }

        if (type === 'response.completed' || type === 'response.incomplete') {
          const completed = event['response'];
          if (!completed || typeof completed !== 'object') return;
          const record = completed as Record<string, unknown>;
          status = type === 'response.incomplete' ? 'incomplete' : 'completed';
          const incompleteDetails = record['incomplete_details'];
          if (incompleteDetails && typeof incompleteDetails === 'object') {
            const reason = (incompleteDetails as Record<string, unknown>)['reason'];
            if (typeof reason === 'string') incompleteReason = reason;
          }
          const usage = record['usage'];
          if (usage && typeof usage === 'object') {
            const usageRecord = usage as Record<string, unknown>;
            const input = typeof usageRecord['input_tokens'] === 'number' ? usageRecord['input_tokens'] : 0;
            const output = typeof usageRecord['output_tokens'] === 'number' ? usageRecord['output_tokens'] : 0;
            const inputDetails = usageRecord['input_tokens_details'];
            const cached = inputDetails && typeof inputDetails === 'object'
              && typeof (inputDetails as Record<string, unknown>)['cached_tokens'] === 'number'
              ? (inputDetails as Record<string, unknown>)['cached_tokens'] as number
              : 0;
            inputTokens = Math.max(0, input - cached);
            outputTokens = output;
            cacheReadTokens = cached;
          }
          return;
        }

        if (type === 'response.failed') {
          const failed = event['response'];
          if (!failed || typeof failed !== 'object') return;
          const error = (failed as Record<string, unknown>)['error'];
          if (error && typeof error === 'object') {
            const record = error as Record<string, unknown>;
            const code = typeof record['code'] === 'string' ? `${record['code']}: ` : '';
            const message = typeof record['message'] === 'string' ? record['message'] : 'Unknown failure';
            throw new ProviderError(`OpenAI Codex API error: ${code}${message}`, {
              statusCode: 400,
              provider: OPENAI_CODEX_PROVIDER_NAME,
              operation: 'chat',
              phase: 'stream',
            });
          }
          throw new ProviderError('OpenAI Codex API returned a failed response.', {
            statusCode: 400,
            provider: OPENAI_CODEX_PROVIDER_NAME,
            operation: 'chat',
            phase: 'stream',
          });
        }
        };

        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (const rawLine of sseBuffer.feed(value)) {
            const line = rawLine.trim();
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            handleDataPayload(data);
          }
        }
        for (const rawLine of sseBuffer.flush()) {
          const line = rawLine.trim();
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data && data !== '[DONE]') {
            handleDataPayload(data);
          }
        }

        if (status === 'in_progress') throw new ProviderError('OpenAI Codex stream ended without a terminal response.', {
          provider: OPENAI_CODEX_PROVIDER_NAME, operation: 'chat', phase: 'stream',
        });
        const resolvedToolCalls = [...toolCalls.values()];
        return {
          content: text,
          toolCalls: resolvedToolCalls,
          usage: {
            inputTokens,
            outputTokens,
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
          },
          stopReason: mapCodexStopReason(status, resolvedToolCalls.length > 0, incompleteReason),
          ...(status !== 'completed' ? { providerStopReason: status } : {}),
          ...(rateLimit ? { rateLimit } : {}),
        };
      } catch (error: unknown) {
        throw toProviderError(error, {
          provider: OPENAI_CODEX_PROVIDER_NAME,
          operation: 'chat',
          phase: 'stream',
        });
      }
    }, { ...(params.signal ? { signal: params.signal } : {}), ...(params.beforeAttempt ? { beforeAttempt: params.beforeAttempt } : {}), ...(params.maxRetries !== undefined ? { maxRetries: params.maxRetries } : {}), canRetry }, params.onRetry);
}

/** What the `openai` provider needs of the subscription store. */
export type OpenAISubscriptionStore = Pick<SubscriptionManager, 'get' | 'saveSubscription' | 'resolveAccessToken'>;

/** The subscription route: whether it is set up, and one request through it. */
export class OpenAISubscriptionRoute {
  /** One cache key for this route's lifetime, so consecutive turns share a prompt cache. */
  private readonly promptCacheSessionId = crypto.randomUUID();

  constructor(private readonly subscriptionManager: OpenAISubscriptionStore) {}

  /** A stored, unrevoked ChatGPT sign-in. Expiring tokens refresh inside chat(); their age does not unset the route. */
  isConfigured(): boolean {
    const subscription = this.subscriptionManager.get('openai');
    return Boolean(subscription && !subscription.accessToken.empty && subscription.revokedAt === undefined);
  }

  /** The stored access token (for listing models), or null when not signed in. */
  storedAccessToken(): string | null {
    const subscription = this.subscriptionManager.get('openai');
    return subscription && !subscription.accessToken.empty && subscription.revokedAt === undefined ? subscription.accessToken.reveal('dispatch') : null;
  }

  /** A usable access token for a request off the chat path (listing models), renewed when near expiry; null when not signed in or ended. */
  async freshAccessToken(): Promise<string | null> {
    const fresh = await resolveFreshOpenAIAccessToken(this.subscriptionManager);
    return fresh.kind === 'refreshed' ? fresh.accessToken : null;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    // Interaction-free freshness first: a near-expiry token refreshes
    // silently here, so the ordinary expiry case never surfaces anything.
    const resolved = await resolveFreshOpenAIAccessToken(this.subscriptionManager);
    if (resolved.kind === 'unconfigured') {
      throw new ProviderError('No active OpenAI subscription sign-in. Run /provider sign-in openai.', {
        statusCode: 401,
        provider: OPENAI_CODEX_PROVIDER_NAME,
        operation: 'chat',
        phase: 'auth',
      });
    }
    if (resolved.kind !== 'refreshed') throw this.subscriptionEndedError();
    const accessToken = resolved.accessToken;
    try {
      return await chatWithOpenAICodex(accessToken, params, this.promptCacheSessionId);
    } catch (error) {
      if (!isAuthRejection(error)) throw error;
      // The backend rejected the stored token: expired past its timestamp,
      // or revoked mid-lifetime (a Codex login elsewhere, a password
      // change). Both recover the same way: one shared refresh attempt,
      // then one retry.
      const outcome = await refreshOpenAISubscriptionAfterRejection(this.subscriptionManager, accessToken);
      if (outcome.kind === 'session-dead') throw this.subscriptionEndedError();
      // Refresh unjudgeable (token endpoint unreachable or broken): the
      // session may be fine, so surface the original rejection rather than
      // telling the user to sign in again.
      if (outcome.kind === 'unavailable') throw error;
      params.onRetry?.(1, 1, 0, error instanceof Error ? error : new Error(String(error)));
      try {
        return await chatWithOpenAICodex(outcome.accessToken, params, this.promptCacheSessionId);
      } catch (retryError) {
        // A fresh token the responses surface still refuses: the account
        // has lost the entitlement (plan lapsed, suspension).
        if (isAuthRejection(retryError)) throw this.subscriptionEndedError();
        throw retryError;
      }
    }
  }

  private subscriptionEndedError(): ProviderError {
    return new ProviderError(
      'Your OpenAI subscription sign-in has ended and could not be refreshed. Sign in to OpenAI again (/provider sign-in openai) to keep using the subscription.',
      {
        statusCode: 401,
        provider: OPENAI_CODEX_PROVIDER_NAME,
        operation: 'chat',
        phase: 'auth',
      },
    );
  }
}
