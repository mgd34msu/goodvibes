import type { GoodVibesConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import type { LocalAuthSnapshot } from '@goodvibes-jev/engine/sdk/platform/security';
import type { createOnboardingStateStorage } from './onboarding-state.js';
import type { OnboardingAcknowledgementSnapshot, OnboardingShellPaths, OnboardingStateScope } from './onboarding-state-types.js';
export function sortUnique(values: readonly string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
export function buildProviderRoutingSnapshot(config: Pick<GoodVibesConfig, 'provider' | 'helper'> & { readonly tools: Pick<GoodVibesConfig['tools'], 'llmEnabled' | 'llmProvider' | 'llmModel'> }, getProviderIdFromModel: (model: string) => string) {
    return {
        primaryProviderId: getProviderIdFromModel(config.provider.model),
        primaryModelId: config.provider.model,
        primaryReasoningEffort: config.provider.reasoningEffort,
        embeddingProviderId: config.provider.embeddingProvider,
        systemPromptFile: config.provider.systemPromptFile,
        helperEnabled: config.helper.enabled,
        helperProviderId: config.helper.globalProvider,
        helperModelId: config.helper.globalModel,
        toolLlmEnabled: config.tools.llmEnabled,
        toolProviderId: config.tools.llmProvider,
        toolModelId: config.tools.llmModel,
    };
}
export function buildRuntimeDefaultsSnapshot(config: Pick<GoodVibesConfig, 'provider' | 'permissions' | 'behavior' | 'display' | 'storage'>) {
    return {
        providerReasoningEffort: config.provider.reasoningEffort,
        permissionsMode: config.permissions.mode,
        behavior: config.behavior,
        display: config.display,
        secretStoragePolicy: config.storage.secretPolicy,
    };
}
export function buildConfiguredSurfaceKinds(surfaces: object): string[] {
    const enabledKinds: string[] = [];
    for (const [kind, value] of Object.entries(surfaces) as [
        string,
        unknown
    ][]) {
        if (!value || typeof value !== 'object')
            continue;
        if ('enabled' in value && value.enabled === true)
            enabledKinds.push(kind);
    }
    return enabledKinds.sort((left, right) => left.localeCompare(right));
}
export function sortSurfaceRecords<Row extends {
    readonly kind: string;
    readonly label: string;
    readonly id: string;
}>(records: readonly Row[]): Row[] {
    return [...records].sort((left, right) => {
        const kindOrder = left.kind.localeCompare(right.kind);
        if (kindOrder !== 0)
            return kindOrder;
        const labelOrder = left.label.localeCompare(right.label);
        if (labelOrder !== 0)
            return labelOrder;
        return left.id.localeCompare(right.id);
    });
}
export function buildFallbackAuthSnapshot(): LocalAuthSnapshot {
    return {
        userStorePath: '',
        bootstrapCredentialPath: '',
        persisted: false,
        bootstrapCredentialPresent: false,
        userCount: 0,
        sessionCount: 0,
        users: [],
        sessions: [],
    };
}
export function buildAcknowledgementSnapshot(deps: {
    readonly shellPaths?: OnboardingShellPaths | undefined;
    readonly acknowledgementScope?: OnboardingStateScope | undefined;
}, readOnboardingRuntimeState: ReturnType<typeof createOnboardingStateStorage>['readOnboardingRuntimeState']): {
    snapshot: OnboardingAcknowledgementSnapshot;
    issue: {
        readonly area: 'acknowledgements';
        readonly message: string;
    } | null;
} {
    const scope = deps.acknowledgementScope ?? 'project';
    if (!deps.shellPaths) {
        return {
            snapshot: {
                scope,
                exists: false,
                updatedAt: null,
                source: null,
                accepted: {},
            },
            issue: null,
        };
    }
    const state = readOnboardingRuntimeState(deps.shellPaths, scope);
    if (state.parseError) {
        return {
            snapshot: {
                scope,
                exists: true,
                updatedAt: null,
                source: null,
                accepted: {},
            },
            issue: {
                area: 'acknowledgements',
                message: state.parseError,
            },
        };
    }
    return {
        snapshot: {
            scope,
            exists: state.exists,
            updatedAt: state.payload?.updatedAt ?? null,
            source: state.payload?.source ?? null,
            ...(state.payload?.mode ? { mode: state.payload.mode } : {}),
            ...(state.payload?.workspaceRoot ? { workspaceRoot: state.payload.workspaceRoot } : {}),
            accepted: state.payload?.acknowledgements ?? {},
        },
        issue: null,
    };
}
