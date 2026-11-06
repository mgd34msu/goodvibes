import type { GoodVibesConfig, SecretRecord, SecretStorageReview } from '@goodvibes-jev/engine/sdk/platform/config';
import type { LocalAuthSnapshot } from '@goodvibes-jev/engine/sdk/platform/security';
import type { SubscriptionAccessQuery } from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
export type OnboardingNetworkMode = 'local-network-default' | 'custom';
export type OnboardingAcknowledgementReason =
  | 'not-needed'
  | 'configured-routing'
  | 'customized-config'
  | 'subscription-state'
  | 'pending-login'
  | 'auth-state'
  | 'bootstrap-credential'
  | 'active-sessions';
export interface OnboardingProviderRoutingSnapshot {
  readonly primaryProviderId: string;
  readonly primaryModelId: string;
  readonly primaryReasoningEffort: GoodVibesConfig['provider']['reasoningEffort'];
  readonly embeddingProviderId: string;
  readonly systemPromptFile: string;
  readonly helperEnabled: boolean;
  readonly helperProviderId: string;
  readonly helperModelId: string;
  readonly toolLlmEnabled: boolean;
  readonly toolProviderId: string;
  readonly toolModelId: string;
}
export interface OnboardingServiceState {
  readonly name: string;
  readonly providerId: string;
  readonly baseUrl: string | null;
  readonly authType: 'bearer' | 'basic' | 'api-key' | 'oauth';
  readonly tokenKey: string;
  readonly oauthConfigured: boolean;
  readonly hasPrimaryCredential: boolean;
  readonly hasPasswordCredential: boolean;
  readonly hasWebhookUrl: boolean;
  readonly hasSigningSecret: boolean;
  readonly hasPublicKey: boolean;
  readonly hasAppToken: boolean;
}
export interface OnboardingServicesSnapshot {
  readonly total: number;
  readonly oauthProviderIds: readonly string[];
  readonly services: readonly OnboardingServiceState[];
}
export interface OnboardingSubscriptionsSnapshot {
  readonly active: ReturnType<SubscriptionAccessQuery['list']>;
  readonly pending: ReturnType<SubscriptionAccessQuery['listPending']>;
  readonly activeProviderIds: readonly string[];
  readonly pendingProviderIds: readonly string[];
}
export interface OnboardingSecretsSnapshot {
  readonly review: SecretStorageReview;
  readonly records: readonly SecretRecord[];
}
export interface OnboardingAuthSnapshot {
  readonly snapshot: LocalAuthSnapshot;
}
export interface OnboardingSurfaceRecord {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly state: string;
  readonly capabilities: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}
export interface OnboardingSurfacesSnapshot {
  readonly configuredEnabledKinds: readonly string[];
  readonly records: readonly OnboardingSurfaceRecord[];
}
export interface OnboardingRuntimeDefaultsSnapshot {
  readonly providerReasoningEffort: GoodVibesConfig['provider']['reasoningEffort'];
  readonly permissionsMode: GoodVibesConfig['permissions']['mode'];
  readonly behavior: GoodVibesConfig['behavior'];
  readonly display: GoodVibesConfig['display'];
  readonly secretStoragePolicy: GoodVibesConfig['storage']['secretPolicy'];
}
export interface OnboardingAcknowledgementState {
  readonly required: boolean;
  readonly accepted: boolean;
  readonly reason: OnboardingAcknowledgementReason;
  readonly detail: string;
}
export interface OnboardingReopenEditAcknowledgementState {
  readonly providers: OnboardingAcknowledgementState;
  readonly subscriptions: OnboardingAcknowledgementState;
  readonly auth: OnboardingAcknowledgementState;
}
