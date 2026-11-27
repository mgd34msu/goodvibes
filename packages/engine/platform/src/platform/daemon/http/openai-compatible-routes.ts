import type { ProviderRegistry } from '../../providers/registry.js';
import type { ChatResponse, ContentPart, LLMProvider, ProviderMessage, StreamDelta } from '../../providers/interface.js';
import type { ToolCall, ToolDefinition } from '../../types/tools.js';
import { summarizeError } from '../../utils/error-display.js';
import { isRecord } from '../../utils/record-coerce.js';
import { resolveModelReference } from '../../providers/model-id-resolution.js';
import { serviceFailureStatus } from './error-response.js';
import { DaemonBatchError } from '../../batch/types.js';
import type { DaemonBatchJob } from '../../batch/types.js';
import type { DaemonBatchManager } from '../../batch/manager.js';
import { currentRecordReach } from '@goodvibes/engine/daemon-api';

type JsonRecord = Record<string, unknown>;

export interface OpenAICompatibleRouteContext {
  readonly providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getCurrentModel' | 'getForModel'>;
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly recordApiResponse: (request: Request, path: string, response: Response) => Response;
  /** Null when the caller may spend provider money; the refusal otherwise. */
  readonly requireAdmin?: ((request: Request) => Response | null) | undefined;
  /**
   * The daemon's batch queue. A non-streaming chat completion is batch-capable:
   * it is queued when it asks for batch execution (`x-goodvibes-execution: batch`)
   * or, with `batch.mode` set to `eligible-by-default`, when it does not ask to
   * run live and its provider has a Batch API. Absent: every completion runs live.
   */
  readonly batch?: Pick<DaemonBatchManager, 'createJob' | 'getJob' | 'currentMode' | 'canBatch'> | undefined;
  /** The authenticated principal of a request: who queues a completion, and the only caller but the owner who reads it. */
  readonly callerPrincipal?: ((request: Request) => string | undefined) | undefined;
}

/** How a caller asks for one execution or the other; any other value is refused. */
const EXECUTION_HEADER = 'x-goodvibes-execution';

interface ResolvedModel {
  readonly provider: LLMProvider;
  readonly providerId: string;
  readonly modelId: string;
  readonly responseModel: string;
}

interface ChatCompletionRequest {
  readonly model?: unknown | undefined;
  readonly messages?: unknown | undefined;
  readonly stream?: unknown | undefined;
  readonly max_tokens?: unknown | undefined;
  readonly max_completion_tokens?: unknown | undefined;
  readonly tools?: unknown | undefined;
  readonly tool_choice?: unknown | undefined;
  readonly response_format?: unknown | undefined;
  readonly n?: unknown | undefined;
  readonly stop?: unknown | undefined;
  readonly logprobs?: unknown | undefined;
  readonly reasoning_effort?: unknown | undefined;
}

/**
 * Sampling options the providers behind this route do not take. Leaving one
 * out changes how an answer is sampled, not what kind of answer comes back,
 * so the request is served and the response names them in
 * `x-goodvibes-ignored-params`.
 */
const IGNORED_SAMPLING_PARAMS = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'logit_bias', 'top_logprobs'] as const;
const IGNORED_PARAMS_HEADER = 'x-goodvibes-ignored-params';

/**
 * The first option that would change what the answer is and that this route
 * cannot apply, as an OpenAI-shaped 400 naming it; null when every option is
 * applied or safely ignored.
 */
function refuseUnappliedOption(input: ChatCompletionRequest): Response | null {
  const unsupported = (param: string, detail: string) => openAIError(`${detail} Remove "${param}" and resend.`, 400, 'invalid_request_error', 'unsupported_parameter', param);
  if (input.response_format !== undefined && input.response_format !== null
    && !(isRecord(input.response_format) && input.response_format.type === 'text')) {
    return unsupported('response_format', 'A structured response format is not applied by this endpoint.');
  }
  if (input.tool_choice !== undefined && input.tool_choice !== null && input.tool_choice !== 'auto' && input.tool_choice !== 'none') {
    return unsupported('tool_choice', 'Only tool_choice "auto" or "none" is applied by this endpoint.');
  }
  if (input.n !== undefined && input.n !== null && input.n !== 1) {
    return unsupported('n', 'This endpoint returns one choice per request.');
  }
  if (input.stop !== undefined && input.stop !== null && !(Array.isArray(input.stop) && input.stop.length === 0)) {
    return unsupported('stop', 'Stop sequences are not applied by this endpoint.');
  }
  if (input.logprobs === true) {
    return unsupported('logprobs', 'Log probabilities are not returned by this endpoint.');
  }
  return null;
}

function ignoredParams(input: JsonRecord): string[] {
  return IGNORED_SAMPLING_PARAMS.filter((param) => input[param] !== undefined && input[param] !== null);
}

/** The OpenAI error type for a provider failure's HTTP status. */
function openAIErrorType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 400 && status < 500) return 'invalid_request_error';
  return 'server_error';
}

const OPENAI_COMPAT_PATH_PREFIX = '/v1';

export async function dispatchOpenAICompatibleRoutes(
  request: Request,
  context: OpenAICompatibleRouteContext,
  pathPrefix = OPENAI_COMPAT_PATH_PREFIX,
): Promise<Response | null> {
  const url = new URL(request.url);
  const prefix = normalizePathPrefix(pathPrefix);
  if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) return null;
  const routePath = url.pathname.slice(prefix.length) || '/';

  if (request.method === 'GET' && routePath === '/models') {
    return context.recordApiResponse(request, `${prefix}/models`, handleListModels(context));
  }

  if (request.method === 'POST' && routePath === '/chat/completions') {
    const adminError = context.requireAdmin?.(request) ?? null;
    if (adminError) return context.recordApiResponse(request, `${prefix}/chat/completions`, adminError);
    const response = await handleChatCompletions(request, context, prefix);
    return context.recordApiResponse(request, `${prefix}/chat/completions`, response);
  }

  // A completion that was queued as a batch job is read back here, by its job id.
  const completionMatch = request.method === 'GET' ? /^\/chat\/completions\/([^/]+)$/u.exec(routePath) : null;
  if (completionMatch) {
    const adminError = context.requireAdmin?.(request) ?? null;
    if (adminError) return context.recordApiResponse(request, `${prefix}/chat/completions/{id}`, adminError);
    const response = await handleQueuedCompletion(completionMatch[1]!, context, prefix);
    return context.recordApiResponse(request, `${prefix}/chat/completions/{id}`, response);
  }

  return null;
}

function handleListModels(context: OpenAICompatibleRouteContext): Response {
  const created = Math.floor(Date.now() / 1000);
  const models = context.providerRegistry.listModels();
  const current = context.providerRegistry.getCurrentModel();
  const ids = new Set<string>(['goodvibes/current']);

  for (const model of models) {
    ids.add(model.registryKey);
  }

  return Response.json({
    object: 'list',
    data: [...ids].sort().map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: id.startsWith('goodvibes/') ? 'goodvibes' : modelOwnerFor(id, models, current.provider),
    })),
  });
}

async function handleChatCompletions(
  request: Request,
  context: OpenAICompatibleRouteContext,
  prefix: string,
): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return await openAIErrorFromResponse(body);

  const parsed = body as ChatCompletionRequest;
  if (!Array.isArray(parsed.messages)) {
    return openAIError('Missing required field: messages', 400, 'invalid_request_error', 'missing_messages');
  }

  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(context.providerRegistry, typeof parsed.model === 'string' ? parsed.model : undefined);
  } catch (error) {
    return openAIError(summarizeError(error), 400, 'invalid_request_error', 'model_not_found');
  }

  const refused = refuseUnappliedOption(parsed);
  if (refused) return refused;

  let prepared: PreparedChatRequest;
  try {
    prepared = prepareChatRequest(parsed);
  } catch (error) {
    return openAIError(summarizeError(error), 400, 'invalid_request_error', 'invalid_messages');
  }

  const maxTokens = readMaxTokens(parsed);
  const ignored = ignoredParams(body);
  const headers: Record<string, string> = ignored.length > 0 ? { [IGNORED_PARAMS_HEADER]: ignored.join(',') } : {};
  const execution = readExecutionPreference(request);
  if (execution instanceof Response) return execution;
  if (parsed.stream === true) {
    if (execution === 'batch') {
      return openAIError('A streamed completion cannot run as a batch: provider batches answer later, all at once. Remove "stream" or the x-goodvibes-execution: batch header and resend.', 400, 'invalid_request_error', 'batch_stream_unsupported', 'stream');
    }
    return streamChatCompletion({
      request,
      resolved,
      prepared,
      maxTokens,
      headers,
    });
  }

  const queue = decideBatchExecution(context.batch, execution, resolved);
  if (queue instanceof Response) return queue;
  if (queue) return queueChatCompletion(queue, resolved, prepared, maxTokens, headers, prefix, request.signal, context.callerPrincipal?.(request));

  try {
    const response = await resolved.provider.chat({
      ...chatOptions(resolved, prepared, maxTokens),
      signal: request.signal,
    });
    return Response.json(buildChatCompletionResponse(resolved.responseModel, response), { headers });
  } catch (error) {
    // The provider's own status is kept, so a client does not retry a 400 or 401 it cannot fix by retrying.
    const status = serviceFailureStatus(error, 502);
    return openAIError(summarizeError(error), status, openAIErrorType(status), 'provider_error');
  }
}

interface PreparedChatRequest {
  readonly messages: ProviderMessage[];
  readonly systemPrompt?: string | undefined;
  readonly tools?: ToolDefinition[] | undefined;
  readonly reasoningEffort?: string | undefined;
}

function chatOptions(resolved: ResolvedModel, prepared: PreparedChatRequest, maxTokens: number | undefined) {
  return {
    model: resolved.modelId,
    messages: prepared.messages,
    ...(prepared.tools && prepared.tools.length > 0 ? { tools: prepared.tools } : {}),
    ...(prepared.systemPrompt ? { systemPrompt: prepared.systemPrompt } : {}),
    ...(prepared.reasoningEffort ? { reasoningEffort: prepared.reasoningEffort } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function resolveModel(
  registry: Pick<ProviderRegistry, 'listModels' | 'getCurrentModel' | 'getForModel'>,
  requested: string | undefined,
): ResolvedModel {
  const current = registry.getCurrentModel();
  const raw = requested?.trim();
  if (!raw) {
    throw new Error('Missing required field: model.');
  }
  if (raw === 'goodvibes/current') {
    return {
      provider: registry.getForModel(current.registryKey, current.provider),
      providerId: current.provider,
      modelId: current.id,
      responseModel: raw,
    };
  }

  // Accepts either a provider-qualified registryKey or a bare model id, bare
  // ids resolve via the shared resolver (unique -> auto-qualify; ambiguous or
  // unknown -> a rich error naming real candidates from the live registry).
  const models = registry.listModels();
  const registryKey = resolveModelReference(raw, models);
  const exact = models.find((model) => model.registryKey === registryKey);
  if (exact) {
    return {
      provider: registry.getForModel(exact.registryKey, exact.provider),
      providerId: exact.provider,
      modelId: exact.id,
      responseModel: exact.registryKey,
    };
  }

  throw new Error(`Model '${raw}' not found.`);
}

function prepareChatRequest(input: ChatCompletionRequest): PreparedChatRequest {
  const systemParts: string[] = [];
  const messages: ProviderMessage[] = [];

  for (const message of input.messages as unknown[]) {
    if (!isRecord(message)) throw new Error('Each message must be an object.');
    const role = readString(message.role);
    if (!role) throw new Error('Each message must include a role.');

    if (role === 'system' || role === 'developer') {
      const content = contentAsText(normalizeMessageContent(message.content));
      if (content.trim()) systemParts.push(content);
      continue;
    }

    if (role === 'user') {
      messages.push({ role: 'user', content: normalizeMessageContent(message.content) });
      continue;
    }

    if (role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: contentAsText(normalizeMessageContent(message.content)),
        ...(Array.isArray(message.tool_calls) ? { toolCalls: normalizeToolCalls(message.tool_calls) } : {}),
      });
      continue;
    }

    if (role === 'tool') {
      const callId = readString(message.tool_call_id) ?? readString(message.callId);
      if (!callId) throw new Error('Tool messages must include tool_call_id.');
      messages.push({
        role: 'tool',
        callId,
        content: contentAsText(normalizeMessageContent(message.content)),
        ...(readString(message.name) ? { name: readString(message.name) } : {}),
      });
      continue;
    }

    throw new Error(`Unsupported message role: ${role}`);
  }

  const reasoningEffort = readString(input.reasoning_effort);
  return {
    messages,
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join('\n\n') } : {}),
    // tool_choice "none" is applied by offering the model no tools.
    ...(Array.isArray(input.tools) && input.tool_choice !== 'none' ? { tools: normalizeTools(input.tools) } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function normalizeMessageContent(content: unknown): string | ContentPart[] {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) return String(content);

  // A part the route cannot hand to the model is refused, as an unapplied
  // option is: dropping it would answer about content the model never saw.
  const parts: ContentPart[] = [];
  const textParts: string[] = [];
  for (const [index, item] of content.entries()) {
    if (!isRecord(item)) {
      textParts.push(String(item));
      continue;
    }
    const type = readString(item.type);
    if (type === 'text' || type === 'input_text') {
      const text = readString(item.text);
      if (text) textParts.push(text);
      continue;
    }
    if (type === 'image_url') {
      const url = isRecord(item.image_url) ? readString(item.image_url.url) : undefined;
      if (!url) throw new Error(`Content part ${index} (image_url) has no image_url.url.`);
      if (!url.startsWith('data:')) {
        throw new Error(`Content part ${index} (image_url) is a remote URL, which this endpoint does not fetch. Send the image as a base64 data URL (data:<media type>;base64,<data>).`);
      }
      const parsed = parseDataUrl(url);
      if (!parsed) throw new Error(`Content part ${index} (image_url) is not a base64 data URL; send it as data:<media type>;base64,<data>.`);
      parts.push({ type: 'image', data: parsed.data, mediaType: parsed.mediaType });
      continue;
    }
    throw new Error(`Content part ${index} has type ${type ? `"${type}"` : '(none)'}, which this endpoint does not support; the supported types are text and image_url.`);
  }
  if (parts.length === 0) return textParts.join('\n');
  if (textParts.length > 0) parts.unshift({ type: 'text', text: textParts.join('\n') });
  return parts;
}

function contentAsText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text' ? part.text : `[image:${part.mediaType}]`).join('\n');
}

function normalizeTools(tools: readonly unknown[]): ToolDefinition[] {
  const normalized: ToolDefinition[] = [];
  for (const [index, tool] of tools.entries()) {
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
      throw new Error(`Tool ${index} is not a function tool; each tool must be { "type": "function", "function": { "name": ... } }.`);
    }
    const name = readString(tool.function.name);
    if (!name) throw new Error(`Tool ${index} has no function.name.`);
    normalized.push({
      name,
      description: readString(tool.function.description) ?? '',
      parameters: isRecord(tool.function.parameters) ? tool.function.parameters : { type: 'object', properties: {} },
    });
  }
  return normalized;
}

function normalizeToolCalls(toolCalls: readonly unknown[]): ToolCall[] {
  const normalized: ToolCall[] = [];
  for (const [index, call] of toolCalls.entries()) {
    const fn = isRecord(call) && isRecord(call.function) ? call.function : undefined;
    const id = isRecord(call) ? readString(call.id) : undefined;
    const name = fn ? readString(fn.name) : undefined;
    if (!fn || !id || !name) throw new Error(`Assistant tool call ${index} needs an id and a function.name.`);
    normalized.push({
      id,
      name,
      arguments: parseToolArguments(readString(fn.arguments) ?? '{}'),
    });
  }
  return normalized;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

function readMaxTokens(input: ChatCompletionRequest): number | undefined {
  const candidate = typeof input.max_completion_tokens === 'number'
    ? input.max_completion_tokens
    : typeof input.max_tokens === 'number'
      ? input.max_tokens
      : undefined;
  return candidate !== undefined && Number.isFinite(candidate) && candidate > 0
    ? Math.floor(candidate)
    : undefined;
}

function buildChatCompletionResponse(
  model: string,
  response: ChatResponse,
  identity: { readonly id: string; readonly createdMs: number } = { id: `chatcmpl-goodvibes-${crypto.randomUUID()}`, createdMs: Date.now() },
): JsonRecord {
  return {
    id: identity.id,
    object: 'chat.completion',
    created: Math.floor(identity.createdMs / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: response.content || null,
        ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls.map(toOpenAIToolCall) } : {}),
      },
      logprobs: null,
      finish_reason: mapFinishReason(response.stopReason),
    }],
    usage: buildUsage(response),
  };
}

function streamChatCompletion(input: {
  readonly request: Request;
  readonly resolved: ResolvedModel;
  readonly prepared: PreparedChatRequest;
  readonly maxTokens?: number | undefined;
  readonly headers: Record<string, string>;
}): Response {
  const encoder = new TextEncoder();
  const id = `chatcmpl-goodvibes-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let closed = false;
  let streamedContent = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: JsonRecord | '[DONE]') => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${payload === '[DONE]' ? payload : JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      // A client disconnect closes the controller; closing it again throws, and an
      // unhandled rejection takes the whole daemon down.
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the consumer
        }
      };

      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: input.resolved.responseModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }],
      });

      const onDelta = (delta: StreamDelta) => {
        if (delta.content) {
          streamedContent = true;
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model: input.resolved.responseModel,
            choices: [{ index: 0, delta: { content: delta.content }, logprobs: null, finish_reason: null }],
          });
        }
      };

      input.resolved.provider.chat({
        ...chatOptions(input.resolved, input.prepared, input.maxTokens),
        signal: input.request.signal,
        onDelta,
      }).then((response) => {
        if (!streamedContent && response.content) {
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model: input.resolved.responseModel,
            choices: [{ index: 0, delta: { content: response.content }, logprobs: null, finish_reason: null }],
          });
        }
        if (response.toolCalls.length > 0) {
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model: input.resolved.responseModel,
            choices: [{
              index: 0,
              // Stream consumers assemble tool calls by index.
              delta: { tool_calls: response.toolCalls.map((call, index) => ({ index, ...toOpenAIToolCall(call) })) },
              logprobs: null,
              finish_reason: null,
            }],
          });
        }
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model: input.resolved.responseModel,
          choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: mapFinishReason(response.stopReason) }],
          usage: buildUsage(response),
        });
        send('[DONE]');
        finish();
      }).catch((error) => {
        // The status line is already sent; the error chunk carries the provider's type.
        send({ error: openAIErrorBody(summarizeError(error), openAIErrorType(serviceFailureStatus(error, 502)), 'provider_error') });
        send('[DONE]');
        finish();
      }).catch(() => {});
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      ...input.headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

/** The execution the caller asked for, undefined when it did not ask, or the refusal of an unknown value. */
function readExecutionPreference(request: Request): 'batch' | 'live' | undefined | Response {
  const raw = request.headers.get(EXECUTION_HEADER);
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'batch' || value === 'live') return value;
  return openAIError(`${EXECUTION_HEADER} must be "batch" or "live", not "${raw.trim()}".`, 400, 'invalid_request_error', 'invalid_execution', EXECUTION_HEADER);
}

/**
 * Whether this completion is queued: the queue that takes it, null to run it
 * live, or the refusal of a batch the daemon does not accept. `explicit`
 * queues only what asks for batch; `eligible-by-default` also queues what did
 * not ask either way, but only when its provider has a Batch API: anything
 * else runs as the ordinary live request (the caller's cancellation, the
 * provider's own error status, no job record), and `batch.fallback` applies
 * only to a caller that asked for a batch.
 */
function decideBatchExecution(
  batch: OpenAICompatibleRouteContext['batch'],
  execution: 'batch' | 'live' | undefined,
  resolved: ResolvedModel,
): NonNullable<OpenAICompatibleRouteContext['batch']> | null | Response {
  if (execution === 'live') return null;
  const mode = batch?.currentMode() ?? 'off';
  if (execution === 'batch') {
    if (!batch || mode === 'off') {
      return openAIError('This daemon does not queue batch work: batch.mode is off. Set batch.mode to explicit or eligible-by-default, or resend without x-goodvibes-execution: batch to run it now.', 409, 'invalid_request_error', 'batch_disabled', EXECUTION_HEADER);
    }
    return batch;
  }
  return batch && mode === 'eligible-by-default' && batch.canBatch(resolved.providerId, resolved.modelId) ? batch : null;
}

/** Queue one completion as a batch job and answer 202 with where to read it, or the finished answer when it ran live. */
async function queueChatCompletion(
  batch: NonNullable<OpenAICompatibleRouteContext['batch']>,
  resolved: ResolvedModel,
  prepared: PreparedChatRequest,
  maxTokens: number | undefined,
  headers: Record<string, string>,
  prefix: string,
  signal: AbortSignal,
  /** Who queued it (the authenticated principal): the job is its own. */
  createdBy?: string | undefined,
): Promise<Response> {
  let job: DaemonBatchJob;
  try {
    job = await batch.createJob({
      ...(createdBy ? { createdBy } : {}),
      provider: resolved.providerId,
      model: resolved.modelId,
      request: {
        messages: prepared.messages,
        ...(prepared.tools && prepared.tools.length > 0 ? { tools: prepared.tools } : {}),
        ...(prepared.systemPrompt ? { systemPrompt: prepared.systemPrompt } : {}),
        ...(prepared.reasoningEffort ? { reasoningEffort: prepared.reasoningEffort } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      },
      source: { kind: 'daemon-api', id: 'openai-compatible' },
      metadata: { [RESPONSE_MODEL_METADATA_KEY]: resolved.responseModel },
    }, { signal });
  } catch (error) {
    if (error instanceof DaemonBatchError) {
      return openAIError(error.message, error.status, openAIErrorType(error.status), error.code.toLowerCase(), EXECUTION_HEADER);
    }
    const status = serviceFailureStatus(error, 500);
    return openAIError(summarizeError(error), status, openAIErrorType(status), 'batch_error');
  }
  return answerForJob(job, headers, prefix);
}

/** Recorded on a queued completion's job, so reading it back names the model the caller asked for. */
const RESPONSE_MODEL_METADATA_KEY = 'goodvibes.responseModel';

async function handleQueuedCompletion(
  rawId: string,
  context: OpenAICompatibleRouteContext,
  prefix: string,
): Promise<Response> {
  let jobId: string;
  try { jobId = decodeURIComponent(rawId); }
  catch { return openAIError('Malformed completion id in path.', 400, 'invalid_request_error', 'invalid_id'); }
  const found = context.batch ? await context.batch.getJob(jobId) : null;
  // A caller that is not the owner himself reads back only a completion it queued (control-plane/caller-reach.ts),
  // answered as for no completion: another caller's is never said to exist.
  const reach = currentRecordReach();
  const job = found && (!reach || reach('batch-job', found.id, { project: null, ...(found.createdBy ? { madeBy: found.createdBy } : {}) })) ? found : null;
  if (!job) return openAIError(`No queued completion '${jobId}' was found.`, 404, 'not_found_error', 'not_found');
  return answerForJob(job, {}, prefix);
}

/**
 * A queued completion as the caller reads it: the chat.completion once it
 * finished, 202 with its status while it waits, or the error it ended with.
 */
function answerForJob(job: DaemonBatchJob, headers: Record<string, string>, prefix: string): Response {
  const model = job.metadata?.[RESPONSE_MODEL_METADATA_KEY] ?? job.model;
  const ranLive = job.metadata?.['goodvibes.execution'] === 'live-fallback';
  const executionHeaders = { ...headers, [EXECUTION_HEADER]: ranLive ? 'live-fallback' : 'batch' };
  if (job.status === 'completed' && job.result) {
    return Response.json(
      buildChatCompletionResponse(model, job.result, { id: job.id, createdMs: job.completedAt ?? job.updatedAt }),
      { headers: executionHeaders },
    );
  }
  const pollPath = `${prefix}/chat/completions/${encodeURIComponent(job.id)}`;
  if (job.status === 'queued' || job.status === 'submitting' || job.status === 'submitted' || job.status === 'running') {
    return Response.json({
      id: job.id,
      object: 'chat.completion.batch_job',
      status: job.status,
      created: Math.floor(job.createdAt / 1000),
      model,
      poll: pollPath,
    }, { status: 202, headers: { ...executionHeaders, location: pollPath } });
  }
  const detail = job.error?.message ?? `The batch job ended ${job.status} without a result.`;
  if (job.status === 'cancelled') return openAIError(`The queued completion was cancelled. ${detail}`, 409, 'invalid_request_error', 'batch_cancelled');
  if (job.status === 'expired') return openAIError(`The provider batch expired before this completion ran. ${detail}`, 410, 'invalid_request_error', 'batch_expired');
  return openAIError(detail, 502, 'server_error', job.error?.code?.toLowerCase() ?? 'batch_failed');
}

function buildUsage(response: ChatResponse): JsonRecord {
  const promptTokens = response.usage.inputTokens + (response.usage.cacheReadTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0);
  const completionTokens = response.usage.outputTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function toOpenAIToolCall(call: ToolCall): JsonRecord {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  };
}

function mapFinishReason(reason: ChatResponse['stopReason']): string {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_call') return 'tool_calls';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

function openAIError(message: string, status: number, type: string, code: string, param: string | null = null): Response {
  return Response.json({ error: openAIErrorBody(message, type, code, param) }, { status });
}

function openAIErrorBody(message: string, type: string, code: string, param: string | null = null): JsonRecord {
  return { message, type, param, code };
}

/** The body parser's own refusal, in the OpenAI error shape, with its reason and status kept. */
async function openAIErrorFromResponse(response: Response): Promise<Response> {
  let reason: string | undefined;
  try {
    const refusal: unknown = await response.json();
    reason = isRecord(refusal) ? readString(refusal.error) : undefined;
  } catch {
    reason = undefined;
  }
  const status = response.status || 400;
  return openAIError(reason || 'Invalid request body', status, 'invalid_request_error', status === 413 ? 'request_too_large' : 'invalid_json');
}

function modelOwnerFor(id: string, models: ReturnType<ProviderRegistry['listModels']>, defaultOwner: string): string {
  const registryMatch = models.find((model) => model.registryKey === id);
  if (registryMatch) return registryMatch.provider;
  return defaultOwner;
}

function normalizePathPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed || trimmed === '/') return OPENAI_COMPAT_PATH_PREFIX;
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/u, '') : `/${trimmed.replace(/\/+$/u, '')}`;
}

/** A base64 data URL: the media type is what precedes its first parameter, and whitespace in the payload is dropped. */
function parseDataUrl(value: string): { mediaType: string; data: string } | null {
  const match = value.match(/^data:([^;,]+)((?:;[^;,]*)*);base64,([\s\S]+)$/u);
  if (!match) return null;
  const data = match[3]!.replace(/\s+/gu, '');
  if (!data) return null;
  return { mediaType: match[1]!.trim(), data };
}


function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
