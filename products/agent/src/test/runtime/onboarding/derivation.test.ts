import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../../../config/index.ts';
import { getProviderIdFromModel } from '../../../config/provider-model.ts';
import { EMPTY_AGENT_BEHAVIOR_DISCOVERY_SNAPSHOT } from '../../../agent/behavior-discovery-summary.ts';
import type { OnboardingSnapshotState } from '../../../runtime/onboarding/index.ts';
import {
  deriveStep1Capabilities,
  deriveStep1CapabilityFlags,
} from '../../../runtime/onboarding/index.ts';

function buildBaseSnapshot(): OnboardingSnapshotState {
  return {
    capturedAt: 0,
    config: {
      display: structuredClone(DEFAULT_CONFIG.display),
      provider: structuredClone(DEFAULT_CONFIG.provider),
      behavior: structuredClone(DEFAULT_CONFIG.behavior),
      storage: structuredClone(DEFAULT_CONFIG.storage),
      permissions: structuredClone(DEFAULT_CONFIG.permissions),
      helper: structuredClone(DEFAULT_CONFIG.helper),
      tools: {
        llmEnabled: DEFAULT_CONFIG.tools.llmEnabled,
        llmProvider: DEFAULT_CONFIG.tools.llmProvider,
        llmModel: DEFAULT_CONFIG.tools.llmModel,
      },
      surfaces: structuredClone(DEFAULT_CONFIG.surfaces),
    },
    providerRouting: {
      primaryProviderId: getProviderIdFromModel(DEFAULT_CONFIG.provider.model),
      primaryModelId: DEFAULT_CONFIG.provider.model,
      primaryReasoningEffort: DEFAULT_CONFIG.provider.reasoningEffort,
      embeddingProviderId: DEFAULT_CONFIG.provider.embeddingProvider,
      systemPromptFile: DEFAULT_CONFIG.provider.systemPromptFile,
      helperEnabled: DEFAULT_CONFIG.helper.enabled,
      helperProviderId: DEFAULT_CONFIG.helper.globalProvider,
      helperModelId: DEFAULT_CONFIG.helper.globalModel,
      toolLlmEnabled: DEFAULT_CONFIG.tools.llmEnabled,
      toolProviderId: DEFAULT_CONFIG.tools.llmProvider,
      toolModelId: DEFAULT_CONFIG.tools.llmModel,
    },
    runtimeDefaults: {
      providerReasoningEffort: DEFAULT_CONFIG.provider.reasoningEffort,
      permissionsMode: DEFAULT_CONFIG.permissions.mode,
      behavior: structuredClone(DEFAULT_CONFIG.behavior),
      display: structuredClone(DEFAULT_CONFIG.display),
      secretStoragePolicy: DEFAULT_CONFIG.storage.secretPolicy,
    },
    acknowledgements: {
      scope: 'project',
      exists: false,
      updatedAt: null,
      source: null,
      accepted: {},
    },
    services: {
      total: 0,
      oauthProviderIds: [],
      services: [],
    },
    subscriptions: {
      active: [],
      pending: [],
      activeProviderIds: [],
      pendingProviderIds: [],
    },
    secrets: {
      review: {
        policy: 'preferred_secure',
        secureAvailable: false,
        storedKeys: 0,
        envBackedKeys: 0,
        secureKeys: 0,
        plaintextKeys: 0,
        warnings: [],
        locations: [],
      },
      records: [],
    },
    auth: {
      snapshot: {
        userStorePath: '/tmp/auth-users.json',
        bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
        persisted: true,
        bootstrapCredentialPresent: false,
        userCount: 0,
        sessionCount: 0,
        users: [],
        sessions: [],
      },
    },
    surfaces: {
      configuredEnabledKinds: [],
      records: [],
    },
    providerAccounts: null,
    localBehaviorDiscovery: EMPTY_AGENT_BEHAVIOR_DISCOVERY_SNAPSHOT,
    collectionIssues: [],
  };
}

describe('onboarding derivation helpers', () => {
  test('derives the agreed first-screen capability model from configured onboarding state', () => {
    let snapshot = buildBaseSnapshot();

    snapshot = {
      ...snapshot,
      services: {
        total: 1,
        oauthProviderIds: ['openai'],
        services: [
          {
            name: 'openai',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com',
            authType: 'oauth',
            tokenKey: 'OPENAI_API_KEY',
            oauthConfigured: true,
            hasPrimaryCredential: true,
            hasPasswordCredential: false,
            hasWebhookUrl: false,
            hasSigningSecret: false,
            hasPublicKey: false,
            hasAppToken: false,
          },
        ],
      },
    };
    snapshot = {
      ...snapshot,
      subscriptions: {
        active: [
          {
            provider: 'openai',
            accessToken: 'token',
            tokenType: 'Bearer',
            authMode: 'oauth',
            overrideAmbientApiKeys: true,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        pending: [],
        activeProviderIds: ['openai'],
        pendingProviderIds: [],
      },
      auth: {
        snapshot: {
          ...snapshot.auth.snapshot,
          userCount: 1,
        },
      },
      surfaces: {
        configuredEnabledKinds: ['slack'],
        records: [
          {
            id: 'surface:slack',
            kind: 'slack',
            label: 'Slack',
            enabled: true,
            state: 'healthy',
            capabilities: ['send'],
            metadata: {},
          },
        ],
      },
      providerAccounts: {
        capturedAt: 1,
        configuredCount: 1,
        issueCount: 0,
        providers: [
          {
            providerId: 'openai',
            configured: true,
            active: true,
            oauthReady: true,
            pendingLogin: false,
            availableRoutes: ['subscription'],
            activeRoute: 'subscription',
            authFreshness: 'healthy',
          },
        ],
      },
    };

    // Wording is copy; which capabilities are offered, and which are pre-selected, is the behaviour.
    expect(deriveStep1Capabilities(snapshot).map(({ id, selected }) => ({ id, selected }))).toEqual([
      {
        id: 'operator-terminal',
        selected: true,
      },
      {
        id: 'provider-access',
        selected: true,
      },
      {
        id: 'agent-knowledge',
        selected: true,
      },
      {
        id: 'local-behavior',
        selected: false,
      },
      {
        id: 'communication-channels',
        selected: true,
      },
      {
        id: 'automation-review',
        selected: true,
      },
      {
        id: 'tui-delegation',
        selected: true,
      },
    ]);

    expect(deriveStep1CapabilityFlags(snapshot)).toEqual({
      providerAccess: true,
      subscriptions: true,
      auth: true,
      agentKnowledge: true,
      localBehavior: false,
      communicationChannels: true,
      automationReview: true,
      tuiDelegation: true,
    });
  });

  test('treats discovered local behavior files as day-one setup work', () => {
    const snapshot: OnboardingSnapshotState = {
      ...buildBaseSnapshot(),
      localBehaviorDiscovery: {
        personas: {
          count: 1,
          projectLocalCount: 1,
          globalCount: 0,
          names: ['Research Operator'],
        },
        skills: {
          count: 1,
          projectLocalCount: 1,
          globalCount: 0,
          names: ['Daily Brief Skill'],
        },
        routines: {
          count: 1,
          projectLocalCount: 1,
          globalCount: 0,
          names: ['Evening Review'],
        },
      },
    };
    const localBehavior = deriveStep1Capabilities(snapshot).find((item) => item.id === 'local-behavior');

    expect(localBehavior?.selected).toBe(true);
    expect(localBehavior?.detail).toContain('Import 3 discovered Agent persona/skill/routine file(s)');
    expect(localBehavior?.detail).toContain('Research Operator');
    expect(deriveStep1CapabilityFlags(snapshot).localBehavior).toBe(true);
  });

  test('keeps host posture out of first-run Agent capabilities', () => {
    const snapshot = buildBaseSnapshot();
    const capabilities = deriveStep1Capabilities(snapshot);

    expect(capabilities.map((capability) => capability.id)).not.toContain('network-access');
    expect(capabilities.map((capability) => capability.id)).not.toContain('webhook-events');
    expect(capabilities.find((capability) => capability.id === 'automation-review')?.selected).toBe(false);
    expect(capabilities.find((capability) => capability.id === 'operator-terminal')?.detail).toContain('terminal operator');
    expect(capabilities.find((capability) => capability.id === 'operator-terminal')?.detail).toContain('does not create new entrypoints');
  });

  test('does not surface browser or listener setup as Agent setup items', () => {
    const snapshot = buildBaseSnapshot();

    const rendered = deriveStep1Capabilities(snapshot).map((capability) => `${capability.label}\n${capability.detail}`).join('\n');
    expect(rendered).not.toContain('Browser Access');
    expect(rendered).not.toContain('Other-Device Access');
    expect(rendered).not.toContain('Incoming Events');
    expect(rendered).not.toContain('HTTP listener');
    expect(rendered).not.toContain('control-plane');
  });

  test('derives automation review for every inbound external channel kind', () => {
    const inboundKinds = [
      'bluebubbles',
      'discord',
      'google-chat',
      'googleChat',
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
    ];

    for (const kind of inboundKinds) {
      const snapshot: OnboardingSnapshotState = {
        ...buildBaseSnapshot(),
        surfaces: {
          configuredEnabledKinds: [kind],
          records: [
            {
              id: `surface:${kind}`,
              kind,
              label: kind,
              enabled: true,
              state: 'healthy',
              capabilities: ['receive'],
              metadata: {},
            },
          ],
        },
      };

      expect(deriveStep1Capabilities(snapshot).find((capability) => capability.id === 'automation-review')?.selected).toBe(true);
    }
  });

  test('does not treat provider setup alone as the external integrations capability', () => {
    const snapshot: OnboardingSnapshotState = {
      ...buildBaseSnapshot(),
      services: {
        total: 1,
        oauthProviderIds: ['openai'],
        services: [
          {
            name: 'openai',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com',
            authType: 'oauth',
            tokenKey: 'OPENAI_API_KEY',
            oauthConfigured: true,
            hasPrimaryCredential: true,
            hasPasswordCredential: false,
            hasWebhookUrl: false,
            hasSigningSecret: false,
            hasPublicKey: false,
            hasAppToken: false,
          },
        ],
      },
      subscriptions: {
        active: [
          {
            provider: 'openai',
            accessToken: 'token',
            tokenType: 'Bearer',
            authMode: 'oauth',
            overrideAmbientApiKeys: true,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        pending: [],
        activeProviderIds: ['openai'],
        pendingProviderIds: [],
      },
      providerAccounts: {
        capturedAt: 1,
        configuredCount: 1,
        issueCount: 0,
        providers: [
          {
            providerId: 'openai',
            configured: true,
            active: true,
            oauthReady: true,
            pendingLogin: false,
            availableRoutes: ['subscription'],
            activeRoute: 'subscription',
            authFreshness: 'healthy',
          },
        ],
      },
    };

    // Wording is copy; which capabilities are offered, and which are pre-selected, is the behaviour.
    expect(deriveStep1Capabilities(snapshot).map(({ id, selected }) => ({ id, selected }))).toEqual([
      {
        id: 'operator-terminal',
        selected: true,
      },
      {
        id: 'provider-access',
        selected: true,
      },
      {
        id: 'agent-knowledge',
        selected: true,
      },
      {
        id: 'local-behavior',
        selected: false,
      },
      {
        id: 'communication-channels',
        selected: false,
      },
      {
        id: 'automation-review',
        selected: false,
      },
      {
        id: 'tui-delegation',
        selected: true,
      },
    ]);
  });
});
