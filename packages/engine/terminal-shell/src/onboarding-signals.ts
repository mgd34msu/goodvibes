import { DEFAULT_CONFIG, type GoodVibesConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import { getProviderIdFromModel } from '@goodvibes-jev/engine/sdk/platform/providers';
import { isDeepEqual } from './onboarding-values.js';
import type {
  OnboardingAcknowledgementState,
  OnboardingProviderRoutingSnapshot,
  OnboardingServicesSnapshot,
  OnboardingSubscriptionsSnapshot,
  OnboardingSecretsSnapshot,
  OnboardingSurfacesSnapshot,
} from './onboarding-data-types.js';
import type { OnboardingAcknowledgementSnapshot, OnboardingAcknowledgementTarget } from './onboarding-state-types.js';
export interface OnboardingSignalSnapshot {
  readonly config: Pick<GoodVibesConfig, 'permissions' | 'surfaces' | 'behavior' | 'display'>;
  readonly providerRouting: OnboardingProviderRoutingSnapshot;
  readonly services: OnboardingServicesSnapshot;
  readonly subscriptions: OnboardingSubscriptionsSnapshot;
  readonly secrets: OnboardingSecretsSnapshot;
  readonly surfaces: OnboardingSurfacesSnapshot;
  readonly providerAccounts: {
    readonly providers: readonly {
      readonly providerId: string;
      readonly activeRoute: string;
      readonly pendingLogin: boolean;
      readonly oauthReady: boolean;
    }[];
  } | null;
  readonly acknowledgements: OnboardingAcknowledgementSnapshot;
}
const PROVIDER_SECRET_ENV_ALIASES = {
  openai: ['OPENAI_API_KEY', 'OPENAI_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
  inceptionlabs: ['INCEPTION_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  aihubmix: ['AIHUBMIX_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  'ollama-cloud': ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
  huggingface: ['HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN'],
  nvidia: ['NVIDIA_API_KEY'],
  llm7: ['LLM7_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  'microsoft-foundry': ['AZURE_OPENAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  qianfan: ['QIANFAN_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'],
  sglang: ['SGLANG_API_KEY'],
  stepfun: ['STEPFUN_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  venice: ['VENICE_API_KEY'],
  volcengine: ['VOLCANO_ENGINE_API_KEY'],
  xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_AI_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_AI_GATEWAY_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  litellm: ['LITELLM_API_KEY'],
  'copilot-proxy': ['COPILOT_PROXY_API_KEY'],
} as const satisfies Record<string, readonly string[]>;
const SECRET_KEY_TO_PROVIDER_IDS = new Map<string, readonly string[]>(
  Object.entries(PROVIDER_SECRET_ENV_ALIASES).flatMap(([providerId, aliases]) => aliases.map((alias) => [alias, [providerId] as const])),
);
const INBOUND_EVENT_SURFACE_KINDS = new Set<string>([
  'bluebubbles',
  'discord',
  'google-chat',
  'googleChat',
  'homeassistant',
  'imessage',
  'mattermost',
  'matrix',
  'msteams',
  'ntfy',
  'signal',
  'slack',
  'telegram',
  'webhook',
  'whatsapp',
]);
export function countPermissionToolOverrides(snapshot: OnboardingSignalSnapshot): number {
  return Object.entries(snapshot.config.permissions.tools).filter(([key, value]) => {
    if (value === undefined) return false;
    return value !== DEFAULT_CONFIG.permissions.tools[key as keyof typeof DEFAULT_CONFIG.permissions.tools];
  }).length;
}
export function hasCustomizedProviderRouting(snapshot: OnboardingSignalSnapshot): boolean {
  return (
    snapshot.providerRouting.primaryProviderId !== getProviderIdFromModel(DEFAULT_CONFIG.provider.model) ||
    snapshot.providerRouting.primaryModelId !== DEFAULT_CONFIG.provider.model ||
    snapshot.providerRouting.primaryReasoningEffort !== DEFAULT_CONFIG.provider.reasoningEffort ||
    snapshot.providerRouting.embeddingProviderId !== DEFAULT_CONFIG.provider.embeddingProvider ||
    snapshot.providerRouting.systemPromptFile.trim() !== DEFAULT_CONFIG.provider.systemPromptFile.trim() ||
    snapshot.providerRouting.helperEnabled !== DEFAULT_CONFIG.helper.enabled ||
    snapshot.providerRouting.helperProviderId !== DEFAULT_CONFIG.helper.globalProvider ||
    snapshot.providerRouting.helperModelId !== DEFAULT_CONFIG.helper.globalModel ||
    snapshot.providerRouting.toolLlmEnabled !== DEFAULT_CONFIG.tools.llmEnabled ||
    snapshot.providerRouting.toolProviderId !== DEFAULT_CONFIG.tools.llmProvider ||
    snapshot.providerRouting.toolModelId !== DEFAULT_CONFIG.tools.llmModel
  );
}
export function getProviderAccountSignalIds(snapshot: OnboardingSignalSnapshot): string[] {
  return (snapshot.providerAccounts?.providers ?? [])
    .filter((provider) => provider.activeRoute !== 'unconfigured' || provider.pendingLogin || provider.oauthReady)
    .map((provider) => provider.providerId);
}
export function getServiceCredentialProviderIds(snapshot: OnboardingSignalSnapshot): string[] {
  return snapshot.services.services
    .filter((service) => service.hasPrimaryCredential || service.hasPasswordCredential)
    .map((service) => service.providerId);
}
export function getSecretBackedProviderIds(snapshot: OnboardingSignalSnapshot): string[] {
  const providerIds = new Set<string>();
  for (const record of snapshot.secrets.records) {
    const matches = SECRET_KEY_TO_PROVIDER_IDS.get(record.key);
    if (!matches) continue;
    for (const providerId of matches) providerIds.add(providerId);
  }
  return [...providerIds].sort((left, right) => left.localeCompare(right));
}
export function getConfiguredProviderSignalIds(snapshot: OnboardingSignalSnapshot): string[] {
  return [
    ...new Set<string>([
      ...getProviderAccountSignalIds(snapshot),
      ...snapshot.services.oauthProviderIds,
      ...getServiceCredentialProviderIds(snapshot),
      ...snapshot.subscriptions.activeProviderIds,
      ...snapshot.subscriptions.pendingProviderIds,
      ...getSecretBackedProviderIds(snapshot),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}
export function hasConfiguredProviderState(snapshot: OnboardingSignalSnapshot): boolean {
  return getConfiguredProviderSignalIds(snapshot).length > 0;
}
export function getConfiguredSurfaceKinds(snapshot: OnboardingSignalSnapshot): string[] {
  const kinds = new Set<string>([
    ...snapshot.surfaces.configuredEnabledKinds,
    ...snapshot.surfaces.records.filter((surface) => surface.enabled).map((surface) => surface.kind),
  ]);
  for (const [kind, value] of Object.entries(snapshot.config.surfaces)) {
    if (!value || typeof value !== 'object') continue;
    const defaults = DEFAULT_CONFIG.surfaces[kind as keyof typeof DEFAULT_CONFIG.surfaces];
    if (!defaults || typeof defaults !== 'object') continue;
    if (!isDeepEqual(value, defaults)) kinds.add(kind);
  }
  return [...kinds].sort((left, right) => left.localeCompare(right));
}
export function countConfiguredSurfaceKinds(snapshot: OnboardingSignalSnapshot): number {
  return getConfiguredSurfaceKinds(snapshot).length;
}
export function hasInboundEventSurface(snapshot: OnboardingSignalSnapshot): boolean {
  return (
    snapshot.surfaces.configuredEnabledKinds.some((kind) => INBOUND_EVENT_SURFACE_KINDS.has(kind)) ||
    snapshot.surfaces.records.some((surface) => surface.enabled && INBOUND_EVENT_SURFACE_KINDS.has(surface.kind))
  );
}
export function hasCustomizedWorkspaceDefaults(snapshot: OnboardingSignalSnapshot): boolean {
  return !isDeepEqual(snapshot.config.behavior, DEFAULT_CONFIG.behavior) || !isDeepEqual(snapshot.config.display, DEFAULT_CONFIG.display);
}
export function getProviderIdentityIds(snapshot: OnboardingSignalSnapshot): Set<string> {
  return new Set<string>(
    [
      ...Object.keys(PROVIDER_SECRET_ENV_ALIASES),
      ...getConfiguredProviderSignalIds(snapshot),
      snapshot.providerRouting.primaryProviderId,
      snapshot.providerRouting.embeddingProviderId,
      snapshot.providerRouting.helperProviderId,
      snapshot.providerRouting.toolProviderId,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
  );
}
export function getExternalIntegrationServiceIds(snapshot: OnboardingSignalSnapshot): string[] {
  const providerIdentityIds = getProviderIdentityIds(snapshot);
  return snapshot.services.services
    .filter((service) => !providerIdentityIds.has(service.providerId) && !providerIdentityIds.has(service.name))
    .map((service) => service.name);
}
export function hasExternalIntegrations(snapshot: OnboardingSignalSnapshot): boolean {
  return getExternalIntegrationServiceIds(snapshot).length > 0 || countConfiguredSurfaceKinds(snapshot) > 0;
}
export function getAcknowledgementAccepted(snapshot: OnboardingSignalSnapshot, target: OnboardingAcknowledgementTarget): boolean {
  return snapshot.acknowledgements.accepted[target] === true;
}
export function buildNotNeededAcknowledgement(
  snapshot: OnboardingSignalSnapshot,
  target: OnboardingAcknowledgementTarget,
  detail: string,
): OnboardingAcknowledgementState {
  return {
    required: false,
    accepted: getAcknowledgementAccepted(snapshot, target),
    reason: 'not-needed',
    detail,
  };
}
export function buildRequiredAcknowledgement(
  snapshot: OnboardingSignalSnapshot,
  target: OnboardingAcknowledgementTarget,
  reason: Exclude<OnboardingAcknowledgementState['reason'], 'not-needed'>,
  detail: string,
): OnboardingAcknowledgementState {
  return {
    required: true,
    accepted: getAcknowledgementAccepted(snapshot, target),
    reason,
    detail,
  };
}
