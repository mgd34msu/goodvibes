import { CopilotSessions, COPILOT_TOKEN_ENV_VARS, COPILOT_IO_TIMEOUT_MS, copilotIdeHeaders, type CopilotCredentialOwner } from './github-copilot-session.js';
import { ProviderAttemptDeniedError } from './attempt-guard.js';
import { join } from 'node:path';
import type { ChatRequest, ChatResponse, LLMProvider, ProviderModelSource, ProviderRuntimeMetadata, ProviderRuntimeMetadataDeps } from './interface.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicCompatProvider } from './anthropic-compat.js';
import { buildStandardProviderAuthRoutes, summarizeProviderAuth } from './runtime-metadata.js';
import { runLiveModelRefresh, type LiveModelDiscoveryResult } from './live-model-discovery.js';
import { toProviderError } from '../utils/error-display.js';
import { instrumentedLlmCall } from '../runtime/llm-observability.js';
import { readsAsCopilotClaudeModel } from '../routing/provider-cache-readings.js';

/**
 * Dated fallback model list, used when no GitHub token is configured (so a
 * live /models call isn't possible) and as the offline baseline when a live
 * call fails with no prior cache. Re-dated 2026-07-13 when live discovery
 * (below) was wired up; the entries themselves are still only cross-checked
 * against the direct Anthropic API's /v1/models response and OpenAI's
 * published model docs, not against a live Copilot subscription's actual
 * /models response (no Copilot subscription was available in this
 * environment to verify against). `refreshModels()` replaces this list with
 * the subscription's real available model ids the first time it runs
 * successfully against real credentials.
 */
export const COPILOT_DATED_STATIC_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'gpt-5.6',
  'gpt-4o',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-5.4',
  'o1',
  'o1-mini',
  'o3-mini',
];
export const COPILOT_DATED_STATIC_MODELS_AS_OF = '2026-07-13';

export interface GitHubCopilotProviderOptions {
  /** Previous credential-cache path, used once to retire its stored bearer. New sessions stay in this provider. */
  readonly tokenCachePath: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  /**
   * Absolute path to this provider's on-disk live-model-list cache file
   * (see `getProviderModelsCachePath`). Optional: when omitted,
   * `refreshModels()` still works but runs in-memory only for the lifetime
   * of this instance (no TTL skip across restarts).
   */
  readonly modelsCachePath?: string | undefined;
}

export function getGitHubCopilotTokenCachePath(cacheDir: string): string {
  return join(cacheDir, 'credentials', 'github-copilot.token.json');
}

function hasCopilotVisionInput(messages: ChatRequest['messages']): boolean {
  return messages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === 'image'));
}

function buildCopilotDynamicHeaders(messages: ChatRequest['messages']): Record<string, string> {
  const last = messages[messages.length - 1];
  const initiator = last && last.role !== 'user' ? 'agent' : 'user';
  return {
    ...copilotIdeHeaders(false),
    'X-Initiator': initiator,
    'Openai-Intent': 'conversation-edits',
    ...(hasCopilotVisionInput(messages) ? { 'Copilot-Vision-Request': 'true' } : {}),
  };
}

interface CopilotModelCapabilities {
  readonly type?: unknown;
}

interface CopilotModelEntry {
  readonly id?: unknown;
  readonly vendor?: unknown;
  readonly supported_endpoints?: unknown;
  readonly capabilities?: CopilotModelCapabilities;
}

/**
 * What Copilot's /models entry says about how a model is served: the
 * `supported_endpoints` paths (for example '/chat/completions', '/responses',
 * '/v1/messages') and the `vendor` name (for example 'Anthropic', 'OpenAI').
 * Either may be missing from an entry.
 */
export interface CopilotModelFacts {
  readonly supportedEndpoints?: readonly string[] | undefined;
  readonly vendor?: string | undefined;
}

/** Copilot's Anthropic Messages endpoint, as `supported_endpoints` names it. */
const COPILOT_MESSAGES_ENDPOINT = '/v1/messages';
const ANTHROPIC_VENDOR = 'anthropic';

function readCopilotModelFacts(entry: CopilotModelEntry): CopilotModelFacts {
  const endpoints = Array.isArray(entry.supported_endpoints)
    ? entry.supported_endpoints.filter((path): path is string => typeof path === 'string')
    : undefined;
  const vendor = typeof entry.vendor === 'string' && entry.vendor.trim().length > 0 ? entry.vendor.trim() : undefined;
  return {
    ...(endpoints ? { supportedEndpoints: endpoints } : {}),
    ...(vendor ? { vendor } : {}),
  };
}

/**
 * Whether the model's /models entry says it is served on Copilot's Anthropic
 * Messages endpoint: its `supported_endpoints` lists '/v1/messages', or, when
 * the entry has no endpoint list, its `vendor` is Anthropic. Undefined when
 * the entry carries neither field (or there is no entry), which is when the
 * model id is read instead.
 */
export function copilotServesAnthropicMessages(facts: CopilotModelFacts | undefined): boolean | undefined {
  if (facts?.supportedEndpoints) return facts.supportedEndpoints.includes(COPILOT_MESSAGES_ENDPOINT);
  if (facts?.vendor) return facts.vendor.toLowerCase() === ANTHROPIC_VENDOR;
  return undefined;
}

interface CopilotModelsResponse {
  readonly data?: readonly CopilotModelEntry[];
}

/**
 * Fetch GitHub Copilot's live model list: GET /models on the same
 * per-account Copilot API host (and using the same exchanged session token)
 * the provider-owned session store resolves for chat requests, no new
 * credential source, no new env vars. Verified 2026-07-13 against public,
 * independently-implemented Copilot API proxies (e.g. ericc-ch/copilot-api's
 * `getModels()`, which hits the identical `${baseUrl}/models` endpoint with
 * the same Bearer session token, Editor-Version/User-Agent headers, and a
 * `Copilot-Integration-Id` header) and against GitHub community reports of
 * `curl https://api.githubcopilot.com/models` with that same auth working
 * for the token-exchange flow, no live Copilot subscription was available
 * in this environment to call the endpoint directly. Response shape is
 * OpenAI-like (`{ data: [{ id, capabilities: { type } }] }`); only
 * `type: 'chat'` entries are kept so embedding-only models don't leak into
 * the chat model picker. Each kept entry's `supported_endpoints` and `vendor`
 * are kept with it: they say which transport the model is served on.
 */
async function fetchCopilotModels(options: GitHubCopilotProviderOptions, sessions: CopilotSessions, owner: CopilotCredentialOwner): Promise<Map<string, CopilotModelFacts>> {
  const fetchFn = options.fetchFn ?? fetch;
  const session = await sessions.resolve(owner);
  const url = `${session.baseUrl.replace(/\/+$/, '')}/models`;
  const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(COPILOT_IO_TIMEOUT_MS)]);
  sessions.assertCurrent(owner);
  const res = await fetchFn(url, {
    signal, redirect: 'error',
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/json',
      'Copilot-Integration-Id': 'vscode-chat',
      ...copilotIdeHeaders(true),
    },
  });
  try {
    sessions.assertCurrent(owner); signal.throwIfAborted();
    if (!res.ok) {
      throw new Error(`GitHub Copilot /models (${url}) returned ${res.status} ${res.statusText}`);
    }
    const body = await res.json() as CopilotModelsResponse;
    sessions.assertCurrent(owner); signal.throwIfAborted();
    const models = new Map<string, CopilotModelFacts>();
    for (const entry of body.data ?? []) {
      if (entry.capabilities?.type !== undefined && entry.capabilities.type !== 'chat') continue;
      if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
      models.set(entry.id, readCopilotModelFacts(entry));
    }
    return models;
  } finally { if (!res.bodyUsed) await res.body?.cancel().catch(() => {}); }
}

export class GitHubCopilotProvider implements LLMProvider {
  readonly name = 'github-copilot';
  readonly credentialAuthority = 'subscription' as const;
  /**
   * Live-discovery: GET /models on the Copilot API host, verified working
   * for this provider's token-exchange auth mode (see `fetchCopilotModels`
   * for the evidence trail). `COPILOT_DATED_STATIC_MODELS` below is the
   * offline fallback used when no GitHub token is configured or a live call
   * fails with no prior cache.
   */
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };

  /**
   * Populated synchronously with the dated-static baseline at construction
   * (never empty), then replaced by `refreshModels()` with the live /models
   * result. See `modelSource`.
   */
  private _models: string[] = [...COPILOT_DATED_STATIC_MODELS];
  get models(): string[] {
    this.observeCredentials();
    return this._models;
  }

  /** The /models facts of each model from the last live fetch in this process. */
  private readonly modelFacts = new Map<string, CopilotModelFacts>();

  private readonly sessions: CopilotSessions;
  private modelOwner: CopilotCredentialOwner | null = null;
  private modelsReadFor: CopilotCredentialOwner | null = null;

  constructor(private readonly options: GitHubCopilotProviderOptions) {
    this.options = { ...options };
    this.sessions = new CopilotSessions(this.options);
  }

  private observeCredentials(): CopilotCredentialOwner | null {
    const owner = this.sessions.capture();
    if (owner !== this.modelOwner) {
      this.modelOwner = owner;
      this.modelFacts.clear(); this.modelsReadFor = null;
      this._models = [...COPILOT_DATED_STATIC_MODELS];
    }
    return owner;
  }

  isConfigured(): boolean { return this.observeCredentials() !== null; }

  /**
   * Re-check Copilot's live model list. Called at boot (background,
   * refreshes the current account before reusing its model-list TTL cache) and on-demand for a picker-open
   * re-check or an explicit user refresh (`force: true`, bypasses the TTL
   * cache). Always resolves, falls back to the on-disk cache, then to the
   * dated-static list, and reports the honest reason when live discovery
   * fails rather than silently keeping stale data with no explanation.
   */
  async refreshModels(force = false): Promise<LiveModelDiscoveryResult> {
    const owner = this.observeCredentials();
    const retired = (): LiveModelDiscoveryResult => ({ models: [...COPILOT_DATED_STATIC_MODELS], source: 'dated-static',
      added: [], removed: [], asOf: COPILOT_DATED_STATIC_MODELS_AS_OF,
      error: 'The Copilot account changed during discovery. Refresh the currently selected account.' });
    let result: LiveModelDiscoveryResult;
    try {
      result = await runLiveModelRefresh({
        providerName: this.name,
        cachePath: this.options.modelsCachePath,
        datedStaticModels: COPILOT_DATED_STATIC_MODELS,
        datedStaticAsOf: COPILOT_DATED_STATIC_MODELS_AS_OF,
        isConfigured: owner !== null,
        assertCurrent: () => { if (this.observeCredentials() !== owner) throw new Error('Copilot account changed during discovery'); },
        fetchLive: async () => {
          if (!owner) throw new Error('GitHub Copilot requires a configured GitHub token');
          const live = await fetchCopilotModels(this.options, this.sessions, owner);
          this.sessions.assertCurrent(owner);
          this.modelFacts.clear();
          for (const [id, facts] of live) this.modelFacts.set(id, facts);
          return [...live.keys()];
        },
        force: force || (owner !== null && this.modelsReadFor !== owner),
      });
    } catch (error) {
      if (this.observeCredentials() !== owner) return retired();
      throw error;
    }
    if (this.observeCredentials() !== owner) return retired();
    if (result.source === 'live') this.modelsReadFor = owner;
    this._models = [...result.models];
    return result;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const owner = this.observeCredentials();
    if (!owner) throw new Error('GitHub Copilot requires COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.');
    const callerSignal = params.signal, beforeAttempt = params.beforeAttempt, onDelta = params.onDelta;
    const signal = callerSignal ? AbortSignal.any([callerSignal, owner.signal]) : owner.signal;
    const current = () => { signal.throwIfAborted(); this.sessions.assertCurrent(owner); signal.throwIfAborted(); };
    current();
    const model = params.model ?? this.models[0]!;
    // Outside the try so a judgment port error is not rewrapped as a provider error.
    const anthropicTransport = await this.usesAnthropicTransport(model);
    current();
    const request: ChatRequest = { ...params, model, signal,
      beforeAttempt: async () => { current(); await beforeAttempt?.(); current(); },
      ...(onDelta ? { onDelta: (delta) => { current(); onDelta(delta); current(); } } : {}),
    };
    try {
      const session = await this.sessions.resolve(owner, signal);
      current();
      const baseURL = `${session.baseUrl.replace(/\/+$/, '')}/v1`;
      const defaultHeaders = buildCopilotDynamicHeaders(params.messages);
      if (anthropicTransport) {
        const provider = new AnthropicCompatProvider({
          name: this.name,
          baseURL,
          apiKey: session.token,
          defaultModel: model,
          models: this.models,
          defaultHeaders,
          authEnvVars: COPILOT_TOKEN_ENV_VARS,
          serviceNames: ['github-copilot'],
          authHeaderMode: 'bearer',
          streamProtocol: 'anthropic-sse',
        });
        const result = await provider.chat(request); current(); return result;
      }

      const provider = new OpenAICompatProvider({
        name: this.name,
        baseURL,
        apiKey: session.token,
        defaultModel: model,
        models: this.models,
        defaultHeaders,
        authEnvVars: COPILOT_TOKEN_ENV_VARS,
        serviceNames: ['github-copilot'],
        aliases: ['copilot'],
        streamProtocol: 'openai-sse',
      });
      const result = (await instrumentedLlmCall(
        () => provider.chat(request),
        { provider: this.name, model },
      )).result;
      current(); return result;
    } catch (error) {
      if (error instanceof ProviderAttemptDeniedError) throw error;
      throw toProviderError(error, {
        provider: this.name,
        operation: 'chat',
      });
    }
  }

  /**
   * Whether a model goes through Copilot's Anthropic Messages endpoint. The
   * model's /models entry decides when it carries `supported_endpoints` or
   * `vendor`; otherwise `routing.copilot-claude-model` reads the id, and only
   * a reading strong enough to act on picks the Anthropic path. Every other
   * model uses the OpenAI-compatible endpoint.
   */
  private async usesAnthropicTransport(model: string): Promise<boolean> {
    const served = copilotServesAnthropicMessages(this.modelFacts.get(model));
    if (served !== undefined) return served;
    return readsAsCopilotClaudeModel(model, 'providers.github-copilot.transport');
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const configured = this.isConfigured();
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: COPILOT_TOKEN_ENV_VARS,
      secretKeys: COPILOT_TOKEN_ENV_VARS,
      serviceNames: ['github-copilot'],
    }, deps);
    const auth = summarizeProviderAuth({
      configured,
      detail: configured
        ? 'GitHub token is available for Copilot token exchange.'
        : 'Set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN to use GitHub Copilot.',
    }, authRoutes);
    return {
      auth: {
        mode: 'api-key',
        configured: auth.configured,
        detail: auth.detail,
        envVars: COPILOT_TOKEN_ENV_VARS,
        routes: authRoutes,
      },
      models: {
        defaultModel: this.models[0],
        models: this.models,
        aliases: ['copilot'],
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        notes: ['Claude-family Copilot models use Anthropic transport. Other models use the OpenAI-compatible Copilot endpoint.'],
      },
      policy: {
        local: false,
        streamProtocol: 'mixed:anthropic+openai',
        reasoningMode: 'provider-managed',
      },
    };
  }
}
