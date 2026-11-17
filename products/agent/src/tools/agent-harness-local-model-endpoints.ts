import type { CommandContext } from '../input/command-registry.ts';
import type { LocalModelDetection, LocalModelEndpointSource, LocalModelLastSmoke, LocalModelServerDefaultEndpoint, LocalModelServerEndpoint, LocalModelServerHealthMap, MutableLocalModelServerEndpoint } from './agent-harness-model-routing-types.ts';
import type { ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import { listProviderRegistryProviders, listRegistryModels, modelProviderId, modelRegistryKey, readProviderModels } from './agent-harness-model-catalog.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { extractUrls, localStackFor, modelsUrlFor, normalizeLocalBaseUrl } from './agent-harness-local-model-url.ts';

export type { LocalModelStack } from './agent-harness-local-model-url.ts';
export { cleanUrlCandidate, extractUrls, isPrivateOrLocalHost, isPrivateOrLocalUrl, localStackFor, localStackForProvider, modelsUrlFor, normalizeLocalBaseUrl, parseUrlCandidate } from './agent-harness-local-model-url.ts';

export function localProviderNameFor(providerId: string | null, stack: string | null, fallback: string): string {
  const seed = providerId || stack || fallback;
  const normalized = seed.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'local-openai';
}

export function localProviderAddRoute(providerId: string | null, stack: string | null, baseUrl: string): string {
  const name = localProviderNameFor(providerId, stack, 'local-openai');
  return `agent_harness mode:"run_command" command:"/provider add ${name} ${baseUrl} local --yes" explicitUserRequest:"<the user request, in their own words>"`;
}

export function localEndpointId(baseUrl: string): string {
  return `local-${baseUrl.toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

export function localEndpointInspectRoute(endpointId: string): string {
  return `agent_harness mode:"model_route" modelRouteId:"${endpointId}"`;
}

export function localEndpointSmokeRoute(endpointId?: string): string {
  const target = endpointId ? ` modelRouteId:"${endpointId}"` : '';
  return `models action:"smoke"${target} explicitUserRequest:"<the user request, in their own words>"`;
}

export function localEndpointDiagnostics(endpoint: MutableLocalModelServerEndpoint, providerExists: boolean): NonNullable<LocalModelServerEndpoint['diagnostics']> {
  const stack = endpoint.stack ?? 'OpenAI-compatible';
  return {
    liveProbe: 'not-run',
    successCriteria: [
      'The confirmed smoke command exits 0.',
      'The model-list endpoint returns JSON without credentials in output.',
      'At least one model id is visible before refresh or benchmark.',
    ],
    failureTriage: [
      `If connection is refused, start the ${stack} server and load a model before refreshing Agent models.`,
      'If the endpoint returns 404, verify the base URL path; most OpenAI-compatible servers should use /v1.',
      'If the host is 0.0.0.0 or a LAN address, switch Agent to a trusted client URL such as 127.0.0.1 or the intended private host.',
    ],
    afterSmoke: providerExists
      ? ['Run the refresh route, then run a local benchmark before changing the default route.']
      : ['Add the provider route only after smoke succeeds, then refresh models and run a local benchmark.'],
    policy: 'Diagnostics are read-only criteria and confirmed route hints. Agent probes local model-list endpoints only through models action:"smoke" after recorded effect admission; provider add, refresh, benchmark, and route changes remain separate actions.',
  };
}

/**
 * The last confirmed smoke of each local endpoint in this Agent process, by
 * normalized base URL. A smoke is the one live fact the product has about a
 * local server (reachable, HTTP status, model ids, latency), so it is kept
 * and shown as that endpoint's diagnostics until the next smoke replaces it.
 */
const lastSmokes = new Map<string, LocalModelLastSmoke>();

/** Called by `runLocalModelServerSmoke` for every endpoint it actually probed. */
export function recordLocalModelSmoke(baseUrl: string, smoke: LocalModelLastSmoke): void {
  lastSmokes.set(normalizeLocalBaseUrl(baseUrl) ?? baseUrl, smoke);
}

export function lastLocalModelSmoke(baseUrl: string): LocalModelLastSmoke | undefined {
  return lastSmokes.get(normalizeLocalBaseUrl(baseUrl) ?? baseUrl);
}

export async function localModelServerEndpoints(
  context: CommandContext,
  includeParameters: boolean,
  _options: ModelReadingOptions = {},
): Promise<readonly LocalModelServerEndpoint[]> {
  return collectLocalServerEndpointCandidates(context).map(endpoint => describeLocalServerEndpoint(endpoint, includeParameters));
}

export function localModelServerDefaults(): readonly LocalModelServerDefaultEndpoint[] {
  const defaults = [
    {
      id: 'ollama',
      label: 'Ollama',
      stack: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      startHint: 'Start Ollama, pull a practical model, then refresh models.',
    },
    {
      id: 'lm-studio',
      label: 'LM Studio',
      stack: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      startHint: 'Start the LM Studio local server and load one model.',
    },
    {
      id: 'llama-cpp',
      label: 'llama.cpp',
      stack: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      startHint: 'Run llama-server with a GGUF model before adding the provider.',
    },
    {
      id: 'vllm',
      label: 'vLLM',
      stack: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      startHint: 'Start the vLLM OpenAI-compatible API server after GPU/driver checks.',
    },
  ] as const;
  return defaults.map((entry) => ({
    ...entry,
    modelsUrl: modelsUrlFor(entry.baseUrl),
    smokeCommand: `curl -fsS ${modelsUrlFor(entry.baseUrl)}`,
    addProviderRoute: localProviderAddRoute(null, entry.stack, entry.baseUrl),
  }));
}

const LOCAL_MODEL_ENV_HINTS = [
  { key: 'OLLAMA_BASE_URL', stack: 'ollama', note: 'Environment override for the Ollama base URL.' },
  { key: 'OLLAMA_HOST', stack: 'ollama', note: 'Environment override for the Ollama host.' },
  { key: 'LM_STUDIO_BASE_URL', stack: 'openai-compatible', note: 'Environment override for LM Studio.' },
  { key: 'OPENAI_COMPATIBLE_BASE_URL', stack: 'openai-compatible', note: 'Environment override for a local OpenAI-compatible server.' },
  { key: 'OPENAI_COMPAT_BASE_URL', stack: 'openai-compatible', note: 'Environment override for a local OpenAI-compatible server.' },
  { key: 'VLLM_BASE_URL', stack: 'vllm', note: 'Environment override for vLLM.' },
  { key: 'LLAMA_CPP_BASE_URL', stack: 'llama.cpp', note: 'Environment override for llama.cpp.' },
  { key: 'LITELLM_BASE_URL', stack: 'openai-compatible', note: 'Environment override for LiteLLM or a local gateway.' },
] as const;

/** What one registry pass found: the local endpoints and which providers, routes and stacks they serve. */
export interface LocalModelRegistryReading {
  readonly detection: LocalModelDetection;
  readonly endpoints: readonly MutableLocalModelServerEndpoint[];
}

/**
 * One synchronous pass over the provider registry, the model registry and the
 * environment hints. A provider or model is local when one of its endpoint URLs
 * is loopback or private; its stack is decided in code (`localStackFor`), and
 * a model inherits its provider's answer. No model is asked.
 */
export function readLocalModelRegistry(context: CommandContext): LocalModelRegistryReading {
  const endpoints = new Map<string, MutableLocalModelServerEndpoint>();
  const providerIds = new Set<string>(), modelRoutes = new Set<string>(), stacks = new Set<string>();
  const localProviders = new Set<string>();
  for (const provider of listProviderRegistryProviders(context)) {
    const record = readRecord(provider);
    const providerId = readString(record.name) || readString(record.id) || readString(record.providerId) || readString(record.provider);
    const routes = readProviderModels(record.models, providerId);
    for (const baseUrl of providerEndpointUrls(record)) {
      const stack = localStackFor(baseUrl, providerId);
      if (!stack) continue;
      if (providerId) { providerIds.add(providerId); localProviders.add(providerId); }
      stacks.add(stack);
      addLocalServerEndpoint(endpoints, { baseUrl, providerId: providerId || null, stack,
        source: 'provider-registry', sourceDetail: providerId ? `provider:${providerId}` : 'provider-registry',
        modelRoutes: routes, notes: providerId ? ['Provider already exists in the registry.'] : [] });
    }
  }
  for (const model of listRegistryModels(context)) {
    const record = readRecord(model), providerId = modelProviderId(model), registryKey = modelRegistryKey(model);
    if (providerId && localProviders.has(providerId) && registryKey) modelRoutes.add(registryKey);
    for (const baseUrl of modelEndpointUrls(record)) {
      const stack = localStackFor(baseUrl, providerId);
      if (!stack) continue;
      if (providerId) providerIds.add(providerId);
      if (registryKey) modelRoutes.add(registryKey);
      stacks.add(stack);
      addLocalServerEndpoint(endpoints, { baseUrl, providerId: providerId || null, stack,
        source: 'model-registry', sourceDetail: registryKey ? `model:${registryKey}` : 'model-registry', modelRoutes: registryKey ? [registryKey] : [],
        notes: registryKey ? ['At least one model route is already registered for this endpoint.'] : [] });
    }
  }
  for (const hint of LOCAL_MODEL_ENV_HINTS) {
    const value = readString(process.env[hint.key]);
    if (value) addLocalServerEndpoint(endpoints, { baseUrl: value, stack: hint.stack, source: 'environment', sourceDetail: `env:${hint.key}`, notes: [hint.note] });
  }
  return {
    detection: { providerIds: [...providerIds].sort(), modelRoutes: [...modelRoutes].sort(), stacks: [...stacks].sort() },
    endpoints: [...endpoints.values()].sort((left, right) => left.baseUrl.localeCompare(right.baseUrl)),
  };
}

export function localModelDetection(context: CommandContext): LocalModelDetection {
  return readLocalModelRegistry(context).detection;
}

/** The registry reading handed to a caller that feeds detection and endpoint views from the same pass. */
export async function withLocalModelRegistry<T>(context: CommandContext, _options: ModelReadingOptions, consume: (reading: LocalModelRegistryReading) => Promise<T>): Promise<T> {
  return consume(readLocalModelRegistry(context));
}

export async function readLocalModelDetection(context: CommandContext, _options: ModelReadingOptions): Promise<LocalModelDetection> {
  return localModelDetection(context);
}
export async function readLocalServerEndpointCandidates(context: CommandContext, _options: ModelReadingOptions): Promise<readonly MutableLocalModelServerEndpoint[]> {
  return collectLocalServerEndpointCandidates(context);
}

/** Every URL a provider record names, from its endpoint fields or anywhere in its body. */
function providerEndpointUrls(record: Record<string, unknown>): readonly string[] {
  return [readString(record.baseURL), readString(record.baseUrl), readString(record.endpoint), ...extractUrls(JSON.stringify(record))].filter(Boolean);
}

function modelEndpointUrls(record: Record<string, unknown>): readonly string[] {
  return [readString(record.baseURL), readString(record.baseUrl), readString(record.endpoint), ...extractUrls(readString(record.description))].filter(Boolean);
}

export function addLocalServerEndpoint(
  endpoints: Map<string, MutableLocalModelServerEndpoint>,
  input: {
    readonly baseUrl: string;
    readonly providerId?: string | null;
    readonly stack?: string | null;
    readonly source: LocalModelEndpointSource;
    readonly sourceDetail: string;
    readonly modelRoutes?: readonly string[];
    readonly notes?: readonly string[];
  },
): void {
  const normalized = normalizeLocalBaseUrl(input.baseUrl, input.stack);
  if (!normalized) return;
  const stack = input.stack ?? null;
  const existing = endpoints.get(normalized);
  if (existing) {
    if (!existing.providerId && input.providerId) existing.providerId = input.providerId;
    if (!existing.stack && stack) existing.stack = stack;
    existing.sources.add(input.source);
    existing.sourceDetails.add(input.sourceDetail);
    for (const route of input.modelRoutes ?? []) existing.modelRoutes.add(route);
    for (const note of input.notes ?? []) existing.notes.add(note);
    return;
  }
  endpoints.set(normalized, {
    providerId: input.providerId ?? null,
    stack,
    baseUrl: normalized,
    sources: new Set([input.source]),
    sourceDetails: new Set([input.sourceDetail]),
    modelRoutes: new Set(input.modelRoutes ?? []),
    notes: new Set(input.notes ?? []),
  });
}

export function collectLocalServerEndpointCandidates(context: CommandContext): readonly MutableLocalModelServerEndpoint[] {
  return readLocalModelRegistry(context).endpoints;
}

export function describeLocalServerEndpoint(
  endpoint: MutableLocalModelServerEndpoint,
  includeParameters = false,
): LocalModelServerEndpoint {
  const modelsUrl = modelsUrlFor(endpoint.baseUrl);
  const providerExists = Boolean(endpoint.providerId) || endpoint.modelRoutes.size > 0;
  const notes = new Set(endpoint.notes);
  if (endpoint.baseUrl.includes('0.0.0.0')) {
    notes.add('0.0.0.0 is usually a listen address; prefer 127.0.0.1 or a trusted LAN host for the client provider URL.');
  }
  if (!providerExists) {
    notes.add('No registered model route was found for this endpoint yet.');
  }
  const id = localEndpointId(endpoint.baseUrl);
  const lastSmoke = lastLocalModelSmoke(endpoint.baseUrl);
  return {
    kind: 'local-server-endpoint',
    id,
    providerId: endpoint.providerId,
    stack: endpoint.stack,
    baseUrl: endpoint.baseUrl,
    modelsUrl,
    diagnosticStatus: providerExists ? 'registered-route-needs-smoke' : 'needs-provider-after-smoke',
    inspectRoute: localEndpointInspectRoute(id),
    sources: [...endpoint.sources].sort((a, b) => a.localeCompare(b)),
    sourceDetails: [...endpoint.sourceDetails].sort((a, b) => a.localeCompare(b)),
    modelRoutes: [...endpoint.modelRoutes].sort((a, b) => a.localeCompare(b)),
    smokeCommand: `curl -fsS ${modelsUrl}`,
    smokeRoute: localEndpointSmokeRoute(id),
    refreshRoute: 'agent_harness mode:"run_command" command:"/refresh-models" explicitUserRequest:"<the user request, in their own words>"',
    addProviderRoute: providerExists ? null : localProviderAddRoute(endpoint.providerId, endpoint.stack, endpoint.baseUrl),
    notes: [...notes],
    ...(lastSmoke ? { lastSmoke } : {}),
    ...(includeParameters ? { diagnostics: localEndpointDiagnostics(endpoint, providerExists) } : {}),
  };
}

export async function localModelServerHealthMap(
  context: CommandContext,
  includeParameters: boolean,
  _options: ModelReadingOptions = {},
  registryReading?: LocalModelRegistryReading,
): Promise<LocalModelServerHealthMap> {
  const endpoints = (registryReading ?? readLocalModelRegistry(context)).endpoints;
  return localModelEndpointFacts(endpoints.map(endpoint => describeLocalServerEndpoint(endpoint, includeParameters)), includeParameters);
}

/** The local endpoint map: registry and environment facts plus each endpoint's last confirmed smoke. */
export function localModelServerFacts(context: CommandContext, includeParameters: boolean): LocalModelServerHealthMap {
  return localModelEndpointFacts(collectLocalServerEndpointCandidates(context)
    .map(endpoint => describeLocalServerEndpoint(endpoint, includeParameters)), includeParameters);
}

function localModelEndpointFacts(endpoints: readonly LocalModelServerEndpoint[], includeParameters: boolean): LocalModelServerHealthMap {
  const returned = endpoints.slice(0, includeParameters ? 8 : 3);
  const suggestedDefaults = localModelServerDefaults().slice(0, includeParameters ? 4 : 2);
  const first = returned[0];
  const smoked = endpoints.filter(endpoint => endpoint.lastSmoke);
  return {
    status: endpoints.length > 0 ? 'candidate-endpoints' : 'no-local-endpoints',
    liveProbe: 'not-run',
    endpointCount: endpoints.length,
    returnedEndpoints: returned.length,
    endpoints: returned,
    suggestedDefaults,
    nextActions: endpoints.length > 0
      ? [
        smoked.length > 0
          ? `Last smoke: ${smoked.map(endpoint => `${endpoint.modelsUrl} ${endpoint.lastSmoke?.status} at ${endpoint.lastSmoke?.checkedAt}`).slice(0, 3).join('; ')}. Smoke again before benchmark or route changes if the server may have changed.`
          : `Smoke test ${first?.modelsUrl ?? 'the detected model-list endpoint'} before benchmark or route changes.`,
        'Refresh the model catalog after the local server is running and reachable.',
        'Run the local benchmark comparison before making a local route the default.',
      ]
      : [
        'Start one local server from suggestedDefaults, then smoke test its model-list endpoint.',
        'Add or select the provider route only after the server is reachable.',
        'Refresh models and run the local benchmark before changing the default route.',
      ],
    policy: 'Read-only local endpoint facts from registry and environment metadata, with the last confirmed smoke of each endpoint in this session. Probes, installs, downloads, provider edits, refresh, benchmarks, and route changes remain confirmed actions.',
  };
}
