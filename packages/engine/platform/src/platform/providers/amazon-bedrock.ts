// `@anthropic-ai/bedrock-sdk` is an optionalDependency and is reached through
// providers/optional-bedrock.ts at the call that needs it, never as a static
// import: the client class here, and the exact SigV4 signer AnthropicBedrock
// itself calls internally (core/auth.js's `getAuthHeaders`) to sign runtime
// `invoke` requests against `bedrock-runtime.<region>.amazonaws.com`. The
// signer is reused below, unmodified, to sign a GET against the control-plane
// `bedrock.<region>.amazonaws.com` host instead, same AWS service
// ('bedrock'), same credential resolution, different path.
import { loadBedrockAuth, loadBedrockLibrary } from './optional-bedrock.js';
import { AnthropicMessagesProvider } from './anthropic-messages-provider.js';
import type { ProviderModelSource } from './interface.js';
import { runLiveModelRefresh, type LiveModelDiscoveryResult } from './live-model-discovery.js';
import { fetchWithTimeout, instrumentedFetch } from '../utils/fetch-with-timeout.js';

const BEDROCK_LIVE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Dated fallback model list, used when no AWS credentials are configured
 * (so a live ListFoundationModels call isn't possible) and as the offline
 * baseline when a live call fails with no prior cache. Re-dated 2026-07-13
 * when live discovery (below) was wired up; the entries themselves are still
 * only cross-checked against the direct Anthropic API's /v1/models response,
 * not against a live Bedrock account's actual ListFoundationModels output
 * (no AWS credentials were available in this environment to verify against).
 * `refreshModels()` replaces this list with the account's real model ids the
 * first time it runs successfully against real credentials.
 */
export const BEDROCK_DATED_STATIC_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];
export const BEDROCK_DATED_STATIC_MODELS_AS_OF = '2026-07-13';

/**
 * The Bedrock bearer token: one handed in at construction (resolved by the
 * registry from the environment or the secrets store) first, then the
 * environment. The AWS access-key pair and the profile are environment-only: a
 * stored pair would need both values read before the signing path is chosen.
 */
export function resolveBedrockBearerToken(injected?: string): string | undefined {
  return injected?.trim() || process.env['AWS_BEARER_TOKEN_BEDROCK']?.trim() || undefined;
}

export function hasAwsCredentials(injectedBearerToken?: string): boolean {
  return Boolean(
    resolveBedrockBearerToken(injectedBearerToken)
    || (process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY'])
    || process.env['AWS_PROFILE'],
  );
}

function resolveBedrockRegion(): string {
  return process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
}

interface BedrockModelLifecycle {
  readonly status?: unknown;
}

interface BedrockModelSummary {
  readonly modelId?: unknown;
  readonly providerName?: unknown;
  readonly outputModalities?: unknown;
  readonly responseStreamingSupported?: unknown;
  readonly modelLifecycle?: BedrockModelLifecycle;
}

interface BedrockListFoundationModelsResponse {
  readonly modelSummaries?: readonly BedrockModelSummary[];
}

/**
 * Fetch Amazon Bedrock's live foundation-model list: GET /foundation-models
 * on the `bedrock.<region>.amazonaws.com` control-plane host (distinct from
 * the `bedrock-runtime.<region>.amazonaws.com` host chat requests use). Auth
 * mirrors `AnthropicBedrock` exactly: the bearer-token path when
 * AWS_BEARER_TOKEN_BEDROCK is set (same header AnthropicBedrock sends as its
 * `authToken`), otherwise the same SigV4 signer against explicit
 * AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or, failing those, the AWS
 * credential provider chain (profile, IAM role, etc.), no new credential
 * source, no new env vars.
 *
 * Exported so `amazon-bedrock-mantle.ts` can reuse this exact control-plane
 * call instead of duplicating the signing/fetch/filter logic: Mantle uses the
 * same AWS account's Bedrock control plane (`bedrock.<region>.amazonaws.com`
 * ListFoundationModels), just a different runtime data-plane host, so one
 * live-discovery fetcher serves both providers.
 */
export async function fetchBedrockModelIds(options: { readonly bearerToken?: string | undefined } = {}): Promise<string[]> {
  const region = resolveBedrockRegion();
  const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;
  const bearerToken = resolveBedrockBearerToken(options.bearerToken);
  let headers: Record<string, string>;
  if (bearerToken) {
    headers = { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' };
  } else {
    const { getAuthHeaders } = await loadBedrockAuth();
    const signed = await getAuthHeaders(
      { method: 'GET' },
      {
        url,
        regionName: region,
        awsAccessKey: process.env['AWS_ACCESS_KEY_ID']?.trim() || null,
        awsSecretKey: process.env['AWS_SECRET_ACCESS_KEY']?.trim() || null,
        awsSessionToken: process.env['AWS_SESSION_TOKEN']?.trim() || null,
      },
    );
    headers = { Accept: 'application/json', ...signed };
  }
  const res = await fetchWithTimeout(url, { headers }, BEDROCK_LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) {
    throw new Error(`Bedrock ListFoundationModels (${url}) returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as BedrockListFoundationModelsResponse;
  const ids = (body.modelSummaries ?? [])
    .filter((summary) =>
      typeof summary.providerName === 'string'
      && summary.providerName.toLowerCase() === 'anthropic'
      && (summary.modelLifecycle?.status === undefined || summary.modelLifecycle.status === 'ACTIVE')
      && Array.isArray(summary.outputModalities) && summary.outputModalities.includes('TEXT')
      && summary.responseStreamingSupported === true)
    .map((summary) => (typeof summary.modelId === 'string' ? summary.modelId : null))
    .filter((id): id is string => id !== null && id.length > 0);
  return ids;
}

export class AmazonBedrockProvider extends AnthropicMessagesProvider {
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };
  private readonly modelsCachePath: string | undefined;
  private readonly bearerToken: string | undefined;

  /**
   * @param options.bearerToken A bearer token the registry resolved (environment
   * first, then the secrets store); without one the environment is read per call.
   */
  constructor(modelsCachePath?: string, options: { readonly bearerToken?: string | undefined } = {}) {
    const bearerToken = options.bearerToken;
    super({
      name: 'amazon-bedrock',
      label: 'Amazon Bedrock',
      defaultModel: 'claude-sonnet-4-6',
      models: [...BEDROCK_DATED_STATIC_MODELS],
      // Async because `@anthropic-ai/bedrock-sdk` is resolved here rather than
      // at module init; `createClient` accepts a promise for exactly this, and
      // an install without the package fails this one request with a message
      // naming it instead of preventing the daemon from starting.
      createClient: async () => {
        const { AnthropicBedrock } = await loadBedrockLibrary();
        const apiKey = resolveBedrockBearerToken(bearerToken);
        const awsAccessKey = process.env['AWS_ACCESS_KEY_ID']?.trim();
        const awsSecretKey = process.env['AWS_SECRET_ACCESS_KEY']?.trim();
        const awsSessionToken = process.env['AWS_SESSION_TOKEN']?.trim();
        const baseOptions = {
          ...(apiKey ? { apiKey } : {}),
          awsRegion: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
        };
        if (awsAccessKey && awsSecretKey) {
          return new AnthropicBedrock({
            ...baseOptions,
            awsAccessKey,
            awsSecretKey,
            ...(awsSessionToken ? { awsSessionToken } : {}),
          });
        }
        return new AnthropicBedrock(baseOptions);
      },
      // Read per call: credentials set or removed after boot change the answer.
      auth: () => {
        const configured = hasAwsCredentials(bearerToken);
        return {
          mode: configured ? 'api-key' : 'anonymous',
          configured,
          detail: configured
            ? 'AWS Bedrock credentials are available through bearer token or AWS credential resolution.'
            : 'Configure AWS_BEARER_TOKEN_BEDROCK or AWS credentials/profile for Amazon Bedrock.',
          envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION'],
          secretKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
          allowAnonymous: true,
          anonymousConfigured: Boolean(process.env['AWS_PROFILE']),
          anonymousDetail: 'The AWS credential provider chain can satisfy Bedrock auth without storing an API key in GoodVibes.',
        };
      },
      streamProtocol: 'anthropic-sdk-stream',
      notes: ['Claude-on-Bedrock models are exposed through the Anthropic Bedrock SDK.'],
    });
    this.modelsCachePath = modelsCachePath;
    this.bearerToken = bearerToken;
  }

  isConfigured(): boolean {
    return hasAwsCredentials(this.bearerToken);
  }

  /**
   * Re-check Bedrock's live foundation-model list. Called at boot
   * (background, respects the on-disk TTL cache) and on-demand for a
   * picker-open re-check or an explicit user refresh (`force: true`,
   * bypasses the TTL cache). Always resolves, falls back to the on-disk
   * cache, then to the dated-static list, and reports the honest reason
   * when live discovery fails rather than silently keeping stale data with
   * no explanation.
   */
  async refreshModels(force = false): Promise<LiveModelDiscoveryResult> {
    const result = await runLiveModelRefresh({
      providerName: this.name,
      cachePath: this.modelsCachePath,
      datedStaticModels: BEDROCK_DATED_STATIC_MODELS,
      datedStaticAsOf: BEDROCK_DATED_STATIC_MODELS_AS_OF,
      isConfigured: this.isConfigured(),
      fetchLive: () => fetchBedrockModelIds({ bearerToken: this.bearerToken }),
      force,
    });
    this.models.length = 0;
    this.models.push(...result.models);
    return result;
  }
}
