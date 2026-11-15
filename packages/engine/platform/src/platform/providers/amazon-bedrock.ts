// `@anthropic-ai/bedrock-sdk` is an optionalDependency and is reached through
// providers/optional-bedrock.ts at the call that needs it, never as a static
// import: the client classes, and the exact SigV4 signer AnthropicBedrock
// itself calls internally (core/auth.js's `getAuthHeaders`) to sign runtime
// `invoke` requests against `bedrock-runtime.<region>.amazonaws.com`. The
// signer is reused below, unmodified, to sign GETs against the control-plane
// `bedrock.<region>.amazonaws.com` host instead, same AWS service
// ('bedrock'), same credential resolution, different path.
import { loadBedrockAuth, loadBedrockLibrary } from './optional-bedrock.js';
import { AnthropicMessagesProvider, type AnthropicMessagesProviderOptions } from './anthropic-messages-provider.js';
import type { ProviderModelSource } from './interface.js';
import { diffModelIds, runLiveModelRefresh, type LiveModelDiscoveryResult } from './live-model-discovery.js';
import { fetchWithTimeout, instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

const BEDROCK_LIVE_FETCH_TIMEOUT_MS = 15_000;

/** The display name of each Bedrock-family provider; the daemon's provider listing reads it from here. */
export const BEDROCK_PROVIDER_LABELS = {
  'amazon-bedrock': 'Amazon Bedrock',
  'amazon-bedrock-mantle': 'Amazon Bedrock (Mantle)',
} as const;

/**
 * Model names shown before the first successful listing, in the one id space
 * every Bedrock-family provider uses: the model's catalog name. A listed
 * Bedrock id (`anthropic.claude-sonnet-4-6-v1:0`, or an inference profile such
 * as `global.anthropic.claude-sonnet-4-6-v1:0`) is shown under the same name
 * and sent as the id the account listed (see `bedrockModelName`), so a saved
 * choice keeps matching across a refresh and across a cache loss.
 */
export const BEDROCK_DATED_STATIC_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];
export const BEDROCK_DATED_STATIC_MODELS_AS_OF = '2026-07-13';

/** The model a Bedrock-family provider answers with when its current list includes it. */
const BEDROCK_PREFERRED_DEFAULT_MODEL = 'claude-sonnet-4-6';

/** AWS credentials as the environment and the registry give them, trimmed once. */
export interface AwsCredentialFacts {
  readonly bearerToken?: string | undefined;
  /** Present only as a pair: one half alone signs nothing. */
  readonly accessKey?: { readonly id: string; readonly secret: string; readonly sessionToken?: string | undefined } | undefined;
  readonly profile?: string | undefined;
  readonly region: string;
}

function envValue(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/**
 * The bearer token handed in at construction (resolved by the registry from
 * the environment or the secrets store) first, then the environment. The
 * access-key pair and the profile are environment-only: a stored pair would
 * need both values read before the signing path is chosen.
 */
export function resolveBedrockBearerToken(injected?: string): string | undefined {
  return injected?.trim() || envValue('AWS_BEARER_TOKEN_BEDROCK');
}

export function readAwsCredentials(injectedBearerToken?: string): AwsCredentialFacts {
  const id = envValue('AWS_ACCESS_KEY_ID');
  const secret = envValue('AWS_SECRET_ACCESS_KEY');
  const sessionToken = envValue('AWS_SESSION_TOKEN');
  return {
    bearerToken: resolveBedrockBearerToken(injectedBearerToken),
    accessKey: id && secret ? { id, secret, ...(sessionToken ? { sessionToken } : {}) } : undefined,
    profile: envValue('AWS_PROFILE'),
    region: envValue('AWS_REGION') ?? envValue('AWS_DEFAULT_REGION') ?? 'us-east-1',
  };
}

/** Whether a Bedrock-family provider can authenticate: a bearer token, an access-key pair, or a profile. */
export function hasAwsCredentials(injectedBearerToken?: string): boolean {
  const credentials = readAwsCredentials(injectedBearerToken);
  return Boolean(credentials.bearerToken || credentials.accessKey || credentials.profile);
}

interface BedrockModelSummary {
  readonly modelId?: unknown;
  readonly providerName?: unknown;
  readonly outputModalities?: unknown;
  readonly responseStreamingSupported?: unknown;
  readonly inferenceTypesSupported?: unknown;
  readonly modelLifecycle?: { readonly status?: unknown };
}

interface BedrockInferenceProfileSummary {
  readonly inferenceProfileId?: unknown;
  readonly status?: unknown;
  readonly models?: readonly { readonly modelArn?: unknown }[];
}

async function bedrockControlPlaneGet(path: string, credentials: AwsCredentialFacts): Promise<unknown> {
  const url = `https://bedrock.${credentials.region}.amazonaws.com${path}`;
  let headers: Record<string, string>;
  if (credentials.bearerToken) {
    headers = { Authorization: `Bearer ${credentials.bearerToken}`, Accept: 'application/json' };
  } else {
    const { getAuthHeaders } = await loadBedrockAuth();
    const signed = await getAuthHeaders(
      { method: 'GET' },
      {
        url,
        regionName: credentials.region,
        awsAccessKey: credentials.accessKey?.id ?? null,
        awsSecretKey: credentials.accessKey?.secret ?? null,
        awsSessionToken: credentials.accessKey?.sessionToken ?? null,
      },
    );
    headers = { Accept: 'application/json', ...signed };
  }
  const res = await fetchWithTimeout(url, { headers }, BEDROCK_LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) throw new Error(`Bedrock control plane (${url}) returned ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * The account's invocable Anthropic model ids: active text-streaming
 * foundation models (ListFoundationModels) plus the system-defined inference
 * profiles that serve them (ListInferenceProfiles), since current Claude
 * models are invoked through a profile rather than on demand. Auth mirrors
 * `AnthropicBedrock`: the bearer token when one is set, otherwise SigV4 over
 * the access-key pair or the AWS credential provider chain. A failed profile
 * listing leaves the foundation ids; a failed model listing throws.
 *
 * Mantle shares this control plane: the listing is the account's Bedrock
 * catalogue, which `AmazonBedrockMantleProvider` reports as not confirmed for
 * its runtime host.
 */
export async function fetchBedrockModelIds(options: { readonly bearerToken?: string | undefined } = {}): Promise<string[]> {
  const credentials = readAwsCredentials(options.bearerToken);
  const body = await bedrockControlPlaneGet('/foundation-models', credentials) as { modelSummaries?: readonly BedrockModelSummary[] };
  const foundation = (body.modelSummaries ?? [])
    .filter((summary) =>
      typeof summary.providerName === 'string'
      && summary.providerName.toLowerCase() === 'anthropic'
      && (summary.modelLifecycle?.status === undefined || summary.modelLifecycle.status === 'ACTIVE')
      && Array.isArray(summary.outputModalities) && summary.outputModalities.includes('TEXT')
      && summary.responseStreamingSupported === true)
    .flatMap((summary) => (typeof summary.modelId === 'string' && summary.modelId.length > 0 ? [summary.modelId] : []));
  const profiles: string[] = [];
  try {
    const listed = await bedrockControlPlaneGet('/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000', credentials) as
      { inferenceProfileSummaries?: readonly BedrockInferenceProfileSummary[] };
    for (const profile of listed.inferenceProfileSummaries ?? []) {
      if (typeof profile.inferenceProfileId !== 'string' || (profile.status !== undefined && profile.status !== 'ACTIVE')) continue;
      const serves = (profile.models ?? []).some((model) =>
        typeof model.modelArn === 'string' && foundation.some((id) => model.modelArn === id || (model.modelArn as string).endsWith(`/${id}`)));
      if (serves) profiles.push(profile.inferenceProfileId);
    }
  } catch (error) {
    logger.warn('[provider-models] Bedrock inference profile listing failed; using foundation model ids', { error: summarizeError(error) });
  }
  return [...foundation, ...profiles];
}

const BEDROCK_GEO_PREFIX = /^(?:global|us-gov|us|eu|apac|ap|jp|au|ca)\./;

/**
 * The catalog name of a Bedrock model id: `global.anthropic.claude-sonnet-4-6-20260501-v1:0`
 * and `anthropic.claude-sonnet-4-6-v1:0` both name `claude-sonnet-4-6`. A name that is
 * not a Bedrock Anthropic id is returned unchanged.
 */
export function bedrockModelName(id: string): string {
  const bare = id.replace(BEDROCK_GEO_PREFIX, '');
  if (!bare.startsWith('anthropic.')) return id;
  return bare.slice('anthropic.'.length).replace(/-v\d+(?::\d+)?$/, '').replace(/-\d{8}$/, '');
}

/** Which listed id a name is sent as: a global profile, then this region's geography, then the foundation id. */
function invocationRank(id: string, region: string): number {
  if (id.startsWith('global.')) return 0;
  const geo = id.match(BEDROCK_GEO_PREFIX)?.[0];
  if (geo && region.startsWith(geo.slice(0, 2))) return 1;
  return geo ? 3 : 2;
}

export interface BedrockFamilyOptions {
  readonly name: keyof typeof BEDROCK_PROVIDER_LABELS;
  /** Builds the SDK client from the credentials read for this request. */
  readonly buildClient: (credentials: AwsCredentialFacts) => Promise<Awaited<ReturnType<AnthropicMessagesProviderOptions['createClient']>>>;
  readonly notes: readonly string[];
  /** Said with every refresh report: what the listing does not establish for this provider. */
  readonly listingNote?: string | undefined;
}

/**
 * One Bedrock-family provider: the model list, credentials, region and refresh
 * are shared; the SDK client, name and label differ.
 */
export class BedrockFamilyProvider extends AnthropicMessagesProvider {
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };
  private readonly modelsCachePath: string | undefined;
  private readonly bearerToken: string | undefined;
  private readonly listingNote: string | undefined;
  /** Catalog name -> the listed id it is sent as. Empty until a listing (live or cached) is read. */
  private readonly invocableIds = new Map<string, string>();

  /**
   * @param options.bearerToken A bearer token the registry resolved (environment
   * first, then the secrets store); without one the environment is read per call.
   */
  constructor(family: BedrockFamilyOptions, modelsCachePath?: string, options: { readonly bearerToken?: string | undefined } = {}) {
    const bearerToken = options.bearerToken;
    const label = BEDROCK_PROVIDER_LABELS[family.name];
    super({
      name: family.name,
      label,
      defaultModel: BEDROCK_PREFERRED_DEFAULT_MODEL,
      models: [...BEDROCK_DATED_STATIC_MODELS],
      // Async because `@anthropic-ai/bedrock-sdk` is resolved here rather than
      // at module init; an install without the package fails this one request
      // with a message naming it instead of preventing the daemon from starting.
      createClient: () => family.buildClient(readAwsCredentials(bearerToken)),
      // Read per call: credentials set or removed after boot change the answer.
      auth: () => {
        const configured = hasAwsCredentials(bearerToken);
        return {
          mode: configured ? 'api-key' : 'anonymous',
          configured,
          detail: configured
            ? `${label} credentials are available through a bearer token or AWS credential resolution.`
            : `Configure AWS_BEARER_TOKEN_BEDROCK, an AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY pair, or AWS_PROFILE for ${label}.`,
          envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION'],
          secretKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
          allowAnonymous: true,
          anonymousConfigured: Boolean(envValue('AWS_PROFILE')),
          anonymousDetail: 'The AWS credential provider chain can satisfy Bedrock auth without storing an API key in GoodVibes.',
        };
      },
      streamProtocol: 'anthropic-sdk-stream',
      notes: family.notes,
    });
    this.modelsCachePath = modelsCachePath;
    this.bearerToken = bearerToken;
    this.listingNote = family.listingNote;
  }

  isConfigured(): boolean {
    return hasAwsCredentials(this.bearerToken);
  }

  protected override wireModelId(model: string): string {
    return this.invocableIds.get(model) ?? model;
  }

  /** Adopt listed ids: shown by catalog name, sent as the best-ranked listed id. */
  private adopt(listed: readonly string[]): string[] {
    const region = readAwsCredentials(this.bearerToken).region;
    this.invocableIds.clear();
    const names: string[] = [];
    for (const id of listed) {
      const name = bedrockModelName(id);
      if (!names.includes(name)) names.push(name);
      if (name === id) continue;
      const current = this.invocableIds.get(name);
      if (current === undefined || invocationRank(id, region) < invocationRank(current, region)) this.invocableIds.set(name, id);
    }
    return names;
  }

  /**
   * Re-check the account's model list. Called at boot (background, respects
   * the on-disk TTL cache) and on demand (`force: true`). Always resolves:
   * falls back to the on-disk cache, then to the dated-static list, and
   * reports the reason when live discovery fails.
   */
  async refreshModels(force = false): Promise<LiveModelDiscoveryResult> {
    const previous = [...this.models];
    const result = await runLiveModelRefresh({
      providerName: this.name,
      cachePath: this.modelsCachePath,
      datedStaticModels: BEDROCK_DATED_STATIC_MODELS,
      datedStaticAsOf: BEDROCK_DATED_STATIC_MODELS_AS_OF,
      isConfigured: this.isConfigured(),
      fetchLive: () => fetchBedrockModelIds({ bearerToken: this.bearerToken }),
      force,
    });
    const models = this.adopt(result.models);
    this.models.length = 0;
    this.models.push(...models);
    const { added, removed } = diffModelIds(previous, models);
    return {
      ...result,
      models,
      added,
      removed,
      ...(this.listingNote && result.source !== 'dated-static' ? { note: this.listingNote } : {}),
    };
  }
}

export class AmazonBedrockProvider extends BedrockFamilyProvider {
  constructor(modelsCachePath?: string, options: { readonly bearerToken?: string | undefined } = {}) {
    super({
      name: 'amazon-bedrock',
      buildClient: async (credentials) => {
        const { AnthropicBedrock } = await loadBedrockLibrary();
        const base = {
          ...(credentials.bearerToken ? { apiKey: credentials.bearerToken } : {}),
          awsRegion: credentials.region,
        };
        const pair = credentials.accessKey;
        return pair
          ? new AnthropicBedrock({ ...base, awsAccessKey: pair.id, awsSecretKey: pair.secret, ...(pair.sessionToken ? { awsSessionToken: pair.sessionToken } : {}) })
          : new AnthropicBedrock(base);
      },
      notes: ['Claude-on-Bedrock models are exposed through the Anthropic Bedrock SDK.'],
    }, modelsCachePath, options);
  }
}
